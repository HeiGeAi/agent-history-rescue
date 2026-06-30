# agent-history-rescue

<div align="center">

![version](https://img.shields.io/badge/version-3.0.0-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen.svg)
![supports](https://img.shields.io/badge/supports-Claude%20Code%20%7C%20Codex-7c3aed.svg)
![license](https://img.shields.io/badge/license-MIT-green.svg)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)

**Agent 历史救援 · 换账号、换 provider 或被封号后，找回 Claude Code 和 Codex 的对话 | Recover Claude Code & Codex history after switching accounts, providers, or a ban**

对话没丢，只是被挡在了外面，或者只剩一个导出包。这个工具把它们接回来。
Your conversations are not gone. This tool brings them back, even from just an export.

[症状](#你是否遇到这些-symptoms) • [这是什么](#这是什么-what-is-this) • [从导出包恢复](#从导出包恢复-recover-from-an-export) • [快速开始](#快速开始-quick-start) • [用法](#用法-usage) • [安全设计](#安全设计-how-it-stays-safe) • [常见问题](#常见问题-faq) • [English](#english)

</div>

---

## 你是否遇到这些 Symptoms

如果你正在搜下面任意一种情况，这个工具就是为你做的。**你的对话没有被删，只是被挡住、没显示出来，或者只剩一个官方导出包。**

**Claude Code**
- 换了 Claude 账号后，Claude Code 的历史对话**全没了**
- 升级或重装 Claude 桌面端后，Recents（最近对话）**变成空的**

**Codex**
- 换了账号或 API provider 后，Codex 侧栏的历史会话**不见了**
- 改了 `model_provider` / `base_url` / 自定义 provider 名后，旧会话从侧栏消失，归档的也找不到

**被封号 / 被锁号**
- 账号被封，登不进去了，**手里只有一个官方导出的 zip 数据包**
- 想把导出包里的对话**恢复到现在用的 Claude Code 或 Codex 对话框**里
- 想让现在用的 AI agent **读到这些旧对话的全部内容**，接着上下文干活

> In English: *"Claude Code history disappeared after switching accounts"*, *"Codex sidebar
> history missing after switching provider"*, *"my Claude account got banned, I only have the
> data export zip"*, *"how to import Claude data export into Claude Code / Codex"*, *"restore
> Claude conversations from export.zip"*, *"let my AI agent read my old Claude conversations"*.

---

## 这是什么 What is this

一个**Node 命令行工具**，把被挡住、没显示的对话重新接回你当前的桌面端。它有两种用法：

1. **就地找回**（`claude` / `codex`）：换账号、换 provider 后对话还在本机、只是被过滤掉了，把它们接回当前桌面端。
2. **从导出包恢复**（`import`）：账号被封、本机数据没了，只剩一个官方导出 zip，从里面重建对话，恢复进当前的 Claude Code / Codex，并生成一份任何 AI agent 都能读的存档。

就地找回的原理（两个 agent 不一样）：

| | **Claude Code** | **Codex** |
|---|---|---|
| 对话存哪 | 对话本身在 `~/.claude/projects/*.jsonl`；桌面端那份列表是 `claude-code-sessions/<workspace>/` 里的小指针文件 | 会话在 `~/.codex` 的 `state*.sqlite` + `sessions/*.jsonl` 里 |
| 为什么消失 | 桌面端 workspace **按账号分开存**，换账号后开了个空 workspace，旧指针进不来 | 侧栏**只显示当前 `model_provider` 的会话**，换 provider 后旧会话被挡掉；归档的也不显示 |
| 怎么修 | 把旧指针**复制**进当前账号的 workspace | 把 threads 表 + JSONL 里的旧 provider **改成**当前 provider，需要的话取消归档 |

---

## 从导出包恢复 Recover from an export

账号被封、登不进去，但你之前从 Settings > Privacy > Export data 导出过一个 zip？把它喂给 `import`，一条命令产出三样东西：

```bash
# 看一眼里面有多少对话（只读，不写任何东西）
npx -y github:HeiGeAi/agent-history-rescue import ~/Downloads/data-xxxx.zip --dry-run

# 生成一份"谁都能读"的存档（默认就做这件事）
npx -y github:HeiGeAi/agent-history-rescue import ~/Downloads/data-xxxx.zip

# 顺便恢复进当前的 Claude Code 和 / 或 Codex 对话框
npx -y github:HeiGeAi/agent-history-rescue import ~/Downloads/data-xxxx.zip --to claude
npx -y github:HeiGeAi/agent-history-rescue import ~/Downloads/data-xxxx.zip --to codex
npx -y github:HeiGeAi/agent-history-rescue import ~/Downloads/data-xxxx.zip --to all
```

产出的三样东西：

- **① agent 可读存档**（默认）：一个文件夹，里面每个对话一份 Markdown，外加一个 `conversations.jsonl`（一行一个对话，机器好读）。**把这个文件夹丢给任何 AI agent，它就能读到你全部旧对话的内容**，接着上下文干活；你自己也能直接翻。
- **② 恢复进 Claude Code**（`--to claude`）：把每个对话重建成 Claude Code 认的存档，放进一个 `recovered-claude-history` 项目，并在当前账号的 Recents 里列出来，能点开接着聊。
- **③ 恢复进 Codex**（`--to codex`）：把每个对话写成 Codex 的会话文件，并在侧栏列出来（自动用你当前的 provider 标记，不然又会被过滤掉）。

全程在你电脑本地跑，**任何内容都不会上传**。重复跑同一个包不会产生重复对话。

---

## 快速开始 Quick start

需要 [Node.js](https://nodejs.org) 16 以上（你能跑 Claude Code / Codex 就一定有）。Codex 那部分额外需要 `python3`（3.8+），Claude 那部分不需要。

```bash
# 看看本机装了哪些 agent、各有多少历史（只看不改）
npx -y github:HeiGeAi/agent-history-rescue

# 就地找回：先退出对应 App，再跑
npx -y github:HeiGeAi/agent-history-rescue claude
npx -y github:HeiGeAi/agent-history-rescue codex --apply --unarchive

# 从导出包恢复
npx -y github:HeiGeAi/agent-history-rescue import <export.zip> --to all
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
agent-history-rescue                       # 检测 Claude Code 与 Codex，显示状态
agent-history-rescue claude [opts]         # 就地找回 Claude Code 桌面端历史
agent-history-rescue codex  [opts]         # 诊断 / 修复 Codex 桌面端历史
agent-history-rescue import <zip> [opts]   # 从导出包恢复（封号后用）
```

**import（`agent-history-rescue import <export.zip|folder> ...`）**

| Option | 作用 |
|---|---|
| `--to claude\|codex\|all` | 同时恢复进对应 App（默认只生成可读存档） |
| `--out <dir>` | 可读存档写到哪（默认 `~/agent-history-rescue/imported/<时间戳>`） |
| `--no-archive` | 不生成可读存档，只恢复进 App |
| `--dry-run`, `-n` | 只看会做什么，不写任何文件 |
| `--codex-provider <id>` | 恢复进 Codex 时给对话标的 provider（默认自动探测当前的） |
| `--force` | 跳过"App 开着"检查（高级） |

Claude 和 Codex 的就地找回选项见 `agent-history-rescue claude --help` 和 `codex --help`。

---

## 安全设计 How it stays safe

这个工具会动到桌面端自己的文件，所以做得很保守：

- **操作前先备份。** 改 Claude 桌面端列表前备份到 `~/.agent-history-rescue/backups/`，改 Codex 数据库前备份到 `~/.codex/backups/`。
- **不删、不覆盖。** 就地找回只复制 / 改标记；从导出包恢复只**新增**对话，从不动你已有的对话。
- **App 开着就停下**，不跟桌面端抢着写（只读诊断除外）。
- **跑两遍不翻倍。** 已经处理过的会自动跳过。
- **一条命令还原。** `claude --restore <dir>` / `codex --restore <dir>` 把就地找回退回去；从导出包恢复也会打印备份位置和回滚办法。
- **导出包只在本地处理，绝不上传。**
- **代码你自己就能看懂。** Claude 逻辑在 [`bin/agent-history-rescue.js`](bin/agent-history-rescue.js)，Codex 改库在 [`scripts/repair_codex_history.py`](scripts/repair_codex_history.py)、导出恢复在 [`scripts/import_to_codex.py`](scripts/import_to_codex.py)，不装任何第三方包。

---

## 常见问题 FAQ

**账号被封了，本机也没数据了，只有一个导出 zip，能救吗？**
能，这就是 `import` 的用途。它从 zip 里重建对话，生成一份可读存档，还能恢复进你现在用的 Claude Code / Codex。

**导出包能恢复成"能接着聊"的对话吗？**
能。`--to claude` 会把对话重建成 Claude Code 认的存档并在 Recents 里列出来；`--to codex` 写成 Codex 会话在侧栏列出来。注意这些是网页对话搬过来的，没有当时的工具调用记录，但文字内容完整。

**怎么让我现在的 AI agent 读到这些旧对话？**
`import` 默认生成的那个文件夹就是给 agent 读的：里面有每个对话的 Markdown 和一个 `conversations.jsonl`。把文件夹路径告诉你的 agent 即可。

**换账号 / 换 provider 会删掉我的历史吗？**
不会。Claude 的对话本身在 `~/.claude/projects/`，Codex 的会话在 `~/.codex`，都还在磁盘上。消失的只是桌面端过滤之后你能看到的那个列表。

**安全吗？会不会弄坏数据？**
操作前自动备份、只新增不删除、App 开着就停下、可还原、内容不上传。核心代码各自就一个文件，你自己就能看懂。

**Codex 那部分一定要装 Python 吗？**
要 `python3`（3.8+，macOS / Linux 一般自带）。Claude 那部分和导出包的可读存档都不需要 Python。

---

## English

`agent-history-rescue` recovers coding-agent conversations two ways:

1. **In place** (`claude` / `codex`): after switching accounts or providers the conversations are
   still on your machine, just filtered out of the desktop view. This puts them back.
2. **From an export** (`import`): if your account was banned and all you have left is the official
   data-export zip, it rebuilds the conversations from that zip, restores them into your current
   Claude Code / Codex, and writes an archive any AI agent can read.

```bash
# Status of both agents (look, don't change)
npx -y github:HeiGeAi/agent-history-rescue

# In place: quit the app first, then
npx -y github:HeiGeAi/agent-history-rescue claude
npx -y github:HeiGeAi/agent-history-rescue codex --apply --unarchive

# From a data export (e.g. after a ban)
npx -y github:HeiGeAi/agent-history-rescue import <export.zip> --to all
```

`import` produces three things: (1) an **agent-readable archive** by default (a folder of Markdown
plus `conversations.jsonl` that any AI agent or human can read), (2) **restored Claude Code**
transcripts that show up in Recents (`--to claude`), and (3) **restored Codex** threads that show
up in the sidebar (`--to codex`, tagged with your current provider so they are not filtered out).
Everything runs locally; nothing is uploaded. Re-running on the same export does not create
duplicates.

**Safety:** backs up before touching app data, only adds new entries (never deletes or
overwrites), stops if the app is open, can be rolled back, and never uploads your export. Zero
third-party dependencies. Use at your own risk and keep the backup until you've confirmed your
history is back.

**FAQ**

- **My account got banned and I only have the export zip. Can I recover?** Yes, that is what
  `import` is for.
- **Can I make the recovered conversations resumable?** Yes: `--to claude` lists them in Recents,
  `--to codex` lists them in the sidebar. They carry the full text (no original tool calls).
- **How does my current AI agent read the old conversations?** Point it at the folder `import`
  writes by default (Markdown + `conversations.jsonl`).
- **Did switching accounts delete my history?** No. Only the on-screen list is filtered.
- **Do I need Python?** Only for the Codex parts (`python3` 3.8+). Claude and the readable archive
  need none.

---

## 致谢 Credits

由 [HeiGeAi](https://github.com/HeiGeAi) 在换账号丢了几百条 Claude Code 对话、又把它们找回来之后做成工具，后来加上了 Codex 支持和从导出包恢复。开源出来，省得你再踩一遍坑。

Built by [HeiGeAi](https://github.com/HeiGeAi) after losing, and recovering, a few hundred Claude
Code conversations to an account switch, then extended to cover Codex and recovery from a data
export. Shared so you don't have to figure it out the hard way.

## 许可证 License

[MIT](LICENSE)，随便用、随便改、随便分享。Copyright © 2026 HeiGeAi (Blake Xu).

> 它在每次改动前都会备份、且从不删除你的对话内容，但毕竟会碰桌面端自己的文件。**确认历史回来之前，先留着备份。**
