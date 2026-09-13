# Changelog

## 3.0.2 - 2026-09-13

### Fixes

- Codex rollback now deletes stale `-wal`/`-shm` files before overwriting the SQLite database, so leftover WAL frames are no longer replayed onto the restored database.
- Config alias writing serializes dict/list provider fields as proper TOML (inline tables / arrays) instead of Python repr strings, and quotes the provider table header key with a whitelist check.
- The fallback TOML parser no longer truncates `#` characters inside quoted strings.
- Repair exits early when there is nothing to fix, avoiding empty backup directories and a misleading rollback hint.
- Backup directory names gain a random suffix, so repeat runs within the same second no longer crash.
- `import --to` validates its value (`claude`/`codex`/`all`) and fails fast on unknown targets.
- Claude import restores transcripts and Recents pointers independently, so an interrupted re-run can repair a missing pointer.
- Extracted export archives are verified to stay inside the temp directory (zip-slip / symlink guard).

## 3.0.1 - 2026-07-31

### Fixes

- Keep Codex `session_index.jsonl`, rollout metadata, and SQLite thread records aligned during repair and import.
- Back up the session index before applying changes and add isolated regression coverage for the write paths.
