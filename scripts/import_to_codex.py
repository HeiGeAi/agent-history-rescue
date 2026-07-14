#!/usr/bin/env python3
"""Codex import backend for agent-history-rescue.

Reads a job file (normalized conversations) produced by the Node CLI and restores
those conversations into Codex so they show up in the desktop sidebar:
  - writes one rollout JSONL per conversation under ~/.codex/sessions/YYYY/MM/DD/
    (session_meta + response_item lines, the format Codex replays from);
  - inserts a matching row into the `threads` table of state*.sqlite.

Backs up state*.sqlite first. Only inserts new rows and writes new files; never
edits or deletes your existing Codex data. Standard library only (sqlite3 + json),
Python 3.8+. Part of https://github.com/HeiGeAi/agent-history-rescue (MIT).

Job file shape (JSON):
  {
    "codexHome": "/Users/you/.codex",        # optional; defaults to CODEX_HOME/~/.codex
    "defaultProvider": "openai",             # provider to tag restored threads with; null -> infer
    "cwd": "/Users/you/recovered",           # cwd shown for restored threads
    "conversations": [
      {"id","title","createdAt","updatedAt","messages":[{"role","text","timestamp"}]}
    ]
  }
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import uuid
from pathlib import Path

UTC = dt.timezone.utc
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def now_stamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def codex_home(value):
    if value:
        return Path(value).expanduser().resolve()
    env = os.environ.get("CODEX_HOME")
    return Path(env).expanduser().resolve() if env else Path.home() / ".codex"


def find_state_db(home: Path):
    cands = sorted(home.glob("state*.sqlite"), key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    if not cands:
        raise SystemExit(f"No state*.sqlite found under {home}. Is this a Codex home?")
    return cands[0]


def infer_provider(conn):
    """Restored threads must carry the provider the sidebar currently shows,
    otherwise they would be filtered out. Use the most common provider among
    non-archived threads; fall back to 'openai'."""
    try:
        rows = conn.execute(
            "select model_provider, count(*) n from threads where archived=0 "
            "group by model_provider order by n desc"
        ).fetchall()
        for prov, _ in rows:
            if prov:
                return prov
    except sqlite3.Error:
        pass
    return "openai"


def safe_id(conv):
    """Conversation ids come from an untrusted export. Never let one become a path
    component unless it is a clean token, to avoid path traversal. For a bad id,
    derive a deterministic id from content (not random) so re-runs stay idempotent."""
    raw = conv.get("id") or ""
    if SAFE_ID.match(raw) and raw not in (".", ".."):
        return raw
    seed = f"{raw} {conv.get('title', '')} {conv.get('createdAt', '')}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def parse_iso(s):
    """Parse an export timestamp as timezone-aware UTC (exports use '...Z')."""
    if not s:
        return dt.datetime.now(UTC)
    try:
        d = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=UTC)
    except Exception:
        return dt.datetime.now(UTC)


def iso_z(d: dt.datetime) -> str:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def write_rollout(home: Path, conv, provider, cwd, sid):
    """Write one rollout JSONL and return its path relative to the Codex home."""
    created = parse_iso(conv.get("createdAt"))
    rel_dir = Path("sessions") / f"{created:%Y}" / f"{created:%m}" / f"{created:%d}"
    (home / rel_dir).mkdir(parents=True, exist_ok=True)
    rel_path = rel_dir / f"rollout-{created:%Y-%m-%dT%H-%M-%S}-{sid}.jsonl"
    lines = [{
        "timestamp": iso_z(created),
        "type": "session_meta",
        "payload": {
            "id": sid, "timestamp": iso_z(created), "cwd": cwd,
            "originator": "agent_history_rescue", "cli_version": "recovered",
            "source": "import", "model_provider": provider,
        },
    }]
    for m in conv.get("messages", []):
        if not m:
            continue
        role = "user" if m.get("role") == "user" else "assistant"
        ctype = "input_text" if role == "user" else "output_text"
        lines.append({
            "timestamp": iso_z(parse_iso(m.get("timestamp")) if m.get("timestamp") else created),
            "type": "response_item",
            "payload": {"type": "message", "role": role, "content": [{"type": ctype, "text": m.get("text", "")}]},
        })
    with (home / rel_path).open("w", encoding="utf-8") as fh:
        for ln in lines:
            fh.write(json.dumps(ln, ensure_ascii=False) + "\n")
    return rel_path, created


def insert_thread(conn, cols, conv, sid, abs_rollout_path, provider, cwd, created):
    updated = parse_iso(conv.get("updatedAt")) if conv.get("updatedAt") else created
    first_user = next((m.get("text", "") for m in conv.get("messages", []) if m and m.get("role") == "user"), "")
    preview = (conv.get("title") or first_user or "")[:200]
    # Time columns are INTEGER Unix seconds (and *_ms milliseconds) in the real schema.
    cs, us = int(created.timestamp()), int(updated.timestamp())
    candidate = {
        "id": sid, "rollout_path": abs_rollout_path,
        "created_at": cs, "updated_at": us, "created_at_ms": cs * 1000, "updated_at_ms": us * 1000,
        "recency_at": us, "recency_at_ms": us * 1000,
        "source": "import", "thread_source": "import", "model_provider": provider, "cwd": cwd,
        "title": conv.get("title") or "(recovered)", "archived": 0, "has_user_event": 1,
        "first_user_message": first_user[:2000], "preview": preview, "cli_version": "recovered",
    }
    use = {k: v for k, v in candidate.items() if k in cols}
    placeholders = ",".join("?" for _ in use)
    conn.execute(f"insert into threads ({','.join(use.keys())}) values ({placeholders})", list(use.values()))


def session_index_entry(conv, sid, rollout_path, provider, cwd, archived=False):
    created = parse_iso(conv.get("createdAt"))
    updated = parse_iso(conv.get("updatedAt")) if conv.get("updatedAt") else created
    return {
        "id": sid,
        "thread_name": conv.get("title") or "(recovered)",
        "rollout_path": str(rollout_path),
        "created_at": iso_z(created),
        "updated_at": iso_z(updated),
        "model_provider": provider,
        "archived": bool(archived),
        "cwd": cwd,
    }


def append_session_index(index_path: Path, rows) -> int:
    """Atomically append missing rows while preserving existing/unknown lines."""
    file_mode = stat.S_IMODE(index_path.stat().st_mode) if index_path.exists() else 0o600
    original = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
    existing_ids = set()
    for line in original.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and item.get("id"):
            existing_ids.add(item["id"])

    additions = []
    for row in rows:
        if row["id"] in existing_ids:
            continue
        additions.append(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
        existing_ids.add(row["id"])
    if not additions:
        return 0

    content = original
    if content and not content.endswith("\n"):
        content += "\n"
    content += "\n".join(additions) + "\n"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = index_path.with_name(f".{index_path.name}.tmp-{uuid.uuid4().hex}")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.chmod(file_mode)
    os.replace(temp_path, index_path)
    return len(additions)


def main() -> int:
    ap = argparse.ArgumentParser(description="Import recovered conversations into Codex.")
    ap.add_argument("job", help="Path to the job JSON written by the Node CLI")
    ap.add_argument("--apply", action="store_true", help="Apply. Without it, dry run.")
    args = ap.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    home = codex_home(job.get("codexHome"))
    cwd = job.get("cwd") or str(Path.home() / "recovered-codex-history")
    convs = job.get("conversations", [])
    db_path = find_state_db(home)

    with sqlite3.connect(str(db_path)) as conn:
        cols = {r[1] for r in conn.execute("pragma table_info(threads)").fetchall()}
        provider = job.get("defaultProvider") or infer_provider(conn)
    if "id" not in cols or "rollout_path" not in cols or "model_provider" not in cols:
        raise SystemExit("Unexpected threads schema; cannot import safely.")

    print(f"Codex home: {home}")
    print(f"State DB:   {db_path}")
    print(f"Provider:   {provider}")
    print(f"Conversations to import: {len(convs)}")

    if not args.apply:
        print("\nDry run only. Re-run with --apply to write rollouts and insert threads.")
        return 0

    backup_dir = home / "backups" / f"import-{now_stamp()}-{uuid.uuid4().hex[:6]}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as src, sqlite3.connect(backup_dir / db_path.name) as dst:
        src.backup(dst)
    session_index_path = home / "session_index.jsonl"
    if session_index_path.exists():
        shutil.copy2(session_index_path, backup_dir / "session_index.jsonl")
    print(f"\nBackup (state DB and session index): {backup_dir}")

    written_files = []
    index_rows = []
    written = skipped = failed = 0
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("begin immediate")
        for conv in convs:
            sid = safe_id(conv)
            existing_columns = ["rollout_path", "model_provider"]
            if "archived" in cols:
                existing_columns.append("archived")
            existing = conn.execute(
                f"select {','.join(existing_columns)} from threads where id=?",
                (sid,),
            ).fetchone()
            if existing:
                skipped += 1
                index_rows.append(
                    session_index_entry(
                        conv,
                        sid,
                        existing[0],
                        existing[1] or provider,
                        cwd,
                        existing[2] if len(existing) > 2 else False,
                    )
                )
                continue
            rel_path = None
            try:
                rel_path, created = write_rollout(home, conv, provider, cwd, sid)
                abs_rollout_path = home / rel_path
                insert_thread(conn, cols, conv, sid, str(abs_rollout_path), provider, cwd, created)
                written_files.append(abs_rollout_path)
                index_rows.append(
                    session_index_entry(conv, sid, abs_rollout_path, provider, cwd)
                )
                written += 1
            except Exception as e:  # noqa: BLE001
                failed += 1
                # Remove the orphan rollout whose DB row failed, so disk and DB agree.
                if rel_path is not None:
                    try:
                        (home / rel_path).unlink()
                    except OSError:
                        pass
                print(f"  ! skipped one conversation: {e}")
        conn.commit()
        try:
            conn.execute("pragma wal_checkpoint(full)")
        except sqlite3.Error:
            pass

    indexed = append_session_index(session_index_path, index_rows)

    extra = []
    if skipped:
        extra.append(f"{skipped} already imported")
    if failed:
        extra.append(f"{failed} failed")
    print(f"\nImported {written} conversation(s) into Codex" + (f" ({', '.join(extra)})" if extra else "") + ".")
    print(f"Session index rows added: {indexed}")
    print("Restart Codex desktop to see them in the sidebar.")
    if written_files:
        listing = backup_dir / "imported-rollouts.txt"
        listing.write_text("\n".join(str(p) for p in written_files) + "\n", encoding="utf-8")
        print(
            f"\nTo roll back: restore {db_path.name} and session_index.jsonl "
            f"from {backup_dir}, then delete the rollout files"
        )
        print(f"listed in {listing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
