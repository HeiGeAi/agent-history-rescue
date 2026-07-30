#!/usr/bin/env node
'use strict';

/*
 * agent-history-rescue
 * Bring back coding-agent conversations that "disappeared" after switching
 * accounts, providers, reinstalling, or upgrading. Supports two agents today:
 *
 *   claude  - Claude Code desktop history that vanished after an account switch.
 *             The transcripts live in ~/.claude/projects/ (never tied to an
 *             account); the desktop "Recents" index is grouped into per-account
 *             workspaces. Switching accounts opens a fresh empty workspace, so
 *             old conversations get hidden. Fix: copy the pointer files into the
 *             current workspace. Implemented natively here (Node, fs only).
 *
 *   codex   - Codex desktop sidebar history that vanished after switching
 *             account / API provider / custom provider name. The threads still
 *             exist in ~/.codex but the sidebar filters by the current
 *             model_provider and hides archived rows. Fix: rewrite the provider
 *             tag in the SQLite threads table + rollout/session-index JSONL, add provider
 *             aliases, optionally unarchive. Implemented in the bundled Python
 *             script (stdlib sqlite3 + json), invoked as a subprocess.
 *
 * Safety first, for both: always back up before touching anything, only ever
 * copy / rewrite structured metadata (never delete conversation content), refuse
 * to run while the app is open, and offer a one-command rollback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (no dependency). Disabled when not a TTY or NO_COLOR set.
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

function log(...a) { console.log(...a); }
function fail(msg) { console.error(red('Error: ') + msg); process.exit(1); }

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function fmtTime(ms) {
  if (!ms) return 'unknown';
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); } catch { return 'unknown'; }
}
function countJsonl(dir) {
  let n = 0;
  const walk = (d) => { for (const e of safeReaddir(d)) { const p = path.join(d, e); if (isDir(p)) walk(p); else if (e.endsWith('.jsonl')) n++; } };
  if (isDir(dir)) walk(dir);
  return n;
}

// Best-effort check whether a desktop app is running. Returns true / false / null.
function isAppRunning(appName) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', { encoding: 'utf8' });
      return new RegExp(`\\b${appName}\\.exe\\b`, 'i').test(out);
    }
    const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
    const re = new RegExp(`/${appName}(\\.app)?\\b|(^|/)${appName}$`);
    return out.split('\n').some((line) => re.test(line.trim()) || re.test(line));
  } catch {
    return null;
  }
}
const isClaudeRunning = () => isAppRunning('Claude');
const isCodexRunning = () => isAppRunning('Codex');

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${dim('[y/N]')} `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// ===========================================================================
// CLAUDE backend (native, fs only)
// ===========================================================================
function defaultClaudeDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}
function sessionsDirFrom(claudeDir) { return path.join(claudeDir, 'claude-code-sessions'); }
function cliProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }
function encodeCwd(cwd) { return cwd.replace(/[^a-zA-Z0-9]/g, '-'); }

// Layout: <sessionsDir>/<workspaceId>/<containerId>/local_*.json
function scanPointers(sessionsDir) {
  const pointers = [];
  if (!fs.existsSync(sessionsDir)) return pointers;
  for (const wsId of safeReaddir(sessionsDir)) {
    const wsPath = path.join(sessionsDir, wsId);
    if (!isDir(wsPath)) continue;
    for (const containerId of safeReaddir(wsPath)) {
      const containerPath = path.join(wsPath, containerId);
      if (!isDir(containerPath)) continue;
      for (const file of safeReaddir(containerPath)) {
        if (!/^local_.*\.json$/.test(file)) continue;
        const filePath = path.join(containerPath, file);
        const data = readJson(filePath);
        if (!data) continue;
        pointers.push({
          filePath, file, wsId, containerId, containerPath,
          cliSessionId: data.cliSessionId || '',
          cwd: data.cwd || data.originCwd || '(unknown)',
          title: data.title || '(untitled)',
          isArchived: !!data.isArchived,
          lastActivityAt: Number(data.lastActivityAt || data.createdAt || 0),
        });
      }
    }
  }
  return pointers;
}

let claudeSessionsDir; // resolved per run

function buildPlan(pointers, opts) {
  if (pointers.length === 0) return { groups: [], targetWorkspace: null };
  let targetWorkspace = opts.targetWorkspace;
  if (!targetWorkspace) {
    targetWorkspace = pointers.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a)).wsId;
  }
  const byCwd = new Map();
  for (const p of pointers) {
    if (!byCwd.has(p.cwd)) byCwd.set(p.cwd, []);
    byCwd.get(p.cwd).push(p);
  }
  const groups = [];
  for (const [cwd, list] of byCwd) {
    const inTarget = list.filter((p) => p.wsId === targetWorkspace);
    let targetContainerPath = null;
    let createdContainer = false;
    if (inTarget.length) {
      targetContainerPath = inTarget.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a)).containerPath;
    } else {
      targetContainerPath = path.join(claudeSessionsDir, targetWorkspace, crypto.randomUUID());
      createdContainer = true;
    }
    const seenCli = new Set(
      list.filter((p) => p.containerPath === targetContainerPath).map((p) => p.cliSessionId)
    );
    const alreadyThere = seenCli.size;
    const toMigrate = [];
    for (const p of list) {
      if (p.containerPath === targetContainerPath) continue;
      if (p.cliSessionId && seenCli.has(p.cliSessionId)) continue;
      if (p.cliSessionId) seenCli.add(p.cliSessionId);
      toMigrate.push(p);
    }
    if (toMigrate.length === 0) continue;
    groups.push({ cwd, targetContainerPath, createdContainer, toMigrate, alreadyThere });
  }
  return { groups, targetWorkspace };
}

function backupSessions(sessionsDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(os.homedir(), '.agent-history-rescue', 'backups', `claude-${stamp}`, 'claude-code-sessions');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(sessionsDir, dest, { recursive: true });
  return path.dirname(dest);
}

function restoreClaude(backupDir, sessionsDir) {
  const src = path.join(backupDir, 'claude-code-sessions');
  if (!fs.existsSync(src)) fail(`No claude-code-sessions found inside backup: ${backupDir}`);
  if (fs.existsSync(sessionsDir)) {
    const aside = `${sessionsDir}.replaced-${Date.now()}`;
    fs.renameSync(sessionsDir, aside);
    log(dim(`Current sessions moved aside to: ${aside}`));
  }
  fs.cpSync(src, sessionsDir, { recursive: true });
  log(green('Restore complete.') + ` Sessions restored from ${backupDir}`);
}

function claudeList(pointers) {
  if (pointers.length === 0) {
    log(yellow('No Claude Code desktop sessions found.'));
    log(dim(`Looked in: ${claudeSessionsDir}`));
    return;
  }
  const byWs = new Map();
  for (const p of pointers) {
    if (!byWs.has(p.wsId)) byWs.set(p.wsId, []);
    byWs.get(p.wsId).push(p);
  }
  const target = pointers.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a)).wsId;
  log(bold(`\nFound ${pointers.length} conversation(s) across ${byWs.size} workspace(s):\n`));
  for (const [wsId, list] of byWs) {
    list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const tag = wsId === target ? green('  <- most recent (your current account)') : '';
    const cwds = [...new Set(list.map((p) => p.cwd))];
    log(`${bold('workspace')} ${cyan(wsId)}  ${dim(list.length + ' conversations')}${tag}`);
    log(dim(`  projects: ${cwds.join(', ')}`));
    log(dim(`  latest:   ${fmtTime(list[0].lastActivityAt)}  "${list[0].title}"`));
    log('');
  }
}

async function claudeMigrate(pointers, flags) {
  if (pointers.length === 0) {
    log(yellow('No Claude Code desktop sessions found. Nothing to migrate.'));
    log(dim(`Looked in: ${claudeSessionsDir}`));
    return;
  }
  const plan = buildPlan(pointers, { targetWorkspace: flags.targetWorkspace });
  const totalToMigrate = plan.groups.reduce((n, g) => n + g.toMigrate.length, 0);
  log(bold('\nMigration plan'));
  log(`Target workspace (your current account): ${cyan(plan.targetWorkspace)}`);
  if (totalToMigrate === 0) {
    log(green('\nEverything is already visible under your current workspace. Nothing to do.'));
    return;
  }
  for (const g of plan.groups) {
    log(`\n  ${bold('Project')} ${g.cwd}`);
    log(`    ${green('+ ' + g.toMigrate.length)} conversation(s) will be surfaced` +
        (g.createdContainer ? dim('  (new container)') : dim(`  (${g.alreadyThere} already there)`)));
    for (const p of g.toMigrate.slice(0, 5)) log(dim(`      - ${p.title}`));
    if (g.toMigrate.length > 5) log(dim(`      ... and ${g.toMigrate.length - 5} more`));
  }
  let missing = 0;
  for (const g of plan.groups) {
    for (const p of g.toMigrate) {
      const tjson = path.join(cliProjectsDir(), encodeCwd(p.cwd), `${p.cliSessionId}.jsonl`);
      if (!fs.existsSync(tjson)) missing++;
    }
  }
  if (missing > 0) {
    log(yellow(`\nNote: ${missing} of these reference a transcript that was not found under ~/.claude/projects.`));
    log(dim('They will still be listed, but may not open. The rest are fine.'));
  }
  if (flags.dryRun) {
    log(yellow('\nDry run: no files were changed. Re-run without --dry-run to apply.'));
    return;
  }
  const running = isClaudeRunning();
  if (running === true && !flags.force) {
    fail('The Claude desktop app is running. Quit it completely, then run this again.\n' +
         '(If you are operating on a copy and know what you are doing, pass --force.)');
  } else if (running === true && flags.force) {
    log(yellow('\n--force: skipping the running-app safety check.'));
  } else if (running === null) {
    log(yellow('\nCould not verify whether the Claude desktop app is running.'));
    log('Please make sure it is fully quit before continuing.');
  }
  if (!flags.yes) {
    log('');
    const ok = await confirm(`Back up and migrate ${totalToMigrate} conversation(s)?`);
    if (!ok) { log('Aborted. No changes made.'); return; }
  }
  log(dim('\nBacking up...'));
  const backup = backupSessions(claudeSessionsDir);
  log(green('Backup saved: ') + backup);
  let copied = 0;
  for (const g of plan.groups) {
    fs.mkdirSync(g.targetContainerPath, { recursive: true });
    for (const p of g.toMigrate) {
      const dest = path.join(g.targetContainerPath, p.file);
      if (fs.existsSync(dest)) continue; // never overwrite
      fs.copyFileSync(p.filePath, dest);
      copied++;
    }
  }
  log(green(`\nDone. Surfaced ${copied} conversation(s) under your current account.`));
  log(bold('\nNext step:'));
  log('  1. Open the Claude desktop app (signed in to your current account).');
  log('  2. Open the same project and check Recents -- your history should be back.');
  log(dim(`\nIf anything looks wrong, roll back with:`));
  log(dim(`  agent-history-rescue claude --restore "${backup}"`));
  log(dim('If they still do not appear, the desktop app may have cached an empty list; see the README.'));
}

function parseClaudeFlags(argv) {
  const flags = { dryRun: false, yes: false, list: false, restore: null, sessionsDir: null, targetWorkspace: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--list' || a === '-l') flags.list = true;
    else if (a === '--restore') flags.restore = argv[++i];
    else if (a === '--sessions-dir') flags.sessionsDir = argv[++i];
    else if (a === '--target-workspace') flags.targetWorkspace = argv[++i];
    else if (a === '--help' || a === '-h') { printClaudeHelp(); process.exit(0); }
    else fail(`Unknown claude option: ${a}  (try: agent-history-rescue claude --help)`);
  }
  return flags;
}

async function runClaude(argv) {
  const flags = parseClaudeFlags(argv);
  const claudeDir = flags.sessionsDir ? path.dirname(flags.sessionsDir) : defaultClaudeDir();
  claudeSessionsDir = flags.sessionsDir || sessionsDirFrom(claudeDir);
  if (flags.restore) {
    const running = isClaudeRunning();
    if (running === true && !flags.force) fail('Quit the Claude desktop app before restoring. (Pass --force to override.)');
    restoreClaude(flags.restore, claudeSessionsDir);
    return;
  }
  if (!fs.existsSync(claudeSessionsDir)) {
    log(yellow('Could not find the Claude desktop sessions directory.'));
    log(dim(`Looked in: ${claudeSessionsDir}`));
    log(dim('If your Claude desktop app stores data elsewhere, pass --sessions-dir <path>.'));
    return;
  }
  const pointers = scanPointers(claudeSessionsDir);
  if (flags.list) { claudeList(pointers); return; }
  await claudeMigrate(pointers, flags);
}

// ===========================================================================
// CODEX backend (bundled Python script, stdlib only)
// ===========================================================================
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env ? path.resolve(env.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), '.codex');
}
function codexScriptPath() { return path.join(__dirname, '..', 'scripts', 'repair_codex_history.py'); }
function pythonCmd() {
  for (const cmd of ['python3', 'python']) {
    try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return cmd; } catch { /* keep trying */ }
  }
  return null;
}
function runPython(py, args) {
  const r = spawnSync(py, args, { stdio: 'inherit' });
  if (r.error) fail(`Failed to run python: ${r.error.message}`);
  if (typeof r.status === 'number' && r.status !== 0) process.exitCode = r.status;
}

