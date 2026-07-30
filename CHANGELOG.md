# Changelog

## 3.0.1 - 2026-07-31

### Fixes

- Keep Codex `session_index.jsonl`, rollout metadata, and SQLite thread records aligned during repair and import.
- Back up the session index before applying changes and add isolated regression coverage for the write paths.
