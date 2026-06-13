<div align="center">

# claude-history-rescue

![version](https://img.shields.io/badge/version-1.0.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![deps](https://img.shields.io/badge/dependencies-0-success)

**找回"消失"的 Claude Code 对话 | Restore Claude Code history after switching accounts**

Switched accounts, reinstalled, or upgraded the Claude desktop app and your Claude Code
conversations vanished? They are not gone. This tool brings them back.

[What's happening](#whats-happening) • [Install](#install--run) • [Usage](#usage) • [How it stays safe](#how-it-stays-safe) • [Troubleshooting](#troubleshooting) • [中文说明](#中文说明)

</div>

---

## What's happening

Your conversations are **not deleted** when this happens. Claude Code keeps two separate
stores on your machine:

| Store | Location | Tied to your account? |
| --- | --- | --- |
| **The real transcripts** (your actual conversations) | `~/.claude/projects/<project>/<id>.jsonl` | **No.** Local files, survive everything |
| **The desktop "Recents" index** (tiny pointer files) | `<AppData>/Claude/claude-code-sessions/<workspace>/...` | **Yes.** Grouped into per-account workspaces |

When you switch accounts, the desktop app opens a **brand-new empty workspace** for the new
account. Your old pointers stay locked in the previous account's workspace, so the Recents
list looks empty, even though every transcript is still safe on disk.

**`claude-history-rescue` copies those pointers into your current workspace**, so the
desktop app lists your full history again under the account you use now.

If you landed here from one of these reports, this tool is for you:
[anthropics/claude-code#27349](https://github.com/anthropics/claude-code/issues/27349),
[#29373](https://github.com/anthropics/claude-code/issues/29373),
[#62997](https://github.com/anthropics/claude-code/issues/62997),
[#19434](https://github.com/anthropics/claude-code/issues/19434),
[#12908](https://github.com/anthropics/claude-code/issues/12908).

## Install / Run

You need [Node.js](https://nodejs.org) 16 or newer (you already have it if you run Claude Code).

**Zero-install (recommended):**

```bash
# 1. See what's there. Read-only, changes nothing
npx github:HeiGeAi/claude-history-rescue --list

# 2. Quit the Claude desktop app, then bring your history back
npx github:HeiGeAi/claude-history-rescue
```

**Or clone it:**

```bash
git clone https://github.com/HeiGeAi/claude-history-rescue.git
cd claude-history-rescue
node bin/claude-history-rescue.js --list
```

## Usage

```bash
claude-history-rescue            # scan, show a plan, back up, then migrate (interactive)
claude-history-rescue --list     # just list workspaces & conversations, change nothing
claude-history-rescue --dry-run  # show exactly what would move, change nothing
claude-history-rescue --yes      # apply without the confirmation prompt (still backs up)
claude-history-rescue --restore <backupDir>   # roll back a previous run
```

| Option | What it does |
| --- | --- |
| `--list`, `-l` | List workspaces and conversation counts. Read-only. |
| `--dry-run`, `-n` | Preview the migration plan without changing anything. |
| `--yes`, `-y` | Skip the confirmation prompt (a backup is still made). |
| `--restore <dir>` | Restore from a backup folder printed by an earlier run. |
| `--sessions-dir <path>` | Point at a non-default `claude-code-sessions` location. |
| `--target-workspace <id>` | Force which workspace to merge into. |
| `--force` | Skip the running-app safety check (advanced). |

**Typical flow:**

```bash
npx github:HeiGeAi/claude-history-rescue --list   # confirm your old history is there
# → quit the Claude desktop app completely
npx github:HeiGeAi/claude-history-rescue          # back up + migrate
# → reopen the desktop app, your Recents are back
```

## How it stays safe

This tool touches the desktop app's internal state, so it is deliberately conservative:

- **Backs up first.** Every run copies the entire `claude-code-sessions` folder to
  `~/.claude-history-rescue/backups/<timestamp>/` before changing anything.
- **Never deletes, never overwrites.** It only *copies* pointer files into your current
  workspace. Your old workspace is left untouched.
- **Refuses to run while the app is open**, so it can't race the desktop app.
- **Idempotent.** Running it twice does nothing the second time. Conversations already
  visible are skipped (matched by their underlying transcript id).
- **One-command rollback.** `--restore <backupDir>` puts everything back exactly as it was.
- **Zero dependencies.** Pure Node standard library, easy to read and audit. The whole
  thing is one file: [`bin/claude-history-rescue.js`](bin/claude-history-rescue.js).

## Troubleshooting

**"No Claude Code desktop sessions found."**
Your desktop app may store data somewhere non-standard. Find the `claude-code-sessions`
folder and pass it explicitly: `--sessions-dir "/path/to/Claude/claude-code-sessions"`.

**It says it migrated, but Recents is still empty after restart.**
The desktop app sometimes caches an empty session list. Fully quit it (not just close the
window) and reopen. If it still won't show, the cache lives in the app's local storage; open
an [issue](https://github.com/HeiGeAi/claude-history-rescue/issues) with your OS and app
version and we'll add a cache-clear step.

**I just want to read an old conversation without the desktop app.**
You don't need this tool for that. The transcripts are plain files. In a terminal run
`cd <your project> && claude --resume` and pick the session, or open the `.jsonl` directly
from `~/.claude/projects/`.

**Where did my backup go?**
`~/.claude-history-rescue/backups/<timestamp>/`. Safe to delete once you've confirmed your
history is back.

---

## 中文说明

换了账号、重装或升级 Claude 桌面端后，Claude Code 的历史对话"全没了"？**它们没丢。**

Claude Code 在你电脑上存了两套东西：

- **对话本体**（真正的聊天内容）在 `~/.claude/projects/<项目>/<id>.jsonl`，**不绑账号**，换账号、重装都不会删。
- **桌面端的 Recents 索引**是一堆几百字节的"指针"文件，存在 `claude-code-sessions/<workspace>/` 下，而 **workspace 是按账号隔离的**。

换账号后，桌面端给新账号开了个**全新的空 workspace**，旧账号的指针锁在原来的 workspace 里，于是 Recents 看起来空了，可对话本体一直安安静静躺在磁盘上。

**这个工具把那些指针复制进你当前账号的 workspace**，桌面端重启后就会重新列出全部历史。

**用法：**

```bash
# 1. 先看看有什么（只读，不改任何东西）
npx github:HeiGeAi/claude-history-rescue --list

# 2. 完全退出 Claude 桌面端，然后找回历史
npx github:HeiGeAi/claude-history-rescue

# 3. 出问题想回滚
npx github:HeiGeAi/claude-history-rescue --restore <备份目录>
```

**安全设计：** 操作前自动整目录备份、只复制不删除不覆盖、检测到桌面端运行就拒绝执行、可重复运行（第二次什么都不做）、一条命令回滚。零依赖，全部逻辑就一个文件，方便你自己审。

> 提示：只是想读某条旧对话、不依赖桌面端？终端里 `cd <项目> && claude --resume` 选会话即可，不需要本工具。

---

## Credits

Built by [HeiGeAi](https://github.com/HeiGeAi) after losing, and recovering, a few hundred
Claude Code conversations to an account switch. Shared so you don't have to figure it out the
hard way.

## License

[MIT](LICENSE). Free to use, modify, and share. Copyright © 2026 HeiGeAi (Blake Xu).

> Use at your own risk. It backs up before every change and never deletes your data, but it
> does touch the Claude desktop app's internal files. Keep the backup until you've confirmed
> your history is back.
