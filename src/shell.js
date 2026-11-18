// Spawn arguments for the session shell.
//
// POSIX shells are started as login + interactive (`-l -i`) so a session
// reads the same startup files as a desktop terminal: ~/.zprofile /
// ~/.bash_profile and /etc/zprofile (path_helper) run before the
// interactive rc files. Homebrew's `shellenv`, version-manager shims and
// similar PATH setup conventionally live in those login files, so with
// `-i` alone they were skipped and commands installed there (e.g. codex)
// came up "command not found" inside browser-terminal while working fine
// in Terminal.app. The same flags are used for a `shell` config override,
// which is expected to name a POSIX shell.
//
// Windows shells (pwsh / powershell) only get the logo banner suppressed;
// PowerShell has no login-shell distinction to mirror here.

'use strict';

const path = require('path');

function shellArgs(platform) {
  if (platform === 'win32') return ['-NoLogo'];
  return ['-l', '-i'];
}

// Resolve the Windows shell to an absolute path.
//
// node-pty (ConPTY) cannot spawn a bare command name such as "powershell":
// it fails with "spawn shell failed: File not found" even though the same
// name works in an interactive PowerShell (observed on first Windows
// install, 2026-11-18; the workaround was writing the absolute path into
// the config by hand). So the default resolution must produce a path:
//   1. an explicit `shell` config value wins as-is;
//   2. `where pwsh`, then `where powershell` (first existing hit);
//   3. the stock Windows PowerShell location under %SystemRoot%.
// `where(prog)` returns an absolute path or null; `exists(p)` is a
// filesystem existence check. Both are injected for testing.
function resolveWindowsShellPath({ configShell, where, exists, systemRoot }) {
  if (configShell) return configShell;
  if (where) {
    for (const prog of ['pwsh', 'powershell']) {
      const found = where(prog);
      if (found) return found;
    }
  }
  const fallback = path.join(
    systemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  if (!exists || exists(fallback)) return fallback;
  return 'powershell';
}

module.exports = { shellArgs, resolveWindowsShellPath };