function restoreCodex(backupDir, home) {
  if (!isDir(backupDir)) fail(`Backup directory not found: ${backupDir}`);
  let restored = 0;
  for (const f of safeReaddir(backupDir)) {
    const src = path.join(backupDir, f);
    if (f === 'rollout-jsonl' || isDir(src)) continue;
    fs.copyFileSync(src, path.join(home, f)); // config.toml and the state*.sqlite
    restored++;
  }
  const rj = path.join(backupDir, 'rollout-jsonl');
  if (isDir(rj)) { fs.cpSync(rj, home, { recursive: true, force: true }); restored++; }
  log(green('Codex restore complete.') + ` Restored ${restored} item(s) from ${backupDir}`);
  log(dim('Restart Codex desktop to pick up the restored state.'));
}

async function runCodex(argv) {
  const f = { apply: false, unarchive: false, force: false, yes: false, codexHome: null, targetProvider: null, sources: [], restore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') f.apply = true;
    else if (a === '--dry-run' || a === '-n' || a === '--list' || a === '-l') f.apply = false;
    else if (a === '--unarchive') f.unarchive = true;
    else if (a === '--force') f.force = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--codex-home') f.codexHome = argv[++i];
    else if (a === '--target-provider') f.targetProvider = argv[++i];
    else if (a === '--source-provider') f.sources.push(argv[++i]);
    else if (a === '--restore') f.restore = argv[++i];
    else if (a === '--help' || a === '-h') { printCodexHelp(); return; }
    else fail(`Unknown codex option: ${a}  (try: agent-history-rescue codex --help)`);
  }

  if (f.restore) {
    const running = isCodexRunning();
    if (running === true && !f.force) fail('Quit the Codex desktop app before restoring. (Pass --force to override.)');
    restoreCodex(f.restore, f.codexHome ? path.resolve(f.codexHome) : codexHome());
    return;
  }

  const py = pythonCmd();
  if (!py) fail('python3 was not found. Codex repair needs Python 3.8+ in your PATH.\n' +
                'Install it (e.g. "brew install python" on macOS) and try again. The Claude side needs no Python.');
  const script = codexScriptPath();
  if (!fs.existsSync(script)) fail(`Bundled Codex script is missing: ${script}`);

  const passthru = [];
  if (f.codexHome) passthru.push('--codex-home', f.codexHome);
  if (f.targetProvider) passthru.push('--target-provider', f.targetProvider);
  for (const s of f.sources) passthru.push('--source-provider', s);

  if (!f.apply) {
    runPython(py, [script, '--dry-run', ...passthru]);
    log(dim('\nThis was a read-only diagnosis. To repair, quit Codex then run:'));
    log(dim('  agent-history-rescue codex --apply --unarchive'));
    return;
  }

  const running = isCodexRunning();
  if (running === true && !f.force) {
    fail('The Codex desktop app is running. Quit it completely, then run this again. (Pass --force to override.)');
  } else if (running === null) {
    log(yellow('Could not verify whether the Codex desktop app is running. Make sure it is fully quit.'));
  }
  if (!f.yes) {
    const ok = await confirm('Repair Codex history now? A full backup is made first.');
    if (!ok) { log('Aborted. No changes made.'); return; }
  }
  const applyArgs = [script, '--apply', ...passthru];
  if (f.unarchive) applyArgs.push('--unarchive');
  runPython(py, applyArgs);
  log(dim('\nBackups are under ~/.codex/backups/. Restart Codex desktop if the sidebar does not refresh.'));
}

