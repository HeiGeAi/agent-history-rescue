#!/usr/bin/env node
'use strict';

/*
 * claude-history-rescue
 * Bring back Claude Code conversations that "disappeared" from the Claude
 * desktop app after switching accounts, reinstalling, or upgrading.
 *
 * Why your history is not actually lost
 * -------------------------------------
 * Claude Code keeps two separate stores on your machine:
 *   1. The real transcripts (the actual conversations) live as JSONL files in
 *        ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
 *      These are NOT tied to any account. Switching accounts never deletes them.
 *   2. The desktop app keeps tiny ~600-byte "pointer" files in
 *        <AppData>/Claude/claude-code-sessions/<workspaceId>/<containerId>/local_*.json
 *      Each pointer just references a transcript via its `cliSessionId`. The
 *      desktop "Recents" list is built from these pointers, and the pointers are
 *      grouped into workspaces that are scoped PER ACCOUNT.
 *
 * So when you switch accounts, the desktop app opens a brand-new empty workspace
 * for the new account, and your old pointers stay locked in the old account's
 * workspace -> the history "vanishes" even though every transcript is still on
 * disk. This tool copies those pointers into your current workspace so the
 * desktop app lists them again under the account you use now.
 *
 * Safety first: it always makes a full backup before touching anything, it only
 * ever COPIES pointer files (never deletes), and `--restore` rolls everything
 * back. Zero dependencies, just Node's standard library.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Tiny ANSI helpers (no dependency). Disabled when not a TTY or NO_COLOR set.
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

function log(...a) { console.log(...a); }
function fail(msg) { console.error(red('Error: ') + msg); process.exit(1); }

// ---------------------------------------------------------------------------
// Locate the Claude desktop data directory across platforms.
// ---------------------------------------------------------------------------
function defaultClaudeDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  }
  // linux and others
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}

function sessionsDirFrom(claudeDir) {
  return path.join(claudeDir, 'claude-code-sessions');
}

// Path where the CLI stores transcripts, used only for a best-effort check that
// a pointer still has a real conversation behind it.
function cliProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Replicates how Claude Code encodes a working directory into a folder name:
// every character that is not a letter or digit becomes a dash.
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Scan all pointer files under claude-code-sessions.
// Layout: <sessionsDir>/<workspaceId>/<containerId>/local_*.json
// ---------------------------------------------------------------------------
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
          filePath,
          file,
          wsId,
          containerId,
          containerPath,
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

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function fmtTime(ms) {
  if (!ms) return 'unknown';
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); } catch { return 'unknown'; }
}

// ---------------------------------------------------------------------------
// Detect whether the Claude desktop app is running (best effort).
// ---------------------------------------------------------------------------
function isClaudeRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', { encoding: 'utf8' });
      return /\bClaude\.exe\b/i.test(out);
    }
    const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
    return out.split('\n').some((line) => /\/Claude(\.app)?\b/.test(line) || /(^|\/)Claude$/.test(line.trim()));
  } catch {
    return null; // unknown
  }
}

// ---------------------------------------------------------------------------
// Build a migration plan: for each working directory, surface every pointer
// under the current (target) workspace.
// ---------------------------------------------------------------------------
function buildPlan(pointers, opts) {
  if (pointers.length === 0) return { groups: [], targetWorkspace: null };

  // Target workspace defaults to the one holding the most recently active
  // pointer -- almost always the account you are using right now.
  let targetWorkspace = opts.targetWorkspace;
  if (!targetWorkspace) {
    targetWorkspace = pointers.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a)).wsId;
  }

  // Group by working directory so different projects never get mixed together.
  const byCwd = new Map();
  for (const p of pointers) {
    if (!byCwd.has(p.cwd)) byCwd.set(p.cwd, []);
    byCwd.get(p.cwd).push(p);
  }

  const groups = [];
  for (const [cwd, list] of byCwd) {
    // Find an existing container in the target workspace for this cwd.
    const inTarget = list.filter((p) => p.wsId === targetWorkspace);
    let targetContainerPath = null;
    let createdContainer = false;
    if (inTarget.length) {
      targetContainerPath = inTarget.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a)).containerPath;
    } else {
      // The current account never opened this project: stage a fresh container
      // under the target workspace so the conversations show up there too.
      targetContainerPath = path.join(sessionsDir, targetWorkspace, crypto.randomUUID());
      createdContainer = true;
    }

    // cliSessionIds already present in the target container must not be copied
    // again, otherwise the same conversation would appear twice.
    const presentCli = new Set(
      list.filter((p) => p.containerPath === targetContainerPath).map((p) => p.cliSessionId)
    );
    const toMigrate = list.filter(
      (p) => p.containerPath !== targetContainerPath && !presentCli.has(p.cliSessionId)
    );

    if (toMigrate.length === 0 && !createdContainer) continue;
    if (toMigrate.length === 0) continue;

    groups.push({ cwd, targetContainerPath, createdContainer, toMigrate, alreadyThere: presentCli.size });
  }
  return { groups, targetWorkspace };
}

// ---------------------------------------------------------------------------
// Backup / restore.
// ---------------------------------------------------------------------------
function backupSessions(sessionsDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(os.homedir(), '.claude-history-rescue', 'backups', stamp, 'claude-code-sessions');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(sessionsDir, dest, { recursive: true });
  return path.dirname(dest);
}

function restoreFrom(backupDir, sessionsDir) {
  const src = path.join(backupDir, 'claude-code-sessions');
  if (!fs.existsSync(src)) fail(`No claude-code-sessions found inside backup: ${backupDir}`);
  // Move the current dir aside before restoring, just in case.
  if (fs.existsSync(sessionsDir)) {
    const aside = `${sessionsDir}.replaced-${Date.now()}`;
    fs.renameSync(sessionsDir, aside);
    log(dim(`Current sessions moved aside to: ${aside}`));
  }
  fs.cpSync(src, sessionsDir, { recursive: true });
  log(green('Restore complete.') + ` Sessions restored from ${backupDir}`);
}

// ---------------------------------------------------------------------------
// Interactive confirm.
// ---------------------------------------------------------------------------
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${dim('[y/N]')} `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------
let sessionsDir; // resolved in main()

function cmdList(pointers) {
  if (pointers.length === 0) {
    log(yellow('No Claude Code desktop sessions found.'));
    log(dim(`Looked in: ${sessionsDir}`));
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

async function cmdMigrate(pointers, flags) {
  if (pointers.length === 0) {
    log(yellow('No Claude Code desktop sessions found. Nothing to migrate.'));
    log(dim(`Looked in: ${sessionsDir}`));
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
    for (const p of g.toMigrate.slice(0, 5)) {
      log(dim(`      - ${p.title}`));
    }
    if (g.toMigrate.length > 5) log(dim(`      ... and ${g.toMigrate.length - 5} more`));
  }

  // Best-effort check that the transcripts still exist.
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

  // Make sure the desktop app is closed.
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
  const backup = backupSessions(sessionsDir);
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
  log(dim(`  claude-history-rescue --restore "${backup}"`));
  log(dim('If they still do not appear, the desktop app may have cached an empty list;'));
  log(dim('see the README "Troubleshooting" section.'));
}

// ---------------------------------------------------------------------------
// Argument parsing & entry point.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = { dryRun: false, yes: false, list: false, help: false, restore: null, sessionsDir: null, targetWorkspace: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--list' || a === '-l') flags.list = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--restore') flags.restore = argv[++i];
    else if (a === '--sessions-dir') flags.sessionsDir = argv[++i];
    else if (a === '--target-workspace') flags.targetWorkspace = argv[++i];
    else fail(`Unknown option: ${a}  (try --help)`);
  }
  return flags;
}

function printHelp() {
  log(`${bold('claude-history-rescue')} - restore Claude Code history after switching accounts

${bold('Usage')}
  claude-history-rescue            Scan, show a plan, back up, and migrate (interactive)
  claude-history-rescue --list     Just list workspaces and conversations, change nothing
  claude-history-rescue --dry-run  Show exactly what would be migrated, change nothing
  claude-history-rescue --yes      Apply without the confirmation prompt (still backs up)
  claude-history-rescue --restore <backupDir>   Roll back a previous run

${bold('Options')}
  --sessions-dir <path>       Override auto-detection of claude-code-sessions
  --target-workspace <id>     Force which workspace to migrate into
  -n, --dry-run               Preview only
  -y, --yes                   Skip confirmation
  -l, --list                  List only
      --force                 Skip the running-app safety check (advanced)
  -h, --help                  This help

${bold('Notes')}
  Your conversations are never deleted by this tool. It only copies small pointer
  files, always backs up first, and never overwrites. Quit the Claude desktop app
  before migrating. More detail: https://github.com/HeiGeAi/claude-history-rescue`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return; }

  const claudeDir = flags.sessionsDir ? path.dirname(flags.sessionsDir) : defaultClaudeDir();
  sessionsDir = flags.sessionsDir || sessionsDirFrom(claudeDir);

  if (flags.restore) {
    const running = isClaudeRunning();
    if (running === true && !flags.force) fail('Quit the Claude desktop app before restoring. (Pass --force to override.)');
    restoreFrom(flags.restore, sessionsDir);
    return;
  }

  if (!fs.existsSync(sessionsDir)) {
    log(yellow('Could not find the Claude desktop sessions directory.'));
    log(dim(`Looked in: ${sessionsDir}`));
    log(dim('If your Claude desktop app stores data elsewhere, pass --sessions-dir <path>.'));
    return;
  }

  const pointers = scanPointers(sessionsDir);
  if (flags.list) { cmdList(pointers); return; }
  await cmdMigrate(pointers, flags);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
