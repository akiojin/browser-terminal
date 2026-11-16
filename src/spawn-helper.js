'use strict';

// Startup hardening for node-pty's spawn-helper.
//
// Background (2026-11-13, a real install): npm left
// node_modules/node-pty/prebuilds/<platform>-<arch>/spawn-helper without
// any execute bit, so every pty.spawn() threw "posix_spawnp failed.".
// HTTP and auth looked fine, /sessions stayed empty and the UI just sat
// at "disconnected" — the actual cause took a long time to find.
//
// Two defenses live here:
//  1. repairSpawnHelpers(): at server startup, find every prebuilt
//     spawn-helper and add the execute bits when they are missing,
//     logging each repair. Platforms whose prebuilds have no
//     spawn-helper (Windows uses conpty/winpty) simply find nothing.
//  2. probePtySpawn(): a boot-time self-check that spawns /bin/true
//     through node-pty — the same spawn-helper path a real session
//     uses, but without running the user's shell or its rc files — so
//     a broken install is announced in the startup log instead of
//     surfacing later as mysteriously failing sessions.

const fs = require('fs');
const os = require('os');
const path = require('path');

// All spawn-helper files under <ptyDir>/prebuilds/*/spawn-helper that
// actually exist. Sorted for deterministic logs and tests.
function findSpawnHelpers(ptyDir, fsImpl) {
  const f = fsImpl || fs;
  const prebuilds = path.join(ptyDir, 'prebuilds');
  let entries;
  try {
    entries = f.readdirSync(prebuilds, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(prebuilds, entry.name, 'spawn-helper');
    try {
      if (f.statSync(candidate).isFile()) found.push(candidate);
    } catch (_) {
      /* no helper for this platform — fine */
    }
  }
  return found.sort();
}

// Add execute bits (u/g/o) to every spawn-helper that has none, keeping
// the rest of its mode. Each repair is reported through `log`. Returns
// { checked, repaired } — never throws for missing pieces.
function repairSpawnHelpers(ptyDir, log, fsImpl) {
  const f = fsImpl || fs;
  const say = typeof log === 'function' ? log : () => {};
  const helpers = findSpawnHelpers(ptyDir, f);
  const repaired = [];
  for (const helper of helpers) {
    let st;
    try {
      st = f.statSync(helper);
    } catch (_) {
      continue;
    }
    if ((st.mode & 0o111) !== 0) continue; // already executable
    const before = st.mode & 0o777;
    const after = before | 0o111;
    try {
      f.chmodSync(helper, after);
    } catch (e) {
      say(
        `warning: could not repair spawn-helper permissions at ${helper}: ${e.message}`
      );
      continue;
    }
    repaired.push(helper);
    say(
      `repaired node-pty spawn-helper permissions: ${helper} ` +
        `(mode ${before.toString(8)} -> ${after.toString(8)})`
    );
  }
  return { checked: helpers.length, repaired };
}

// Locate the installed node-pty package directory. Prefers the
// package.json subpath; falls back to walking up from the main entry
// to the first ancestor that carries a prebuilds directory.
function nodePtyPackageDir() {
  try {
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch (_) {
    /* fall through to the walk */
  }
  let dir = path.dirname(require.resolve('node-pty'));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'prebuilds'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(require.resolve('node-pty'));
}

// Repair the helpers of the node-pty this server is running with.
// Best effort: any failure is logged and reported, never thrown, so a
// permissions quirk cannot take the whole server down before it logs.
function repairNodePtySpawnHelpers(log) {
  const say = typeof log === 'function' ? log : () => {};
  try {
    return repairSpawnHelpers(nodePtyPackageDir(), say);
  } catch (e) {
    say(`warning: spawn-helper permission check skipped: ${e.message}`);
    return { checked: 0, repaired: [] };
  }
}

// One-shot spawn self-check. On POSIX this spawns /bin/true via
// node-pty: it exercises the spawn-helper exactly like a real session
// spawn, but runs no shell and no user rc files, and exits instantly.
// Skipped on Windows (a different spawn mechanism, no /bin/true) and
// when no `true` binary exists. `opts` allows tests to inject the
// platform, the binary path and the spawn function.
// Returns { ok, skipped } or { ok: false, error }.
function probePtySpawn(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform === 'win32') return { ok: true, skipped: true };
  const f = o.fs || fs;
  let file = o.file;
  if (!file) {
    if (f.existsSync('/bin/true')) file = '/bin/true';
    else if (f.existsSync('/usr/bin/true')) file = '/usr/bin/true';
    else return { ok: true, skipped: true };
  }
  const spawn =
    o.spawn || ((file2, args, options) => require('node-pty').spawn(file2, args, options));
  let proc;
  try {
    proc = spawn(file, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env,
    });
  } catch (e) {
    return { ok: false, skipped: false, error: e.message };
  }
  // Drain output/exit so the probe process never lingers as a zombie
  // on runtimes that wait for listeners; /bin/true exits immediately.
  try {
    if (proc && typeof proc.onData === 'function') proc.onData(() => {});
    if (proc && typeof proc.onExit === 'function') proc.onExit(() => {});
  } catch (_) {
    /* best effort */
  }
  return { ok: true, skipped: false };
}

module.exports = {
  findSpawnHelpers,
  repairSpawnHelpers,
  nodePtyPackageDir,
  repairNodePtySpawnHelpers,
  probePtySpawn,
};
