import contextlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from test_codex_repair import load_script, IMPORT_SCRIPT, ROOT, SCRIPT

NODE_CLI = ROOT / "bin" / "agent-history-rescue.js"


class AuditRegressions(unittest.TestCase):
    def test_import_failures_are_nonzero_and_keep_successes(self):
        for failure in ('all', 'partial', 'disk'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)/'codex'; home.mkdir()
                with sqlite3.connect(home/'state_5.sqlite') as conn:
                    conn.execute('create table threads (id text primary key, rollout_path text, model_provider text)')
                job = Path(tmp)/'job.json'
                job.write_text(json.dumps({'codexHome': str(home), 'defaultProvider': 'openai', 'cwd': tmp, 'conversations': [{'id': str(i), 'title': 'synthetic', 'messages': [{'role': 'user', 'text': 'hello'}]} for i in range(2)]}))
                module = load_script(IMPORT_SCRIPT, 'import_regression')
                original = module.insert_thread
                calls = []
                def insert(*args):
                    calls.append(1)
                    if failure == 'all' or len(calls) == 1:
                        raise sqlite3.IntegrityError('synthetic failure')
                    return original(*args)
                target = 'write_rollout' if failure == 'disk' else 'insert_thread'
                side_effect = OSError('synthetic disk failure') if failure == 'disk' else insert
                with mock.patch.object(module, target, side_effect=side_effect), mock.patch.object(sys, 'argv', [str(IMPORT_SCRIPT), str(job), '--apply']), contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(module.main(), 1)
                expected = 1 if failure == 'partial' else 0
                with sqlite3.connect(home/'state_5.sqlite') as conn:
                    self.assertEqual(conn.execute('select count(*) from threads').fetchone()[0], expected)
                self.assertEqual(len(list((home/'sessions').rglob('*.jsonl'))), expected)
                self.assertIn('failed', out.getvalue())

    def test_provider_json_whitespace(self):
        module = load_script(SCRIPT, 'repair_regression')
        for separator in (':', ': ', ' : ', '\t:\t', '  :   '):
            with self.subTest(separator=separator), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp); path = home/'sessions/test.jsonl';path.parent.mkdir()
                data = {'payload': {'model_provider': 'old'}, 'type': 'session_meta'}
                line = json.dumps(data, separators=(',', separator))+'\n'
                invalid = json.dumps({'type': 'session_meta', 'payload': {'model_provider': ['invalid']}})
                suffix = invalid + '\n[]\nnull\ninvalid\n'
                path.write_text(line + suffix)
                backup=home/'backup';backup.mkdir()
                self.assertEqual(module.jsonl_provider_counts([path], {'old'}), {'old': 1})
                self.assertEqual(module.patch_jsonl([path], {'old'}, 'new', home, backup), 1)
                self.assertEqual(json.loads(path.read_text().splitlines()[0])['payload']['model_provider'], 'new')
                self.assertTrue(path.read_text().endswith(suffix))
                self.assertEqual(module.jsonl_provider_counts([path], {'new'}), {'new': 1})

    def test_explicit_source_provider_equal_to_target_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads (id text primary key, model_provider text, archived integer)"
                )
                conn.execute("insert into threads values ('t1', 'openai', 0)")
                conn.commit()
            res = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--codex-home",
                    str(home),
                    "--target-provider",
                    "openai",
                    "--source-provider",
                    "openai",
                    "--apply",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertIn("Nothing to repair", res.stdout)
            self.assertFalse((home / "backups").exists())

    def test_node_cli_rejects_missing_option_values_and_traversal_workspace(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "HOME": tmp, "CODEX_HOME": str(Path(tmp) / ".codex"), "NO_COLOR": "1"}
            bad_invocations = [
                ["claude", "--sessions-dir"],
                ["claude", "--restore"],
                ["claude", "--target-workspace"],
                ["claude", "--target-workspace", "../escape"],
                ["claude", "--target-workspace", "a/b"],
                ["codex", "--codex-home"],
                ["codex", "--codex-home", "--dry-run"],
                ["codex", "--target-provider"],
                ["codex", "--source-provider"],
                ["codex", "--restore"],
                ["import", "--to"],
                ["import", "--out"],
                ["import", "--codex-home"],
                ["import", "--codex-provider"],
            ]
            for args in bad_invocations:
                with self.subTest(args=args):
                    res = subprocess.run(
                        [node, str(NODE_CLI), *args],
                        env=env,
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
                    self.assertIn("Error:", res.stderr)

    def test_node_cli_cleans_temp_dir_on_failed_zip_import(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            scratch = tmp_root / "tmp"
            scratch.mkdir()
            bad_zip = tmp_root / "not-a-claude-export.zip"
            with zipfile.ZipFile(bad_zip, "w") as zf:
                zf.writestr("unrelated.txt", "hello")
            env = {
                **os.environ,
                "HOME": str(tmp_root / "home"),
                "TMPDIR": str(scratch),
                "TEMP": str(scratch),
                "TMP": str(scratch),
                "NO_COLOR": "1",
            }
            res = subprocess.run(
                [node, str(NODE_CLI), "import", str(bad_zip)],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("no conversations.json found", res.stderr)
            self.assertEqual(list(scratch.glob("ahr-import-*")), [])

    def test_node_cli_ansi_helper_includes_escape_byte(self):
        source = NODE_CLI.read_text(encoding="utf-8")
        self.assertIn(r"\x1b[${code}m${s}\x1b[0m", source)
        self.assertNotIn("`[${code}m${s}[0m`", source)