// ===========================================================================
// IMPORT backend: recover from an exported data archive (e.g. after a ban)
// ===========================================================================
// Turns an official Claude data export (the zip you get from "Export data")
// into three things: a human/agent-readable archive, restored Claude Code
// conversations, and restored Codex conversations. Everything is local; nothing
// is ever uploaded.

function slugify(s, n = 48) {
  return (s || '').replace(/[\/\\:*?"<>| .-]/g, ' ').replace(/\s+/g, '-')
    .replace(/^[-.]+|-+$/g, '').slice(0, n).replace(/^[-.]+/, '') || 'untitled';
}
function pad4(i) { return String(i).padStart(4, '0'); }

// Temp paths to best-effort clean up, including on Ctrl-C (they may hold content).
const _tempPaths = new Set();
function cleanupTemps() { for (const p of _tempPaths) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } } }
process.on('SIGINT', () => { cleanupTemps(); process.exit(130); });
process.on('SIGTERM', () => { cleanupTemps(); process.exit(143); });

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('unzip', ['-oq', zipPath, '-d', destDir], { stdio: 'ignore' });
  if (r.status === 0) return true;
  r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
  if (r.status === 0) return true;
  if (process.platform === 'win32') {
    const z = zipPath.replace(/'/g, "''"), d = destDir.replace(/'/g, "''");
    r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${z}' -DestinationPath '${d}' -Force`], { stdio: 'ignore' });
    if (r.status === 0) return true;
  }
  return false;
}

