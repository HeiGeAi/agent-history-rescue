# claude-history-rescue

<div align="center">

![version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)
![license](https://img.shields.io/badge/license-MIT-green.svg)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)
![deps](https://img.shields.io/badge/dependencies-0-success.svg)

**Claude Code 历史救援 · 换账号后找回"消失"的对话 | Rescue your Claude Code history after switching accounts**

对话没丢，只是被新账号藏起来了。这个工具把它们接回你当前账号的桌面端。

[这是什么](#这是什么-what-is-this) • [为什么会消失](#为什么会消失-why-it-happens) • [快速开始](#快速开始-quick-start) • [用法](#用法-usage) • [安全设计](#安全设计-how-it-stays-safe) • [排障](#排障-troubleshooting) • [English](#english)

</div>

---

## 这是什么 What is this

换了账号、重装或升级 Claude 桌面端后，Claude Code 的历史对话"全不见了"？**它们没被删。** 这是一个**零依赖的 Node 命令行工具**，把那些被账号隔离藏起来的对话重新接回你当前的桌面端。

原理就一句：**对话本体一直在磁盘上，是桌面端的索引按账号分了家。**

Claude Code 在你电脑上存了两套互相独立的东西：

| 存的是什么 | 位置 | 绑账号吗 |
|---|---|---|
| **对话本体**（真正的聊天内容） | `~/.claude/projects/<项目>/<id>.jsonl` | **不绑。** 本地文件，换账号、重装都不删 |
| **桌面端 Recents 索引**（几百字节的指针文件） | `<AppData>/Claude/claude-code-sessions/<workspace>/…` | **绑。** 按账号分到不同 workspace |

换账号后，桌面端给新账号开了个**全新的空 workspace**，旧账号的指针锁在原来的 workspace 里出不来，于是 Recents 看着空了，可对话本体始终安安静静躺在磁盘上。这个工具就是**把旧指针复制进你当前账号的 workspace**，桌面端重启后历史全部归位。

### 它能做什么

- ✅ **只读扫描**：先列出所有 workspace 和对话数，看清楚再动手，不碰一个字节
- ✅ **一键找回**：把旧账号的对话指针复制进当前账号，桌面端重启即见
- ✅ **备份优先**：每次操作前自动整目录备份，**绝不删除、绝不覆盖**
- ✅ **运行护栏**：检测到桌面端正开着就直接拒绝，避免和 App 抢写
- ✅ **可重复跑**：第二次运行什么都不做（按对话本体去重，天然幂等）
- ✅ **一键回滚**：`--restore` 把一切还原成操作前的样子
- ✅ **零依赖**：纯 Node 标准库，全部逻辑就一个文件，方便你自己审
- ✅ **跨平台**：macOS / Windows / Linux 自动探测路径

### 适合谁

- 换账号 / 重装 / 升级后，桌面端历史突然"消失"的人
- 不想丢掉几百条对话上下文、又不放心手动去翻 App 内部文件的人
- 想要一套**先备份、可回滚、看得懂**的安全做法的人

---

## 为什么会消失 Why it happens

这不是偶发 bug，而是桌面端"workspace 按账号隔离"的设计撞上了"换账号"。社区里大量同类反馈都是同一个根因，对话本体其实都还在：

[anthropics/claude-code#27349](https://github.com/anthropics/claude-code/issues/27349) ·
[#29373](https://github.com/anthropics/claude-code/issues/29373) ·
[#62997](https://github.com/anthropics/claude-code/issues/62997) ·
[#19434](https://github.com/anthropics/claude-code/issues/19434) ·
[#12908](https://github.com/anthropics/claude-code/issues/12908)

如果你是从这些 issue 找过来的，这个工具就是给你的。

---

## 快速开始 Quick start

需要 [Node.js](https://nodejs.org) 16 以上（你能跑 Claude Code 就一定有）。

```bash
# 1. 先看看有什么（只读，不改任何东西）
npx -y github:HeiGeAi/claude-history-rescue --list

# 2. 完全退出 Claude 桌面端，然后找回历史
npx -y github:HeiGeAi/claude-history-rescue

# 3. 万一不对，一键回滚
npx -y github:HeiGeAi/claude-history-rescue --restore <备份目录>
```

也可以克隆下来跑：

```bash
git clone https://github.com/HeiGeAi/claude-history-rescue.git
cd claude-history-rescue
node bin/claude-history-rescue.js --list
```

---

## 用法 Usage

| 命令 / Option | 作用 |
|---|---|
| `claude-history-rescue` | 扫描 → 显示计划 → 备份 → 迁移（交互式，默认） |
| `--list`, `-l` | 只列出 workspace 和对话，**只读** |
| `--dry-run`, `-n` | 只预览会迁移什么，不改文件 |
| `--yes`, `-y` | 跳过确认直接执行（仍会备份） |
| `--restore <dir>` | 从上次运行打印的备份目录回滚 |
| `--sessions-dir <path>` | 指定非默认的 `claude-code-sessions` 路径 |
| `--target-workspace <id>` | 强制指定迁移进哪个 workspace |
| `--force` | 跳过"桌面端正在运行"的安全检查（高级） |

**典型流程：**

```bash
npx -y github:HeiGeAi/claude-history-rescue --list   # 确认旧历史还在
# → 完全退出 Claude 桌面端
npx -y github:HeiGeAi/claude-history-rescue          # 备份 + 迁移
# → 重新打开桌面端，Recents 全部回来
```

---

## 安全设计 How it stays safe

这个工具会动到桌面端的内部文件，所以它被刻意设计得很保守：

- **操作前先备份。** 每次运行都把整个 `claude-code-sessions` 复制到 `~/.claude-history-rescue/backups/<时间戳>/`，再动手。
- **只复制，不删除、不覆盖。** 它只把指针文件**拷贝**进你当前的 workspace，旧 workspace 原封不动。
- **App 开着就拒绝运行**，不和桌面端抢写。
- **幂等。** 跑第二次什么都不做，已经显示出来的对话会被跳过（按对话本体 id 去重）。
- **一条命令回滚。** `--restore <备份目录>` 把一切还原。
- **零依赖、可审计。** 纯 Node 标准库，全部逻辑就一个文件：[`bin/claude-history-rescue.js`](bin/claude-history-rescue.js)。

---

## 排障 Troubleshooting

**提示 "No Claude Code desktop sessions found."**
你的桌面端数据可能存在非默认位置。找到 `claude-code-sessions` 文件夹，用 `--sessions-dir "/路径/to/Claude/claude-code-sessions"` 显式指定。

**说迁移成功了，但重启后 Recents 还是空的。**
桌面端有时会缓存一份空列表。**彻底退出**（不是关窗口）再打开。若仍不显示，缓存在 App 的本地存储里，欢迎带上你的系统和 App 版本开个 [issue](https://github.com/HeiGeAi/claude-history-rescue/issues)，我们补一个清缓存的步骤。

**我只想读某条旧对话，不用桌面端。**
那不需要本工具。对话本体就是普通文件，终端里 `cd <你的项目> && claude --resume` 选会话即可，或直接打开 `~/.claude/projects/` 下的 `.jsonl`。

**备份在哪？**
`~/.claude-history-rescue/backups/<时间戳>/`。确认历史回来后可以删。

---

## English

Switched accounts, reinstalled, or upgraded the Claude desktop app and your Claude Code
conversations vanished? **They are not deleted.** `claude-history-rescue` is a zero-dependency
Node CLI that brings them back.

**The one-line reason:** your transcripts are always on disk; only the desktop app's *index*
is split per account.

Claude Code keeps two separate stores on your machine:

| Store | Location | Tied to your account? |
| --- | --- | --- |
| **The real transcripts** (your actual conversations) | `~/.claude/projects/<project>/<id>.jsonl` | **No.** Local files, survive everything |
| **The desktop "Recents" index** (tiny pointer files) | `<AppData>/Claude/claude-code-sessions/<workspace>/…` | **Yes.** Grouped into per-account workspaces |

When you switch accounts, the desktop app opens a brand-new empty workspace for the new
account, and your old pointers stay locked in the previous account's workspace. The transcripts
never moved. This tool copies those pointers into your current workspace so the desktop app
lists your full history again.

```bash
# See what's there (read-only)
npx -y github:HeiGeAi/claude-history-rescue --list

# Quit the Claude desktop app, then bring your history back
npx -y github:HeiGeAi/claude-history-rescue

# Roll back if needed
npx -y github:HeiGeAi/claude-history-rescue --restore <backupDir>
```

**Safety:** backs up before every change, only ever copies (never deletes or overwrites),
refuses to run while the app is open, is idempotent, and rolls back with one command. Zero
dependencies, all in one auditable file. Use at your own risk and keep the backup until you've
confirmed your history is back.

---

## 致谢 Credits

由 [HeiGeAi](https://github.com/HeiGeAi) 在一次换账号丢了几百条对话、又把它们找回来之后做成工具开源，省得你再踩一遍坑。

Built by [HeiGeAi](https://github.com/HeiGeAi) after losing, and recovering, a few hundred
Claude Code conversations to an account switch. Shared so you don't have to figure it out the
hard way.

## 许可证 License

[MIT](LICENSE)，随便用、随便改、随便分享。Copyright © 2026 HeiGeAi (Blake Xu).

> 它在每次改动前都会备份、且从不删除你的数据，但毕竟会碰桌面端的内部文件。**确认历史回来之前，先留着备份。**
