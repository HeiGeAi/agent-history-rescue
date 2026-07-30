#!/usr/bin/env python3
"""Codex backend for agent-history-rescue.

Repair Codex desktop sidebar history that disappears after switching account,
API provider, or custom provider name. The threads still exist in ~/.codex but
the sidebar filters by the current model_provider and hides archived rows.

What it does (apply mode), after backing everything up first:
  - rewrite threads.model_provider in the SQLite state DB from old providers to
    the current one, so they pass the sidebar filter;
  - rewrite the same provider tag inside rollout JSONL session_meta payloads, so
    Codex does not re-index the old value and undo the DB edit;
  - keep session_index.jsonl provider/archive metadata in sync with the DB;
  - optionally add provider aliases to config.toml (Python 3.11+ only);
  - optionally unarchive threads so archived history returns to the sidebar.

Standard library only. Works on Python 3.8+. The config-alias step needs 3.11+
(tomllib); without it the SQLite + JSONL rewrite still applies and is normally
enough. Part of https://github.com/HeiGeAi/agent-history-rescue (MIT).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None


def now_stamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def codex_home_from_args(value):
    if value:
        return Path(value).expanduser().resolve()
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return Path.home() / ".codex"


def find_state_db(codex_home: Path, explicit):
    if explicit:
        return Path(explicit).expanduser().resolve()
    candidates = sorted(
        codex_home.glob("state*.sqlite"),
        key=lambda p: (p.stat().st_mtime, p.name),
        reverse=True,
    )
    if not candidates:
        raise SystemExit(f"No state*.sqlite database found under {codex_home}")
    return candidates[0]


# --------------------------------------------------------------------------
# config.toml parsing. Prefer tomllib (accurate). Fall back to a tiny reader so
# the tool still works on the system python3 that ships without tomllib.
# --------------------------------------------------------------------------
def parse_scalar(v: str):
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    if v in ("true", "false"):
        return v == "true"
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v.strip('"').strip("'")


def parse_toml_minimal(text: str) -> dict:
    """Read just enough TOML for our needs: top-level model_provider and the
    [model_providers.NAME] tables. Naive but dependency-free."""
    data: dict = {}
    cur = data
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            keys = [k.strip().strip('"') for k in line[1:-1].strip().split(".")]
            node = data
            for k in keys:
                nxt = node.get(k)
                if not isinstance(nxt, dict):
                    nxt = {}
                    node[k] = nxt
                node = nxt
            cur = node
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            cur[key.strip().strip('"')] = parse_scalar(value)
    return data


def read_config(config_path: Path):
    if not config_path.exists():
        return {}, "", True
    text = config_path.read_text(encoding="utf-8")
    if tomllib is not None:
        try:
            return tomllib.loads(text), text, True
        except Exception:
            pass
    return parse_toml_minimal(text), text, False


def provider_blocks(config: dict) -> dict:
    blocks = config.get("model_providers") or {}
    return blocks if isinstance(blocks, dict) else {}


# --------------------------------------------------------------------------
# SQLite read helpers (resilient to a locked DB and to schema differences).
# --------------------------------------------------------------------------
def connect_read(db_path: Path):
    """Open the state DB for diagnosis. A normal connection reads write-ahead-log
    data correctly even while Codex is running (mode=ro is flaky on WAL). We force
    query_only so this connection can never modify anything."""
    conn = sqlite3.connect(str(db_path), timeout=5)
    try:
        conn.execute("pragma query_only = ON")
    except sqlite3.Error:
        pass
    return conn


def thread_columns(conn) -> set:
    try:
        return {row[1] for row in conn.execute("pragma table_info(threads)").fetchall()}
    except sqlite3.Error:
        return set()


def summarize_threads(db_path: Path) -> dict:
    with connect_read(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cols = thread_columns(conn)
        if not cols:
            raise SystemExit(
                "Could not read the 'threads' table. If Codex is running, the DB may be "
                "busy; try again, or fully quit Codex first."
            )
        if "model_provider" not in cols:
            raise SystemExit("The 'threads' table has no 'model_provider' column; schema not supported.")
        has_archived = "archived" in cols
        has_preview = "preview" in cols
        total = conn.execute("select count(*) from threads").fetchone()[0]
        archived = conn.execute("select count(*) from threads where archived=1").fetchone()[0] if has_archived else 0
        with_preview = (
            conn.execute("select count(*) from threads where preview <> ''").fetchone()[0]
            if has_preview else None
        )
        # Group by provider (and archived) only. Grouping by `source` would explode
        # into one row per subagent spawn, which is noise for the repair decision.
        group_cols = ["model_provider"]
        if has_archived:
            group_cols.append("archived")
        sel = ", ".join(group_cols)
        rows = conn.execute(
            f"select {sel}, count(*) as n from threads group by {sel} order by n desc"
        ).fetchall()
    return {
        "total": total,
        "archived": archived,
        "with_preview": with_preview,
        "has_archived": has_archived,
        "groups": [dict(row) for row in rows],
    }


def infer_target(config: dict, explicit, summary: dict) -> str:
    if explicit:
        return explicit
    provider = config.get("model_provider")
    if provider:
        return provider
    # No provider in config: assume the current one is the provider used by the
    # majority of non-archived threads (what the sidebar shows now).
    non_archived: dict = {}
    overall: dict = {}
    for row in summary["groups"]:
        prov = row.get("model_provider")
        if not prov:
            continue
        overall[prov] = overall.get(prov, 0) + row["n"]
        if not row.get("archived"):
            non_archived[prov] = non_archived.get(prov, 0) + row["n"]
    pool = non_archived or overall
    if pool:
        return max(pool, key=pool.get)
    return "openai"


def source_providers(summary: dict, target: str, explicit) -> list:
    if explicit:
        return sorted(set(explicit))
    providers = {row.get("model_provider") for row in summary["groups"] if row.get("model_provider")}
    return sorted(p for p in providers if p != target)


# --------------------------------------------------------------------------
# Rollout JSONL helpers.
# --------------------------------------------------------------------------
def iter_rollout_files(codex_home: Path) -> list:
    roots = [codex_home / "sessions", codex_home / "archived_sessions"]
    files: list = []
    for root in roots:
        if root.exists():
            files.extend(root.rglob("*.jsonl"))
    return sorted(files)


def jsonl_provider_counts(files: list, providers: set) -> dict:
    counts = {provider: 0 for provider in providers}
    for file_path in files:
        try:
            with file_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if '"type":"session_meta"' not in line and '"type": "session_meta"' not in line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    provider = (
                        item.get("payload", {}).get("model_provider")
                        if item.get("type") == "session_meta" else None
                    )
                    if provider in counts:
                        counts[provider] += 1
        except OSError:
            continue
    return counts


# --------------------------------------------------------------------------
# Backup + write helpers.
# --------------------------------------------------------------------------
def snapshot_sqlite_bytes(db_path: Path, backup_dir: Path) -> Path:
    """Keep exact SQLite files for compensating a failed multi-store apply."""
    snapshot_dir = backup_dir / "original-sqlite-bytes"
    snapshot_dir.mkdir()
    for suffix in ("", "-wal", "-shm"):
        source = Path(str(db_path) + suffix)
        if source.exists():
            shutil.copy2(source, snapshot_dir / source.name)
    return snapshot_dir


def restore_file_bytes(backup_path: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_name(f".{destination.name}.tmp-{uuid.uuid4().hex}")
    try:
        shutil.copy2(backup_path, temp_path)
        os.replace(temp_path, destination)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def restore_optional_file(destination: Path, backup_path: Path) -> None:
    if backup_path.exists():
        restore_file_bytes(backup_path, destination)
    else:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass


def restore_sqlite_bytes(db_path: Path, snapshot_dir: Path) -> None:
    for suffix in ("-wal", "-shm"):
        try:
            Path(str(db_path) + suffix).unlink()
        except FileNotFoundError:
            pass
    restore_file_bytes(snapshot_dir / db_path.name, db_path)
    for suffix in ("-wal", "-shm"):
        backup_path = snapshot_dir / f"{db_path.name}{suffix}"
        if backup_path.exists():
            restore_file_bytes(backup_path, Path(str(db_path) + suffix))


def restore_rollout_backups(codex_home: Path, backup_dir: Path) -> None:
    backup_root = backup_dir / "rollout-jsonl"
    if not backup_root.exists():
        return
    for backup_path in backup_root.rglob("*.jsonl"):
        restore_file_bytes(backup_path, codex_home / backup_path.relative_to(backup_root))


def make_backup(db_path: Path, config_path: Path, codex_home: Path, session_index_path: Path) -> Path:
    backup_dir = codex_home / "backups" / f"thread-history-repair-{now_stamp()}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    if config_path.exists():
        shutil.copy2(config_path, backup_dir / "config.toml")
    if session_index_path.exists():
        shutil.copy2(session_index_path, backup_dir / "session_index.jsonl")
    snapshot_sqlite_bytes(db_path, backup_dir)
    with sqlite3.connect(db_path) as src, sqlite3.connect(backup_dir / db_path.name) as dst:
        src.backup(dst)
    return backup_dir


def backup_jsonl(file_path: Path, codex_home: Path, backup_dir: Path) -> None:
    rel = file_path.relative_to(codex_home)
    dest = backup_dir / "rollout-jsonl" / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        shutil.copy2(file_path, dest)


def ensure_config_aliases(config_path, config, config_text, target_provider, sources) -> bool:
    blocks = provider_blocks(config)
    if target_provider not in blocks or not sources:
        return False
    missing = [source for source in sources if source not in blocks]
    if not missing:
        return False
    target = dict(blocks[target_provider])
    target["name"] = None
    additions: list = []
    for source in missing:
        additions.append("")
        additions.append(f"[model_providers.{source}]")
        for key, value in target.items():
            if key == "name":
                value = source
            if isinstance(value, bool):
                encoded = "true" if value else "false"
            elif isinstance(value, (int, float)):
                encoded = str(value)
            else:
                encoded = json.dumps(str(value), ensure_ascii=False)
            additions.append(f"{key} = {encoded}")
    marker = "\n[mcp_servers]"
    addition_text = "\n".join(additions) + "\n"
    if marker in config_text:
        new_text = config_text.replace(marker, "\n" + addition_text + marker, 1)
    else:
        new_text = config_text.rstrip() + "\n" + addition_text
    config_path.write_text(new_text, encoding="utf-8")
    return True


def patch_jsonl(files, sources, target, codex_home, backup_dir) -> int:
    changed_files = 0
    for file_path in files:
        try:
            original = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
        except OSError:
            continue
        changed = False
        output: list = []
        for line in original:
            new_line = line
            if '"type":"session_meta"' in line or '"type": "session_meta"' in line:
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    item = None
                if item and item.get("type") == "session_meta":
                    payload = item.get("payload") or {}
                    if payload.get("model_provider") in sources:
                        payload["model_provider"] = target
                        item["payload"] = payload
                        newline = "\n" if line.endswith("\n") else ""
                        new_line = json.dumps(item, ensure_ascii=False, separators=(",", ":")) + newline
                        changed = True
            output.append(new_line)
        if changed:
            backup_jsonl(file_path, codex_home, backup_dir)
            file_path.write_text("".join(output), encoding="utf-8")
            changed_files += 1
    return changed_files


def patch_session_index(index_path: Path, sources: set, target: str, unarchive: bool) -> int:
    """Keep the desktop index aligned with repaired SQLite and rollout metadata.

    Invalid or unknown JSONL rows are preserved byte-for-byte. Valid rows only
    change when their provider is being migrated or they are explicitly
    unarchived.
    """
    if not index_path.exists():
        return 0
    try:
        original = index_path.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return 0

    output: list = []
    changed_rows = 0
    for line in original:
        newline = "\n" if line.endswith("\n") else ""
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            output.append(line)
            continue
        if not isinstance(item, dict):
            output.append(line)
            continue

        changed = False
        if item.get("model_provider") in sources:
            item["model_provider"] = target
            changed = True
        if unarchive and item.get("archived"):
            item["archived"] = False
            if "archived_at" in item:
                item["archived_at"] = None
            changed = True
        if changed:
            output.append(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + newline)
            changed_rows += 1
        else:
            output.append(line)

    if changed_rows:
        index_path.write_text("".join(output), encoding="utf-8")
    return changed_rows


def patch_sqlite(db_path, sources, target, unarchive, has_archived) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute("begin immediate")
        if sources:
            placeholders = ",".join("?" for _ in sources)
            conn.execute(
                f"update threads set model_provider=? where model_provider in ({placeholders})",
                [target, *sources],
            )
        if unarchive and has_archived:
            try:
                conn.execute("update threads set archived=0, archived_at=NULL where archived=1")
            except sqlite3.OperationalError:
                conn.execute("update threads set archived=0 where archived=1")
        conn.commit()
        try:
            conn.execute("pragma wal_checkpoint(full)")
        except sqlite3.Error:
            pass


def print_summary(label: str, summary: dict) -> None:
    print(f"\n{label}")
    print(f"  threads: {summary['total']}")
    print(f"  archived: {summary['archived']}")
    if summary.get("with_preview") is not None:
        print(f"  with_preview: {summary['with_preview']}")
    print("  groups:")
    for row in summary["groups"]:
        parts = [f"provider={row.get('model_provider')}"]
        if "source" in row:
            parts.append(f"source={row.get('source')}")
        if "archived" in row:
            parts.append(f"archived={row.get('archived')}")
        parts.append(f"count={row['n']}")
        print("    " + " ".join(parts))


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair Codex desktop sidebar history.")
    parser.add_argument("--codex-home", help="Codex home directory; defaults to CODEX_HOME or ~/.codex")
    parser.add_argument("--state-db", help="Explicit state SQLite path")
    parser.add_argument("--target-provider", help="Provider name to make sidebar-visible")
    parser.add_argument("--source-provider", action="append", default=[], help="Provider to migrate; may repeat")
    parser.add_argument("--apply", action="store_true", help="Apply changes. Without this, run a dry run.")
    parser.add_argument("--dry-run", action="store_true", help="Show diagnosis only")
    parser.add_argument("--unarchive", action="store_true", help="Restore archived threads to the sidebar")
    args = parser.parse_args()

    codex_home = codex_home_from_args(args.codex_home)
    config_path = codex_home / "config.toml"
    session_index_path = codex_home / "session_index.jsonl"
    db_path = find_state_db(codex_home, args.state_db)
    config, config_text, toml_accurate = read_config(config_path)

    before = summarize_threads(db_path)
    target = infer_target(config, args.target_provider, before)
    sources = source_providers(before, target, args.source_provider)
    rollout_files = iter_rollout_files(codex_home)
    provider_counts = jsonl_provider_counts(rollout_files, set(sources + [target]))

    print(f"Codex home: {codex_home}")
    print(f"State DB: {db_path}")
    print(f"Target provider: {target}")
    print(f"Source providers: {', '.join(sources) if sources else '(none)'}")
    print_summary("Before", before)
    if provider_counts:
        print("\nSession metadata provider counts:")
        for provider, count in sorted(provider_counts.items()):
            print(f"  {provider}: {count}")

    if not sources and not (args.unarchive and before["archived"]):
        print("\nNothing to repair: all threads are already on the target provider"
              + (" and none are archived." if before["has_archived"] else "."))

    if not args.apply:
        print("\nDry run only. Re-run with --apply (and --unarchive if you want archived history back).")
        return 0

    backup_dir = make_backup(db_path, config_path, codex_home, session_index_path)
    print(f"\nBackup: {backup_dir}")
    try:
        if toml_accurate:
            config_changed = ensure_config_aliases(
                config_path, config, config_text, target, sources
            )
        else:
            config_changed = False
            if sources:
                print(
                    "Note: skipping config provider-alias step "
                    "(needs Python 3.11+ for safe TOML parsing)."
                )
                print(
                    "      The SQLite + JSONL rewrite below is the core fix "
                    "and is normally sufficient."
                )

        changed_jsonl = patch_jsonl(
            rollout_files, set(sources), target, codex_home, backup_dir
        )
        changed_index_rows = patch_session_index(
            session_index_path, set(sources), target, args.unarchive
        )
        patch_sqlite(db_path, sources, target, args.unarchive, before["has_archived"])

        after = summarize_threads(db_path)
        after_counts = jsonl_provider_counts(rollout_files, set(sources + [target]))
    except BaseException as apply_error:
        rollback_errors = []
        for label, action in (
            (
                str(config_path),
                lambda: restore_optional_file(config_path, backup_dir / "config.toml"),
            ),
            (
                str(session_index_path),
                lambda: restore_optional_file(
                    session_index_path, backup_dir / "session_index.jsonl"
                ),
            ),
            (
                "rollout JSONL files",
                lambda: restore_rollout_backups(codex_home, backup_dir),
            ),
            (
                str(db_path),
                lambda: restore_sqlite_bytes(
                    db_path, backup_dir / "original-sqlite-bytes"
                ),
            ),
        ):
            try:
                action()
            except OSError as error:
                rollback_errors.append(f"restore {label}: {error}")
        if rollback_errors:
            raise RuntimeError(
                "Repair failed and compensation was incomplete: "
                + "; ".join(rollback_errors)
            ) from apply_error
        raise

    print(f"\nConfig aliases added: {'yes' if config_changed else 'no'}")
    print(f"JSONL files patched: {changed_jsonl}")
    print(f"Session index rows patched: {changed_index_rows}")
    print_summary("After", after)
    if after_counts:
        print("\nSession metadata provider counts after:")
        for provider, count in sorted(after_counts.items()):
            print(f"  {provider}: {count}")
    print("\nRestart Codex desktop if the sidebar does not refresh immediately.")
    print(f"To roll back, restore files from: {backup_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