// Find the directory that actually holds conversations.json (bounded recursive search).
function findExportRoot(dir, depth = 3) {
  if (fs.existsSync(path.join(dir, 'conversations.json'))) return dir;
  if (depth <= 0) return null;
  for (const e of safeReaddir(dir)) {
    if (e === '__MACOSX') continue;
    const p = path.join(dir, e);
    if (isDir(p)) { const found = findExportRoot(p, depth - 1); if (found) return found; }
  }
  return null;
}

function convFromWeb(item) {
  const messages = [];
  for (const m of item.chat_messages || []) {
    if (!m) continue;
    const role = m.sender === 'human' ? 'user' : 'assistant';
    let text = m.text || '';
    if ((!text || !text.trim()) && Array.isArray(m.content)) {
      text = m.content.map((c) => c && c.text).filter(Boolean).join('\n\n');
    }
    messages.push({ role, text, timestamp: m.created_at || item.created_at });
  }
  return {
    id: item.uuid, title: item.name || '(untitled)', createdAt: item.created_at,
    updatedAt: item.updated_at, summary: item.summary || '', source: 'claude-web', messages,
  };
}
function convFromDesign(d) {
  const messages = [];
  for (const m of d.messages || []) {
    if (!m) continue;
    const c = (m && m.content) || {};
    const role = (m.role || c.role) === 'human' ? 'user' : 'assistant';
    const text = (typeof c.content === 'string') ? c.content : (m.text || '');
    messages.push({ role, text, timestamp: m.created_at || d.created_at });
  }
  return {
    id: d.uuid, title: d.title || '(untitled)', createdAt: d.created_at,
    updatedAt: d.updated_at, summary: '', source: 'claude-artifacts', messages,
  };
}

