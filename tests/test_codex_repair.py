import contextlib
import importlib.util
import io
import json
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # Python 3.9/3.10: tomli installed in CI
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "repair_codex_history.py"
IMPORT_SCRIPT = ROOT / "scripts" / "import_to_codex.py"


def load_script(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CodexRepairTests(unittest.TestCase):
    def test_import_rolls_back_every_store_when_session_index_write_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, rollout_path text, model_provider text, "
                    "title text, cwd text, created_at integer, "
                    "updated_at integer, has_user_event integer, preview text)"
                )
                conn.execute(
                    "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "current",
                        str(home / "sessions/current.jsonl"),
                        "openai",
                        "Current",
                        "/tmp",
                        1,
                        1,
                        1,
                        "Current",
                    ),
                )

            index_path = home / "session_index.jsonl"
            original_index = b'{"id":"current","model_provider":"openai"}\n'
            index_path.write_bytes(original_index)
            original_db = db_path.read_bytes()

            job = Path(tmp) / "job.json"
            job.write_text(
                json.dumps(
                    {
                        "codexHome": str(home),
                        "defaultProvider": "openai",
                        "cwd": "/tmp/recovered",
                        "conversations": [
                            {
                                "id": "imported-thread",
                                "title": "Imported",
                                "createdAt": "2026-07-14T00:00:00Z",
                                "updatedAt": "2026-07-14T00:01:00Z",
                                "messages": [{"role": "user", "text": "hello"}],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            module = load_script(IMPORT_SCRIPT, "import_to_codex_failure_test")

            def fail_after_partial_index_write(path, _rows):
                path.write_bytes(b"partial-index-write")
                raise OSError("injected session index failure")

            with mock.patch.object(
                module, "append_session_index", side_effect=fail_after_partial_index_write
            ), mock.patch.object(
                sys, "argv", [str(IMPORT_SCRIPT), str(job), "--apply"]
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(OSError, "injected session index failure"):
                    module.main()

            self.assertEqual(db_path.read_bytes(), original_db)
            self.assertEqual(index_path.read_bytes(), original_index)
            self.assertEqual(list((home / "sessions").rglob("*.jsonl")), [])
            self.assertEqual(list(home.rglob(".*.tmp-*")), [])
            self.assertEqual(list(home.rglob("imported-rollouts.txt")), [])

            with sqlite3.connect(db_path) as conn:
                self.assertEqual(
                    conn.execute("select id from threads order by id").fetchall(),
                    [("current",)],
                )

    def test_import_removes_new_rollout_when_writing_it_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, rollout_path text, model_provider text)"
                )

            job = Path(tmp) / "job.json"
            job.write_text(
                json.dumps(
                    {
                        "codexHome": str(home),
                        "defaultProvider": "openai",
                        "conversations": [
                            {
                                "id": "partial-rollout",
                                "title": "Partial",
                                "createdAt": "2026-07-14T00:00:00Z",
                                "messages": [],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            module = load_script(IMPORT_SCRIPT, "import_to_codex_rollout_failure_test")
            with mock.patch.object(
                module.json, "dumps", side_effect=OSError("injected rollout write failure")
            ), mock.patch.object(
                sys, "argv", [str(IMPORT_SCRIPT), str(job), "--apply"]
            ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(), 0)

            self.assertEqual(list((home / "sessions").rglob("*.jsonl")), [])
            self.assertEqual(list(home.rglob(".*.tmp-*")), [])

    def test_repair_rolls_back_every_store_when_sqlite_step_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, model_provider text, archived integer, "
                    "archived_at integer, preview text)"
                )
                conn.execute(
                    "insert into threads values (?, ?, ?, ?, ?)",
                    ("old", "mycodex", 1, 123, "old"),
                )

            config_path = home / "config.toml"
            original_config = (
                'model_provider = "openai"\n\n'
                "[model_providers.openai]\n"
                'name = "openai"\n'
                'base_url = "https://example.invalid/v1"\n'
            ).encode()
            config_path.write_bytes(original_config)

            rollout_path = home / "sessions" / "2026" / "07" / "14" / "rollout-old.jsonl"
            rollout_path.parent.mkdir(parents=True)
            original_rollout = (
                b'{"type":"session_meta","payload":{"id":"old",'
                b'"model_provider":"mycodex"}}\n'
            )
            rollout_path.write_bytes(original_rollout)

            index_path = home / "session_index.jsonl"
            original_index = (
                b'{"id":"old","model_provider":"mycodex","archived":true}\n'
            )
            index_path.write_bytes(original_index)
            original_db = db_path.read_bytes()

            module = load_script(SCRIPT, "repair_codex_history_failure_test")

            def fail_after_sqlite_commit(path, sources, target, _unarchive, _has_archived):
                with sqlite3.connect(path) as conn:
                    placeholders = ",".join("?" for _ in sources)
                    conn.execute(
                        f"update threads set model_provider=? "
                        f"where model_provider in ({placeholders})",
                        [target, *sources],
                    )
                    conn.commit()
                raise OSError("injected sqlite failure")

            argv = [
                str(SCRIPT),
                "--codex-home",
                str(home),
                "--apply",
                "--unarchive",
                "--target-provider",
                "openai",
                "--source-provider",
                "mycodex",
            ]
            with mock.patch.object(
                module, "patch_sqlite", side_effect=fail_after_sqlite_commit
            ), mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(OSError, "injected sqlite failure"):
                    module.main()

            self.assertEqual(db_path.read_bytes(), original_db)
            self.assertEqual(config_path.read_bytes(), original_config)
            self.assertEqual(rollout_path.read_bytes(), original_rollout)
            self.assertEqual(index_path.read_bytes(), original_index)
            self.assertEqual(list(home.rglob(".*.tmp-*")), [])

            with sqlite3.connect(db_path) as conn:
                self.assertEqual(
                    conn.execute(
                        "select model_provider, archived from threads where id='old'"
                    ).fetchone(),
                    ("mycodex", 1),
                )

    def test_apply_keeps_session_index_in_sync_and_backs_it_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, model_provider text, archived integer, "
                    "archived_at integer, preview text)"
                )
                conn.executemany(
                    "insert into threads values (?, ?, ?, ?, ?)",
                    [
                        ("current", "openai", 0, None, "current"),
                        ("old", "mycodex", 1, 123, "old"),
                        ("custom", "custom", 0, None, "custom"),
                    ],
                )

            index_path = home / "session_index.jsonl"
            rows = [
                {"id": "current", "model_provider": "openai", "archived": False},
                {"id": "old", "model_provider": "mycodex", "archived": True},
                {"id": "custom", "model_provider": "custom", "archived": False},
            ]
            original_index = "".join(json.dumps(row) + "\n" for row in rows)
            index_path.write_text(original_index, encoding="utf-8")
            index_path.chmod(0o600)

            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--codex-home",
                    str(home),
                    "--apply",
                    "--unarchive",
                    "--target-provider",
                    "openai",
                    "--source-provider",
                    "mycodex",
                    "--source-provider",
                    "custom",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            repaired_rows = [
                json.loads(line)
                for line in index_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertTrue(all(row["model_provider"] == "openai" for row in repaired_rows))
            self.assertTrue(all(row["archived"] is False for row in repaired_rows))

            backups = list((home / "backups").glob("thread-history-repair-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(
                (backups[0] / "session_index.jsonl").read_text(encoding="utf-8"),
                original_index,
            )

    def test_import_adds_session_index_row_and_backs_up_existing_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, rollout_path text, model_provider text, "
                    "title text, cwd text, created_at integer, "
                    "updated_at integer, has_user_event integer, preview text)"
                )
                conn.execute(
                    "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "current",
                        str(home / "sessions/current.jsonl"),
                        "openai",
                        "Current",
                        "/tmp",
                        1,
                        1,
                        1,
                        "Current",
                    ),
                )

            index_path = home / "session_index.jsonl"
            original_index = json.dumps(
                {
                    "id": "current",
                    "thread_name": "Current",
                    "model_provider": "openai",
                    "archived": False,
                    "rollout_path": str(home / "sessions/current.jsonl"),
                }
            ) + "\n"
            index_path.write_text(original_index, encoding="utf-8")
            index_path.chmod(0o600)

            job = Path(tmp) / "job.json"
            job.write_text(
                json.dumps(
                    {
                        "codexHome": str(home),
                        "defaultProvider": "openai",
                        "cwd": "/tmp/recovered",
                        "conversations": [
                            {
                                "id": "imported-thread",
                                "title": "Imported",
                                "createdAt": "2026-07-14T00:00:00Z",
                                "updatedAt": "2026-07-14T00:01:00Z",
                                "messages": [
                                    {
                                        "role": "user",
                                        "text": "hello",
                                        "timestamp": "2026-07-14T00:00:00Z",
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [sys.executable, str(IMPORT_SCRIPT), str(job), "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            index_rows = [
                json.loads(line)
                for line in index_path.read_text(encoding="utf-8").splitlines()
            ]
            imported = next(row for row in index_rows if row.get("id") == "imported-thread")
            self.assertEqual(imported["thread_name"], "Imported")
            self.assertEqual(imported["model_provider"], "openai")
            self.assertFalse(imported["archived"])
            self.assertTrue(Path(imported["rollout_path"]).exists())
            self.assertEqual(stat.S_IMODE(index_path.stat().st_mode), 0o600)

            backups = list((home / "backups").glob("import-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(
                (backups[0] / "session_index.jsonl").read_text(encoding="utf-8"),
                original_index,
            )




class ConfigAliasTests(unittest.TestCase):
    """Regression tests for config.toml alias writing (audit findings B2/S1)."""

    def setUp(self):
        self.mod = load_script(SCRIPT, "repair_codex_history_alias")

    def _write_alias(self, target_block, source, target="openai"):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        config_path = Path(tmp.name) / "config.toml"
        config_path.write_text('[model_providers.' + target + ']' + chr(10) + 'name = "' + target + '"' + chr(10), encoding="utf-8")
        config = {"model_providers": {target: target_block}}
        changed = self.mod.ensure_config_aliases(
            config_path, config, config_path.read_text(encoding="utf-8"), target, [source]
        )
        return changed, config_path.read_text(encoding="utf-8")

    def test_dict_and_list_fields_stay_toml_typed(self):
        block = {
            "name": None,
            "base_url": "https://api.example.com",
            "query_params": {"api-version": "2024-01"},
            "http_headers": {"X-Custom": "v"},
            "aliases": ["a", "b"],
            "requires_auth": True,
            "priority": 3,
        }
        changed, text = self._write_alias(block, "azure")
        self.assertTrue(changed)
        parsed = tomllib.loads(text)["model_providers"]["azure"]
        self.assertEqual(parsed["query_params"], {"api-version": "2024-01"})
        self.assertEqual(parsed["http_headers"], {"X-Custom": "v"})
        self.assertEqual(parsed["aliases"], ["a", "b"])
        self.assertIs(parsed["requires_auth"], True)
        self.assertEqual(parsed["priority"], 3)
        self.assertEqual(parsed["name"], "azure")

    def test_unsafe_provider_name_is_skipped(self):
        block = {"name": None, "base_url": "https://api.example.com"}
        evil = 'bad"]\n[evil_section'
        changed, text = self._write_alias(block, evil)
        self.assertFalse(changed)
        self.assertNotIn("evil_section", text)

    def test_dotted_provider_name_written_as_quoted_key(self):
        block = {"name": None, "base_url": "https://api.example.com"}
        changed, text = self._write_alias(block, "sub.provider")
        self.assertTrue(changed)
        parsed = tomllib.loads(text)["model_providers"]
        self.assertIn("sub.provider", parsed)
        self.assertEqual(parsed["sub.provider"]["name"], "sub.provider")

    def test_parse_toml_minimal_keeps_hash_inside_quotes(self):
        text = 'model_provider = "ac#me" # comment' + chr(10) + "[model_providers.ab]" + chr(10) + 'base_url = "http://x/#f"' + chr(10)
        parsed = self.mod.parse_toml_minimal(text)
        self.assertEqual(parsed["model_provider"], "ac#me")
        self.assertEqual(parsed["model_providers"]["ab"]["base_url"], "http://x/#f")


class NothingToRepairTests(unittest.TestCase):
    """Regression test for audit finding B3: no-op apply must exit early."""

    def test_apply_with_nothing_to_repair_creates_no_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / ".codex"
            home.mkdir()
            db_path = home / "state_5.sqlite"
            with contextlib.closing(sqlite3.connect(db_path)) as conn:
                conn.execute(
                    "create table threads ("
                    "id text primary key, rollout_path text, model_provider text, "
                    "title text, cwd text, created_at integer, "
                    "updated_at integer, has_user_event integer, preview text)"
                )
                conn.execute(
                    "insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("t1", str(home / "sessions/t1.jsonl"), "openai", "T", "/tmp", 1, 1, 1, "T"),
                )
                conn.commit()
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--codex-home", str(home), "--apply"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Nothing to repair", result.stdout)
            self.assertFalse((home / "backups").exists())


if __name__ == "__main__":
    unittest.main()
