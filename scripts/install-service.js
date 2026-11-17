#!/usr/bin/env node
// Register browser-terminal as a per-user OS service so it starts at
// login: a LaunchAgent on macOS, a systemd user unit on Linux.
//
//   node scripts/install-service.js install [--dry-run] [--config <path>]
//   node scripts/install-service.js uninstall [--dry-run]
//   node scripts/install-service.js status
//
// `install` writes the unit file and loads the service. `--dry-run`
// prints the file and the commands without changing anything.
// `uninstall` unloads the service and removes the unit file.
// Windows: prints Task Scheduler guidance (no automated registration).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { servicePlan } = require('../src/service-helper');

function parseArgs(argv) {
  const out = { command: argv[0] || 'status', dryRun: false, configPath: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--config' && i + 1 < argv.length) out.configPath = argv[++i];
  }
  return out;
}

function run(cmd) {
  console.log(`$ ${cmd.join(' ')}`);
  execFileSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
}

function main() {
  const { command, dryRun, configPath } = parseArgs(process.argv.slice(2));
  const repoDir = path.join(__dirname, '..');
  const plan = servicePlan(process.platform, {
    homeDir: os.homedir(),
    nodePath: process.execPath,
    serverPath: path.join(repoDir, 'src', 'server.js'),
    workingDir: repoDir,
    configPath: configPath || undefined,
  });

  if (!plan.supported) {
    console.log(plan.guidance);
    return;
  }

  if (command === 'status') {
    const exists = fs.existsSync(plan.filePath);
    console.log(`unit file: ${plan.filePath} (${exists ? 'present' : 'not installed'})`);
    return;
  }

  if (command === 'install') {
    console.log(`writing ${plan.filePath}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(plan.filePath), { recursive: true });
      fs.writeFileSync(plan.filePath, plan.contents);
    } else {
      console.log('--- unit contents (dry run) ---');
      console.log(plan.contents);
    }
    for (const cmd of plan.loadCommands) {
      if (dryRun) console.log(`$ ${cmd.join(' ')}`);
      else run(cmd);
    }
    console.log(dryRun ? 'dry run: nothing was changed' : 'service installed and started');
    return;
  }

  if (command === 'uninstall') {
    for (const cmd of plan.unloadCommands) {
      if (dryRun) console.log(`$ ${cmd.join(' ')}`);
      else {
        try { run(cmd); } catch (_) { /* not loaded: keep going */ }
      }
    }
    if (fs.existsSync(plan.filePath)) {
      console.log(`removing ${plan.filePath}`);
      if (!dryRun) fs.rmSync(plan.filePath);
    }
    console.log(dryRun ? 'dry run: nothing was changed' : 'service uninstalled');
    return;
  }

  console.error(`unknown command: ${command} (want install | uninstall | status)`);
  process.exit(1);
}

main();