function parseClaudeExport(root) {
  const model = { conversations: [], projects: [], memory: null };
  const conv = readJson(path.join(root, 'conversations.json'));
  if (Array.isArray(conv)) for (const it of conv) model.conversations.push(convFromWeb(it));
  const dcDir = path.join(root, 'design_chats');
  if (isDir(dcDir)) {
    for (const f of safeReaddir(dcDir)) {
      if (!f.endsWith('.json')) continue;
      const d = readJson(path.join(dcDir, f));
      if (d && Array.isArray(d.messages) && d.messages.length) model.conversations.push(convFromDesign(d));
    }
  }
  const pjDir = path.join(root, 'projects');
  if (isDir(pjDir)) {
    for (const f of safeReaddir(pjDir)) {
      if (!f.endsWith('.json')) continue;
      const p = readJson(path.join(pjDir, f));
      if (p) model.projects.push(p);
    }
  }
  const mem = readJson(path.join(root, 'memories.json'));
  if (Array.isArray(mem) && mem.length) model.memory = mem[0];
  // Sort conversations oldest-first for stable numbering.
  model.conversations.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return model;
}

function conversationToMarkdown(conv) {
  const out = [`# ${conv.title}`, ''];
  out.push(`- source: ${conv.source}`);
  if (conv.createdAt) out.push(`- created: ${conv.createdAt}`);
  if (conv.updatedAt) out.push(`- updated: ${conv.updatedAt}`);
  out.push(`- id: ${conv.id}`, '');
  if (conv.summary) out.push(`> ${conv.summary.replace(/\n/g, ' ')}`, '');
  out.push('---', '');
  for (const m of conv.messages) {
    const who = m.role === 'user' ? '🧑 User' : '🤖 Assistant';
    const ts = m.timestamp ? `  _(${m.timestamp})_` : '';
    out.push(`## ${who}${ts}`, '', (m.text || '').trim() || '_(empty)_', '');
  }
  return out.join('\n');
}

function writeAgentArchive(model, outDir) {
  // The archive holds full conversation content, so keep it owner-only.
  const F = { mode: 0o600 };
  const convDir = path.join(outDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true, mode: 0o700 });
  const indexLines = [];
  const jsonl = [];
  model.conversations.forEach((conv, i) => {
    const base = `${pad4(i + 1)}-${slugify(conv.title)}.md`;
    fs.writeFileSync(path.join(convDir, base), conversationToMarkdown(conv), F);
    indexLines.push(`- [${conv.title}](conversations/${base})  _(${conv.source}, ${conv.messages.length} msgs)_`);
    jsonl.push(JSON.stringify(conv));
  });
  fs.writeFileSync(path.join(outDir, 'conversations.jsonl'), jsonl.join('\n') + '\n', F);
  // Projects and memory, for reference.
  if (model.projects.length) {
    const pdir = path.join(outDir, 'projects');
    fs.mkdirSync(pdir, { recursive: true, mode: 0o700 });
    model.projects.forEach((p, i) => {
      const lines = [`# ${p.name || 'project'}`, '', p.description || '', ''];
      for (const doc of p.docs || []) lines.push(`## ${doc.filename || 'doc'}`, '', doc.content || '', '');
      fs.writeFileSync(path.join(pdir, `${pad4(i + 1)}-${slugify(p.name || p.uuid)}.md`), lines.join('\n'), F);
    });
  }
  if (model.memory) {
    const lines = ['# Memory', '', model.memory.conversations_memory || ''];
    for (const [k, v] of Object.entries(model.memory.project_memories || {})) lines.push('', `## project ${k}`, '', String(v));
    fs.writeFileSync(path.join(outDir, 'memory.md'), lines.join('\n'), F);
  }
  const readme = [
    '# Recovered conversation archive',
    '',
    `Recovered by agent-history-rescue. ${model.conversations.length} conversation(s).`,
    '',
    'Point any AI agent (or yourself) at this folder to read the full history.',
    'Machine-readable copy: `conversations.jsonl` (one conversation per line).',
    '',
    '## Conversations',
    ...indexLines,
  ];
  fs.writeFileSync(path.join(outDir, 'README.md'), readme.join('\n'), F);
  return model.conversations.length;
}

