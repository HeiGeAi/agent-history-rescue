import json
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "repair_codex_history.py"
IMPORT_SCRIPT = ROOT / "scripts" / "import_to_codex.py"


class CodexRepairTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
