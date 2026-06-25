# agent-history-rescue

<div align="center">

![version](https://img.shields.io/badge/version-2.0.0-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)
![supports](https://img.shields.io/badge/supports-Claude%20Code%20%7C%20Codex-7c3aed.svg)
![license](https://img.shields.io/badge/license-MIT-green.svg)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)

**Agent 历史救援 · 换账号或换 provider 后找回 Claude Code 和 Codex"消失"的对话 | Recover Claude Code & Codex history after switching accounts or providers**

对话没丢，只是被新账号或新 provider 挡在了外面。这个工具把它们接回当前的桌面端。
Your conversations are not deleted. This tool brings them back into your current desktop app.

[症状](#你是否遇到这些-symptoms) • [这是什么](#这是什么-what-is-this) • [快速开始](#快速开始-quick-start) • [用法](#用法-usage) • [安全设计](#安全设计-how-it-stays-safe) • [常见问题](#常见问题-faq) • [English](#english)

</div>

---

## 你是否遇到这些 Symptoms

如果你正在搜下面任意一种情况，这个工具就是为你做的。**你的对话没有被删，只是被账号或 provider 挡住、没显示出来。**

**Claude Code**
- 换了 Claude 账号后，Claude Code 的历史对话**全没了**
- 升级或重装 Claude 桌面端后，Recents（最近对话）**变成空的**
- 桌面端只剩换账号之后的新对话，之前几百条全不见

**Codex**
- 换了账号或 API provider 后，Codex 侧栏的历史会话**不见了**
- 改了 `model_provider` / `base_url` / 自定义 provider 名后，旧会话从侧栏消失
- Codex 里**归档的会话**找不到，想重新显示出来

> In English, people hit this as: *"Claude Code history disappeared after switching accounts"*,
> *"Claude desktop Recents empty after update"*, *"Codex sidebar history missing after switching
> provider"*, *"Codex threads gone after changing model_provider / base_url"*, *"how to recover
> Codex conversation history"*, *"restore Codex archived threads"*. If that's you, read on.

---

## 这是什么 What is this

换了账号、换了 API provider、重装或升级后，Claude Code 或 Codex 的历史"全不见了"？**它们没被删。** 这是一个**Node 命令行工具**，把那些被挡住、没显示的对话重新接回你当前的桌面端。它支持两个 agent，两边"消失"的原因不一样，所以分开处理：

| | **Claude Code** | **Codex** |
|---|---|---|
| 对话存哪 | 对话本身在 `~/.claude/projects/*.jsonl`；桌面端那份列表是 `claude-code-sessions/<workspace>/` 里的小指针文件 | 会话在 `~/.codex` 的 `state*.sqlite` + `sessions/*.jsonl` 里 |
| 为什么消失 | 桌面端的 workspace **按账号分开存**，换账号后开了个空 workspace，旧指针进不来 | 侧栏**只显示当前 `model_provider` 的会话**，换 provider 后旧会话被挡掉；归档的也不显示 |
| 怎么修 | 把旧指针**复制**进当前账号的 workspace | 把 threads 表 + JSONL 里的旧 provider **改成**当前 provider，需要的话取消归档 |
| 用什么写的 | 原生 Node（只用 fs，不装任何包，Node 16+） | 内置 Python 脚本（只用标准库 sqlite3 + json，需 Python 3.8+） |

两边都守同一套规矩：**操作前先备份、只改列表和标记、绝不删除对话内容、App 开着就不动手、可一键还原。**

### 它能做什么

- ✅ **自动认出**：一条命令看出你装了 Claude Code 和 / 或 Codex，各自有多少历史
- ✅ **先看后改**：先把情况列清楚，看明白再动手，看的时候一个字节都不改
- ✅ **一键找回**：Claude 复制指针、Codex 改 provider 标记，桌面端重启就看见
- ✅ **先备份**：每次操作前自动备份，**绝不删除对话内容**
- ✅ **App 开着就不动手**：发现对应 App 开着就停下，不跟它抢着写
- ✅ **跑几遍都安全**：第二遍发现没什么可改，自动跳过
- ✅ **一键还原**：`--restore` 把一切退回操作前
- ✅ **跨平台**：macOS / Windows / Linux 自动找路径

---

## 快速开始 Quick start

需要 [Node.js](https://nodejs.org) 16 以上（你能跑 Claude Code / Codex 就一定有）。Codex 修复额外需要 `python3`（3.8+），Claude 一侧不需要。

```bash
# 0. 看看本机装了哪些 agent、各有多少历史（只看不改）
npx -y github:HeiGeAi/agent-history-rescue

# 1. 找回 Claude Code 历史：先退出 Claude 桌面端，再跑
npx -y github:HeiGeAi/agent-history-rescue claude

# 2. 找回 Codex 历史：先看诊断（只看不改），再退出 Codex 应用修复
npx -y github:HeiGeAi/agent-history-rescue codex                       # 诊断
npx -y github:HeiGeAi/agent-history-rescue codex --apply --unarchive   # 修复
```

也可以克隆下来跑：

```bash
git clone https://github.com/HeiGeAi/agent-history-rescue.git
cd agent-history-rescue
node bin/agent-history-rescue.js
```

---

## 用法 Usage

```bash
agent-history-rescue                 # 检测 Claude Code 与 Codex，显示状态
agent-history-rescue claude [opts]   # 找回 Claude Code 桌面端历史
agent-history-rescue codex  [opts]   # 诊断 / 修复 Codex 桌面端历史
```

**Claude（`agent-history-rescue claude ...`）**

| Option | 作用 |
|---|---|
| `--list`, `-l` | 列出 workspace 和对话，**只看不改** |
| `--dry-run`, `-n` | 预览迁移计划，不改文件 |
| `--yes`, `-y` | 跳过确认（仍会备份） |
| `--restore <dir>` | 从备份目录还原 |
| `--sessions-dir <path>` | 指定非默认的 `claude-code-sessions` 路径 |
| `--force` | 跳过"桌面端开着"检查（高级） |

**Codex（`agent-history-rescue codex ...`）**

| Option | 作用 |
|---|---|
| `--dry-run`, `-n` | 只诊断（默认，只看不改） |
| `--apply` | 动手修复（先备份到 `~/.codex/backups/`） |
| `--unarchive` | 同时把归档的会话恢复到侧栏 |
| `--restore <dir>` | 从备份目录还原 |
| `--target-provider <id>` | 指定要显示的 provider |
| `--source-provider <id>` | 指定要迁移的旧 provider（可重复） |
| `--force` | 跳过"应用开着"检查（高级） |

> Codex 修复需要 PATH 里有 `python3`（3.8+）。配置文件 provider 别名那一步需要 Python 3.11+；没有也不影响，SQLite + JSONL 的核心改写照常生效。

---

## 安全设计 How it stays safe

这个工具会动到桌面端自己的文件，所以两个后端都被故意做得很保守：

- **操作前先备份。** Claude 备份到 `~/.agent-history-rescue/backups/`，Codex 备份到 `~/.codex/backups/`，再动手。
- **不删对话内容。** Claude 只**复制**指针文件；Codex 只**改** provider 标记和归档状态，从不碰你的聊天正文。
- **App 开着就停下**，不跟桌面端抢着写（诊断除外，诊断只看不改）。
- **跑几遍都安全。** 第二遍发现没什么可改，什么都不动。
- **一条命令还原。** `claude --restore <dir>` 或 `codex --restore <dir>` 把一切退回去。
- **代码你自己就能看懂。** Claude 逻辑就一个文件 [`bin/agent-history-rescue.js`](bin/agent-history-rescue.js)，Codex 逻辑就一个文件 [`scripts/repair_codex_history.py`](scripts/repair_codex_history.py)，不装任何第三方包。

---

## 常见问题 FAQ

**换账号 / 换 provider 会删掉我的历史吗？**
不会。Claude 的对话本身在 `~/.claude/projects/`，Codex 的会话在 `~/.codex`，都还在磁盘上。消失的只是桌面端按账号 / provider 过滤之后，你能看到的那个列表。

**Codex 的历史为什么换 provider 就不见了？**
Codex 侧栏只显示当前 `model_provider` 的会话。你换了账号、API 或自定义 provider 名后，旧会话还带着旧 provider 标记，就被挡掉了。本工具把旧标记改成当前 provider，它们就回来了。

**Codex 归档的会话也能找回吗？**
能。`codex --apply --unarchive` 会把归档的会话恢复到正常侧栏。

**安全吗？会不会弄坏数据？**
操作前自动备份、只改列表和标记不碰聊天正文、App 开着就停下、可一键还原。两边的核心代码各自就一个文件，你自己就能看懂。

**Codex 修复一定要装 Python 吗？**
要 `python3`（3.8+，macOS / Linux 一般自带）。Claude 那一侧完全不需要 Python。

**我只想读某条旧对话，不依赖桌面端呢？**
Claude 终端里 `claude --resume` 选会话即可；Codex 的会话对应 `~/.codex/sessions/` 下的 `.jsonl`，可直接打开。

---

## English

Switched accounts, switched API provider, reinstalled, or upgraded, and your Claude Code or
Codex conversations vanished? **They are not deleted.** `agent-history-rescue` is a Node CLI
that brings them back. It supports two agents, each of which goes missing for a different reason:

- **Claude Code** keeps the conversations themselves in `~/.claude/projects/` (never tied to an
  account) and a desktop "Recents" list made of small pointer files, grouped per account.
  Switching accounts opens a fresh empty workspace, so old conversations stop showing. Fix: copy
  the pointer files into the current workspace. Native Node, fs only.
- **Codex** keeps threads in `~/.codex` (`state*.sqlite` + rollout JSONL). The sidebar only shows
  threads for the current `model_provider` and hides archived ones, so switching account / API
  provider / custom provider name makes old threads drop out. Fix: change the provider tag in the
  SQLite threads table and the JSONL session line, and optionally unarchive. Bundled Python script
  (stdlib sqlite3 + json, Python 3.8+).

```bash
# See which agents are installed and how much history each has (look, don't change)
npx -y github:HeiGeAi/agent-history-rescue

# Claude Code: quit the desktop app, then
npx -y github:HeiGeAi/agent-history-rescue claude

# Codex: diagnose (look, don't change), then quit Codex and apply
npx -y github:HeiGeAi/agent-history-rescue codex
npx -y github:HeiGeAi/agent-history-rescue codex --apply --unarchive
```

**Safety:** backs up before every change, only copies pointer files or changes provider tags
(never deletes your conversations), stops if the app is open, does nothing on a second run, and
rolls back with `--restore`. Zero third-party dependencies. Use at your own risk and keep the
backup until you've confirmed your history is back.

**FAQ**

- **Did switching accounts or providers delete my history?** No. Claude conversations live in
  `~/.claude/projects/`, Codex threads in `~/.codex`; only the on-screen list is filtered.
- **Why did Codex history vanish after I changed provider?** The sidebar only shows the current
  `model_provider`; old threads keep the old tag and get hidden. This changes the tag back.
- **Can I get Codex archived threads back?** Yes: `codex --apply --unarchive`.
- **Is it safe?** Backs up first, only touches the list and the provider tags, never deletes your
  conversations, one-command rollback.
- **Do I need Python?** Only for the Codex side (`python3` 3.8+). The Claude side needs none.

---

## 致谢 Credits

由 [HeiGeAi](https://github.com/HeiGeAi) 在换账号丢了几百条 Claude Code 对话、又把它们找回来之后做成工具，后来加上了 Codex 的支持。开源出来，省得你再踩一遍坑。

Built by [HeiGeAi](https://github.com/HeiGeAi) after losing, and recovering, a few hundred Claude
Code conversations to an account switch, then extended to cover Codex. Shared so you don't have to
figure it out the hard way.

## 许可证 License

[MIT](LICENSE)，随便用、随便改、随便分享。Copyright © 2026 HeiGeAi (Blake Xu).

> 它在每次改动前都会备份、且从不删除你的对话内容，但毕竟会碰桌面端自己的文件。**确认历史回来之前，先留着备份。**