// Build a Claude Code transcript (resumable jsonl) from a normalized conversation.
function conversationToClaudeTranscript(conv, sessionId, cwd) {
  const lines = [];
  const nowIso = (t) => {
    for (const cand of [t, conv.createdAt]) {
      if (cand) { const d = new Date(cand); if (Number.isFinite(d.getTime())) return d.toISOString(); }
    }
    return new Date().toISOString();
  };
  lines.push({ type: 'ai-title', aiTitle: conv.title, sessionId });
  let parent = null;
  for (const m of conv.messages) {
    const uuid = crypto.randomUUID();
    const base = {
      parentUuid: parent, isSidechain: false, uuid, timestamp: nowIso(m.timestamp),
      sessionId, cwd, version: 'recovered', gitBranch: '', userType: 'external',
    };
    if (m.role === 'user') {
      lines.push({ ...base, type: 'user', message: { role: 'user', content: m.text || '' } });
    } else {
      lines.push({
        ...base, type: 'assistant',
        message: {
          model: 'claude-recovered', id: `msg_${uuid.replace(/-/g, '').slice(0, 20)}`, type: 'message',
          role: 'assistant', content: [{ type: 'text', text: m.text || '' }], stop_reason: 'end_turn',
        },
      });
    }
    parent = uuid;
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function restoreToClaude(conversations, flags) {
  const cwd = path.join(os.homedir(), 'recovered-claude-history');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
  const sessionsDir = sessionsDirFrom(defaultClaudeDir());
  const pointers = scanPointers(sessionsDir);
  let targetContainer = null;
  if (pointers.length) {
    const recent = pointers.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
    targetContainer = recent.containerPath;
  }
  log(bold('\nRestore into Claude Code'));
  log(`  ${conversations.length} conversation(s) -> ${dim(projectDir)}`);
  log(targetContainer
    ? `  desktop Recents pointers -> current workspace`
    : yellow('  no Claude desktop workspace found; transcripts are written but open the Claude app once to list them.'));
  if (flags.dryRun) { log(yellow('  (dry run: nothing written)')); return; }
  const running = isClaudeRunning();
  if (running === true && !flags.force) fail('The Claude desktop app is running. Quit it, then re-run (or pass --force).');
  else if (running === null) log(yellow('  Could not verify whether Claude is running; make sure it is fully quit.'));

  // Conversation ids come from an untrusted export; only use clean tokens as
  // filenames. For a bad id, derive a deterministic id from content (not random),
  // so re-running stays idempotent.
  const safeId = (conv) => {
    const raw = conv.id || '';
    if (/^[A-Za-z0-9._-]+$/.test(raw) && raw !== '.' && raw !== '..') return raw;
    return crypto.createHash('sha1').update(`${raw}|${conv.title || ''}|${conv.createdAt || ''}`).digest('hex');
  };
  const toMs = (v, fallback) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.getTime() : fallback; };

  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  let backup = null;
  if (targetContainer && fs.existsSync(sessionsDir)) backup = backupSessions(sessionsDir);
  // Existing pointers for this cwd, so a re-run does not duplicate conversations.
  const existingCli = new Set(scanPointers(sessionsDir).filter((p) => p.cwd === cwd).map((p) => p.cliSessionId));
  let n = 0, skipped = 0;
  for (const conv of conversations) {
    // Deterministic session id from the export's conversation uuid -> idempotent.
    const sessionId = safeId(conv);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const already = fs.existsSync(transcriptPath) || existingCli.has(sessionId);
    if (already) { skipped++; continue; }
    fs.writeFileSync(transcriptPath, conversationToClaudeTranscript(conv, sessionId, cwd));
    if (targetContainer) {
      const ms = toMs(conv.updatedAt, Date.now());
      const pointer = {
        sessionId: `local_${crypto.randomUUID()}`, cliSessionId: sessionId, cwd, originCwd: cwd,
        lastFocusedAt: ms, createdAt: toMs(conv.createdAt, ms), lastActivityAt: ms,
        model: 'claude-recovered', isArchived: false, title: conv.title, titleSource: 'auto',
      };
      fs.writeFileSync(path.join(targetContainer, `${pointer.sessionId}.json`), JSON.stringify(pointer));
    }
    n++;
  }
  log(green(`  Done. Wrote ${n} conversation(s) into Claude Code.`) + (skipped ? dim(`  (${skipped} already imported, skipped)`) : ''));
  if (backup) log(dim(`  Workspace backup: ${backup}  (claude --restore to roll back the pointers)`));
  log(dim(`  Recovered project lives at ${projectDir}`));
  log(dim(`  and ${cwd}; delete both to remove the recovered conversations.`));
  log(dim('  Open Claude Code, the recovered project shows up in Recents.'));
}

async function restoreToCodex(conversations, flags) {
  const py = pythonCmd();
  if (!py) fail('python3 was not found. Codex import needs Python 3.8+ in your PATH.');
  const script = path.join(__dirname, '..', 'scripts', 'import_to_codex.py');
  if (!fs.existsSync(script)) fail(`Bundled Codex import script is missing: ${script}`);
  const job = {
    codexHome: flags.codexHome || codexHome(),
    defaultProvider: flags.codexProvider || null, // null -> Python infers the current sidebar provider
    cwd: path.join(os.homedir(), 'recovered-codex-history'),
    conversations,
  };
  // The job file holds full conversation content; keep it owner-only in a private
  // temp dir, and register it for cleanup even on Ctrl-C.
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-codex-'));
  _tempPaths.add(jobDir);
  const jobPath = path.join(jobDir, 'job.json');
  fs.writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  try {
    log(bold('\nRestore into Codex'));
    if (flags.dryRun) { runPython(py, [script, jobPath]); return; }
    const running = isCodexRunning();
    if (running === true && !flags.force) fail('The Codex desktop app is running. Quit it, then re-run (or pass --force).');
    else if (running === null) log(yellow('Could not verify whether Codex is running; make sure it is fully quit.'));
    runPython(py, [script, jobPath, '--apply']);
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* ignore */ }
    _tempPaths.delete(jobDir);
  }
}

