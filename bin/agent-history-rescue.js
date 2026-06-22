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
 *             tag in the SQLite threads table + rollout JSONL, add provider
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
  agent-history-rescue --help          This help

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
  if (!first || first === '--list' || first === '-l' || first === 'status') { printStatus(); return; }
  fail(`Unknown command: ${first}\nRun "agent-history-rescue --help", or pick a backend: "claude" or "codex".`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
