import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from test_codex_repair import load_script, IMPORT_SCRIPT, SCRIPT


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
                path.write_text(line+'[]\nnull\ninvalid\n')
                backup=home/'backup';backup.mkdir()
                self.assertEqual(module.jsonl_provider_counts([path], {'old'}), {'old': 1})
                self.assertEqual(module.patch_jsonl([path], {'old'}, 'new', home, backup), 1)
                self.assertEqual(json.loads(path.read_text().splitlines()[0])['payload']['model_provider'], 'new')
                self.assertTrue(path.read_text().endswith('[]\nnull\ninvalid\n'))
                self.assertEqual(module.jsonl_provider_counts([path], {'new'}), {'new': 1})
