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

function shellArgs(platform) {
  if (platform === 'win32') return ['-NoLogo'];
  return ['-l', '-i'];
}

module.exports = { shellArgs };