async function runImport(argv) {
  const f = { src: null, to: [], out: null, dryRun: false, yes: false, force: false, noArchive: false, codexProvider: null, codexHome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') { const v = argv[++i]; if (v === 'all') f.to = ['claude', 'codex']; else f.to.push(v); }
    else if (a === '--out') f.out = argv[++i];
    else if (a === '--dry-run' || a === '-n') f.dryRun = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--force') f.force = true;
    else if (a === '--no-archive') f.noArchive = true;
    else if (a === '--codex-provider') f.codexProvider = argv[++i];
    else if (a === '--codex-home') f.codexHome = argv[++i];
    else if (a === '--help' || a === '-h') { printImportHelp(); return; }
    else if (!a.startsWith('-') && !f.src) f.src = a;
    else fail(`Unknown import option: ${a}  (try: agent-history-rescue import --help)`);
  }
  if (!f.src) fail('Give the path to your export .zip (or its extracted folder).\n  agent-history-rescue import <export.zip> [--to claude|codex|all]');
  if (!fs.existsSync(f.src)) fail(`Not found: ${f.src}`);

  // Resolve a directory holding the export (extract the zip if needed).
  let workDir = f.src;
  let tempDir = null;
  if (!isDir(f.src)) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahr-import-'));
    _tempPaths.add(tempDir);
    log(dim('Extracting export archive...'));
    if (!extractZip(f.src, tempDir)) fail('Could not extract the zip. Install `unzip`, or extract it yourself and pass the folder.');
    workDir = tempDir;
  }
  try {
    const root = findExportRoot(workDir);
    if (!root) fail('This does not look like a Claude data export (no conversations.json found).');
    const model = parseClaudeExport(root);
    log(green(`Parsed export:`) + ` ${model.conversations.length} conversation(s), ${model.projects.length} project(s).`);
    if (model.conversations.length === 0) fail('No conversations found in the export.');

    if (!f.noArchive) {
      const outDir = f.out || path.join(os.homedir(), 'agent-history-rescue', 'imported', new Date().toISOString().replace(/[:.]/g, '-'));
      if (f.dryRun) {
        log(bold('\nAgent-readable archive') + dim(`  -> ${outDir}  (dry run: not written)`));
      } else {
        fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
        const n = writeAgentArchive(model, outDir);
        log(bold('\nAgent-readable archive') + green(`  ${n} conversation(s)`) + ` -> ${outDir}`);
        log(dim('  Point any AI agent at that folder, or open README.md / conversations.jsonl.'));
      }
    }

    if (f.to.includes('claude')) await restoreToClaude(model.conversations, f);
    if (f.to.includes('codex')) await restoreToCodex(model.conversations, f);

    if (f.to.length === 0 && !f.dryRun) {
      log(dim('\nTip: add --to claude or --to codex to also restore these into a desktop app.'));
    }
  } finally {
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } _tempPaths.delete(tempDir); }
  }
}

function printImportHelp() {
  log(`${bold('agent-history-rescue import')} - recover conversations from an exported data archive

  agent-history-rescue import <export.zip|folder> [options]

  Turns an official Claude data export (the zip from Settings > Privacy > Export data,
  useful after a ban / lockout) into a readable archive, and optionally restores the
  conversations into Claude Code and/or Codex. Everything is local; nothing is uploaded.

  --to claude|codex|all   Also restore into that desktop app (default: archive only)
  --out <dir>             Where to write the readable archive (default: ~/agent-history-rescue/imported/<ts>)
  --no-archive            Skip the readable archive (only restore into apps)
  -n, --dry-run           Show what would happen, write nothing
  -y, --yes               Skip confirmation
      --codex-provider <id>  Provider to tag restored Codex threads with (default: openai)
      --force             Skip the running-app safety check (advanced)

  The readable archive (always on by default) is the safe, universal output: a folder of
  Markdown plus conversations.jsonl that any AI agent or human can read. Restoring into an
  app quits-app-first, backs up first, only adds new entries, and never deletes anything.`);
}

// ===========================================================================
// Detection, dispatch, help
// ===========================================================================
function detectClaude() {
  const dir = sessionsDirFrom(defaultClaudeDir());
  if (!fs.existsSync(dir)) return null;
  const pointers = scanPointers(dir);
  return { dir, count: pointers.length, workspaces: new Set(pointers.map((p) => p.wsId)).size };
}
function detectCodex() {
  const home = codexHome();
  if (!fs.existsSync(home)) return null;
  const hasDb = safeReaddir(home).some((f) => /^state.*\.sqlite$/.test(f));
  const sessions = countJsonl(path.join(home, 'sessions'));
  const archived = countJsonl(path.join(home, 'archived_sessions'));
  if (!hasDb && sessions === 0 && archived === 0) return null;
  return { home, sessions, archived };
}

