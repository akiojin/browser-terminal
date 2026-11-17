// OS service registration helpers: generate the launchd / systemd user
// unit that runs browser-terminal at login, so installing the service is
// a checked, repeatable operation instead of hand-written plist/unit
// files. The pure generators live here (unit-tested); the CLI in
// scripts/install-service.js writes the file and loads the service.
//
// Supported: macOS (LaunchAgent), Linux (systemd --user). Windows gets
// printed guidance only (Task Scheduler), no file is generated.

'use strict';

const path = require('path');

const LAUNCHD_LABEL = 'com.browser-terminal';
const SYSTEMD_UNIT_NAME = 'browser-terminal.service';

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// macOS LaunchAgent plist. Runs the server at login (RunAtLoad), does not
// respawn it when the user stops it on purpose (no KeepAlive), and logs
// to ~/Library/Logs/browser-terminal.log.
function launchAgentPlist(opts) {
  const args = [opts.nodePath, opts.serverPath];
  if (opts.configPath) args.push('--config', opts.configPath);
  const argLines = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

// Linux systemd user unit. Restart on failure only, so a deliberate
// `systemctl --user stop` stays stopped.
function systemdUnit(opts) {
  const exec = [opts.nodePath, opts.serverPath];
  if (opts.configPath) exec.push('--config', opts.configPath);
  return `[Unit]
Description=browser-terminal (local web terminal)
After=network.target

[Service]
Type=simple
ExecStart=${exec.join(' ')}
WorkingDirectory=${opts.workingDir}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

// Decide what to write and which commands load/unload the service.
// opts: { platform, homeDir, nodePath, serverPath, workingDir, configPath }
// Returns { supported, filePath, contents, loadCommands, unloadCommands,
// guidance } — commands are argv arrays, run in order.
function servicePlan(platform, opts) {
  if (platform === 'darwin') {
    const filePath = path.join(opts.homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    return {
      supported: true,
      filePath,
      contents: launchAgentPlist({
        ...opts,
        logPath: path.join(opts.homeDir, 'Library', 'Logs', 'browser-terminal.log'),
      }),
      loadCommands: [['launchctl', 'unload', filePath], ['launchctl', 'load', filePath]],
      unloadCommands: [['launchctl', 'unload', filePath]],
      guidance: null,
    };
  }
  if (platform === 'linux') {
    const filePath = path.join(opts.homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
    return {
      supported: true,
      filePath,
      contents: systemdUnit(opts),
      loadCommands: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ],
      unloadCommands: [
        ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      guidance: null,
    };
  }
  return {
    supported: false,
    filePath: null,
    contents: null,
    loadCommands: [],
    unloadCommands: [],
    guidance:
      'Windows service registration is not automated. Use Task Scheduler ' +
      '("At log on" trigger) with the action: node src/server.js from the ' +
      'browser-terminal directory, or run the server with `npm start`.',
  };
}

module.exports = { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, launchAgentPlist, systemdUnit, servicePlan };