function printStatus() {
  const cl = detectClaude();
  const cx = detectCodex();
  log(bold('\nagent-history-rescue') + dim('  -  recover coding-agent history after switching accounts\n'));
  log(bold('Detected on this machine:'));
  if (cl) log(`  ${green('✓')} Claude Code  ${dim(`${cl.count} conversations across ${cl.workspaces} workspace(s)`)}`);
  else log(`  ${dim('-')} Claude Code  ${dim('not found')}`);
  if (cx) log(`  ${green('✓')} Codex        ${dim(`${cx.sessions} sessions, ${cx.archived} archived`)}`);
  else log(`  ${dim('-')} Codex        ${dim('not found')}`);
  log(bold('\nRun one of:'));
  log(`  ${cyan('agent-history-rescue claude')}   fix Claude Code desktop history`);
  log(`  ${cyan('agent-history-rescue codex')}    diagnose / fix Codex desktop history`);
  log(dim('\nAdd --list to inspect, --help for all options. Nothing is changed without your confirmation.'));
}

function printHelp() {
  log(`${bold('agent-history-rescue')} - recover coding-agent history after switching accounts, providers, or reinstalling

${bold('Usage')}
  agent-history-rescue                 Detect Claude Code & Codex and show status
  agent-history-rescue claude [opts]   Recover Claude Code desktop history
  agent-history-rescue codex  [opts]   Diagnose / repair Codex desktop history
  agent-history-rescue import <zip>    Recover from an exported data archive (e.g. after a ban)
  agent-history-rescue --help          This help

${bold('Import options')} (agent-history-rescue import <export.zip|folder> ...)
  --to claude|codex|all       Also restore the conversations into that desktop app
  --out <dir>                 Where to write the readable archive
  --no-archive                Only restore into apps, skip the readable archive
  -n, --dry-run               Show what would happen, write nothing
      --codex-provider <id>   Provider to tag restored Codex threads with (default: openai)
      --force                 Skip the running-app safety check (advanced)

${bold('Claude options')} (agent-history-rescue claude ...)
  -l, --list                  List workspaces and conversations (read-only)
  -n, --dry-run               Preview the migration plan, change nothing
  -y, --yes                   Skip the confirmation prompt (still backs up)
      --restore <backupDir>   Roll back a previous claude run
      --sessions-dir <path>   Override auto-detection of claude-code-sessions
      --target-workspace <id> Force which workspace to migrate into
      --force                 Skip the running-app safety check (advanced)

${bold('Codex options')} (agent-history-rescue codex ...)
  -n, --dry-run               Diagnose only (default; read-only)
      --apply                 Apply the repair (backs up first)
      --unarchive             Also restore archived threads to the sidebar
  -y, --yes                   Skip the confirmation prompt
      --codex-home <path>     Override CODEX_HOME / ~/.codex
      --target-provider <id>  Provider to make sidebar-visible
      --source-provider <id>  Provider to migrate (may repeat)
      --force                 Skip the running-app safety check (advanced)
  Note: Codex repair needs Python 3.8+ in PATH. The Claude side needs no Python.

${bold('Safety')}
  Your conversations are never deleted. Both backends back up before any change,
  refuse to run while the app is open, and can be rolled back.
  More detail: https://github.com/HeiGeAi/agent-history-rescue`);
}
function printClaudeHelp() {
  log(`${bold('agent-history-rescue claude')} - recover Claude Code desktop history

  -l, --list                  List workspaces and conversations (read-only)
  -n, --dry-run               Preview the migration plan, change nothing
  -y, --yes                   Skip confirmation (still backs up)
      --restore <backupDir>   Roll back a previous run
      --sessions-dir <path>   Override auto-detection of claude-code-sessions
      --target-workspace <id> Force which workspace to migrate into
      --force                 Skip the running-app safety check (advanced)

  Typical: quit the Claude desktop app, then run "agent-history-rescue claude".`);
}
function printCodexHelp() {
  log(`${bold('agent-history-rescue codex')} - diagnose / repair Codex desktop sidebar history

  -n, --dry-run               Diagnose only (default; read-only)
      --apply                 Apply the repair (backs up to ~/.codex/backups first)
      --unarchive             Also restore archived threads to the sidebar
  -y, --yes                   Skip confirmation
      --restore <backupDir>   Roll back a previous repair from its backup folder
      --codex-home <path>     Override CODEX_HOME / ~/.codex
      --target-provider <id>  Provider to make sidebar-visible
      --source-provider <id>  Provider to migrate (may repeat)
      --force                 Skip the running-app safety check (advanced)

  Needs Python 3.8+ in PATH. Typical: quit Codex, then
  "agent-history-rescue codex --apply --unarchive".`);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') { printHelp(); return; }
  if (first === '--version' || first === '-v') {
    const pkg = readJson(path.join(__dirname, '..', 'package.json')) || {};
    log(pkg.version || 'unknown');
    return;
  }
  if (first === 'claude') { await runClaude(argv.slice(1)); return; }
  if (first === 'codex') { await runCodex(argv.slice(1)); return; }
  if (first === 'import') { await runImport(argv.slice(1)); return; }
  if (!first || first === '--list' || first === '-l' || first === 'status') { printStatus(); return; }
  fail(`Unknown command: ${first}\nRun "agent-history-rescue --help", or pick a backend: "claude" or "codex".`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
