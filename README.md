# browser-terminal

A tiny local web terminal: a small Node.js server runs a real shell on a PTY
and serves one web page, so you can operate that shell from a browser tab.

It was designed so that an AI agent can drive a terminal through a browser —
typing commands into a real terminal view and reading the output as real DOM
text — on machines where the agent cannot operate the OS terminal app
directly. Humans can of course use it as a plain browser terminal too.

- Runs on the Node.js you already have (18+, 20 LTS recommended). No other
  runtime to install. macOS / Windows / Linux.
- Multiple independent sessions: one browser tab = one terminal session.
  Sessions live on the server side, so closing a tab does not kill the shell;
  reopen the page and reattach, with the scrollback replayed.
- Output is rendered as DOM text (not a canvas). ANSI colors are supported,
  and the text itself stays in the DOM so it can be selected, searched and
  read reliably.
- Optional agent API (off by default): create sessions, inject commands, and
  read back a plain-text (ANSI-stripped) transcript with incremental `seq`
  offsets.

See [docs/design.md](docs/design.md) for the design notes (Japanese).

> An earlier Rust implementation is preserved on the `rust-impl` branch.

## Why this exists: terminal access for Muse

This tool was built for [Muse](https://muse.ai), Meta's personal AI agent.
Muse helps with work on the user's own machines, but two hard constraints
leave it with no way to run a shell command there:

- **Muse cannot operate terminal apps.** Its computer control explicitly
  excludes terminal and scripting apps (Terminal.app and the like), so even
  on a Mac it can otherwise see and control, there is no terminal it is
  allowed to type into.
- **Muse cannot reach the machine's localhost from its own browser.**
  Muse's cloud browser, and any fresh browser window it opens, runs in
  Muse's environment — `127.0.0.1` there is not the user's machine. The
  browser-terminal page only works when it is open inside the *user's own*
  browser, on the machine itself.

browser-terminal bridges that gap. Start the server on the machine and
open its page in the user's Chrome; from then on Muse can drive that
machine's terminal through the page, in either of two ways:

- **Through the Chrome extension** — Muse running on the user's Chrome
  works directly in the browser-terminal tab.
- **Through the desktop app** — Muse in the Mac app operates the user's
  Chrome (opening the browser-terminal tab itself) and works through it.

The access token is entered by the user: when the page asks for the
token, the user types it. Muse never holds or handles the token value.

## Security model

This tool exposes a shell. It is built to be safe by default:

- **Localhost only.** The server binds to `127.0.0.1`. There is no LAN or
  internet exposure in v1. Do not put it behind a public reverse proxy.
- **Token required everywhere.** The UI, the WebSocket and the API all
  require an access token (`Authorization: Bearer <token>` header, or
  `?token=` for the page/WebSocket). A token is generated on first run and
  stored in the config file, which is created with `0600` permissions.
  Treat the token like a password.
- **sudo is yours to type.** The server never stores, handles or injects
  passwords. If a command asks for a sudo password, the PTY presents the
  prompt and a human types the password at the terminal, as usual.
- **Audit log.** Every command line submitted (via the UI or the API) is
  appended with a timestamp to `audit.log` next to the config file.
  Command output is not logged.
- **Agent API is opt-in.** `/api/*` returns 404 unless `api_enabled = true`
  is set in the config.

## Install

### Easiest: let an AI agent do it

Paste this into Claude Code, Cursor, Codex or another coding assistant:

```
Set up browser-terminal on this machine for me: https://github.com/akiojin/browser-terminal — follow docs/install-prompt.md in that repository.
```

The prompt in [docs/install-prompt.md](docs/install-prompt.md) makes the agent
clone, install, start the server, verify it, and report back.

### Manual

#### 1. Prerequisites

- Node.js 18+ (20 LTS recommended), npm, and git. Check with
  `node --version` and `npm --version`.
- `npm install` pulls in `node-pty` (native PTY module). Prebuilt binaries
  cover common platforms; if one is unavailable for yours, the module builds
  from source and needs the usual native toolchain (macOS: Xcode Command
  Line Tools; Windows: Visual Studio Build Tools; Linux: make, g++,
  python3).

#### 2. Install

```sh
git clone https://github.com/akiojin/browser-terminal.git ~/tools/browser-terminal
cd ~/tools/browser-terminal
npm install
```

#### 3. Start

```sh
npm start
# or: node src/server.js [--config /path/to/config.toml]
```

On first run the server creates a config file (permissions `0600`) with a
generated access token, repairs the `node-pty` spawn-helper permissions if
needed, runs a one-shot PTY spawn self-check, and prints something like:

```
created config at /home/you/.config/browser-terminal/config.toml
pty spawn self-check: ok
browser-terminal listening on http://127.0.0.1:17337/?token=<your token>
config: /home/you/.config/browser-terminal/config.toml
```

- The URL contains your token. Treat it like a password: do not post it
  anywhere public. If you lose it, read the `token` value from the config
  file and open `http://127.0.0.1:17337/?token=<token>`.
- A startup line `repaired node-pty spawn-helper permissions: ...` is the
  automatic repair doing its job (see Troubleshooting) — not an error.
- If the startup log says `pty spawn self-check FAILED`, sessions will not
  start. Go to Troubleshooting before anything else.
- To run it in the background instead: `nohup npm start > server.log 2>&1 &`

Config file location (default):

- Linux: `~/.config/browser-terminal/config.toml`
  (or `$XDG_CONFIG_HOME/browser-terminal/config.toml`)
- macOS: `~/Library/Application Support/browser-terminal/config.toml`
- Windows: `%APPDATA%\browser-terminal\config.toml`

The items you are most likely to touch are `port` (default `17337`),
`token`, and `api_enabled` (default `false`). The full list is in
[Configuration](#configuration) below. Changes need a server restart.

#### 4. Verify (do not skip)

1. Open the printed URL in a browser tab. A shell prompt appears and you
   can type commands. That is the install working end to end.
2. The startup output contains `pty spawn self-check: ok` (POSIX; the
   self-check is skipped on Windows).
3. Optional, from a terminal — HTTP auth behaves as expected. Read the
   token from the config file first:

   ```sh
   curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17337/
   # -> 401
   curl -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" http://127.0.0.1:17337/
   # -> 200
   curl http://127.0.0.1:17337/sessions -H "Authorization: Bearer <token>"
   # -> JSON list containing the session you opened in step 1
   ```

4. Optional, macOS / Linux — exercise the PTY spawn directly, from the
   cloned directory:

   ```sh
   node -e "const p=require('node-pty');const sh=process.env.SHELL||'/bin/sh';const t=p.spawn(sh,['-c','echo SPAWN_OK'],{name:'xterm-256color',cols:80,rows:24,cwd:process.env.HOME,env:process.env});t.onData(d=>process.stdout.write(d));t.onExit(e=>{console.log('EXIT',e.exitCode)})"
   ```

   Success = `SPAWN_OK` and `EXIT 0`.

If the page loads but stays "disconnected" with no prompt, session
creation is failing. The error stays visible in the page's error bar —
read it, check the startup log's self-check line, and see Troubleshooting.

Once it works: open the URL again in another tab (or use "New session")
for a second, independent terminal. Use the session dropdown to reattach
to an existing session; closing a tab does not kill its shell.

Shell used per session:

- macOS / Linux: `$SHELL`, falling back to zsh, then bash. Sessions are
  started as login + interactive shells, so login-shell startup files
  (`~/.zprofile`, `~/.bash_profile`, Homebrew's `shellenv`, ...) are read
  just like in a desktop terminal.
- Windows: `pwsh` if installed, otherwise Windows PowerShell (PTY via
  ConPTY, Windows 10 1809+).

#### 5. Stop

- Foreground: Ctrl+C in the terminal running `npm start`.
- Background: end the `node src/server.js` process, e.g.
  `pkill -f "src/server.js"` (macOS / Linux).
- Stopping the server ends all of its sessions.

#### 6. Update

```sh
git -C ~/tools/browser-terminal pull
cd ~/tools/browser-terminal && npm install
```

Then restart the server.

#### 7. Run it as a background service (optional)

To start browser-terminal automatically at login, register it as a
per-user OS service:

```sh
cd ~/tools/browser-terminal
npm run service -- install     # write the unit file and load the service
npm run service -- status      # show whether the unit file is installed
npm run service -- uninstall   # unload the service and remove the unit
```

Add `--dry-run` to `install` / `uninstall` to print the unit file and
the commands without changing anything. On macOS this writes a
LaunchAgent (`~/Library/LaunchAgents/com.browser-terminal.plist`,
logs to `~/Library/Logs/browser-terminal.log`); on Linux a systemd user
unit (`~/.config/systemd/user/browser-terminal.service`, enabled with
`systemctl --user enable --now`). Windows is not automated — the
command prints Task Scheduler guidance instead.

### Troubleshooting

- **`pty spawn self-check FAILED: ... posix_spawnp failed.` in the
  startup log; the page stays "disconnected" and its error bar shows the
  spawn error.**
  `node-pty`'s spawn-helper lost its executable bit during `npm install`.
  This happens when npm's install scripts were approved only after the
  install had already run (common with supply-chain-protected npm setups
  and agent-driven installs). The server repairs the bits automatically
  at startup and logs `repaired node-pty spawn-helper permissions: ...`,
  so first try simply restarting the server. If the self-check still
  fails, check and fix by hand, then restart:

  ```sh
  ls -l node_modules/node-pty/prebuilds/*/spawn-helper   # want -rwxr-xr-x
  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
  ```

  (After a manual `chmod`, already-running servers pick the fix up on the
  next spawn — no restart needed for that part.)

- **`failed to bind 127.0.0.1:17337: ... EADDRINUSE` at startup.**
  Something already uses the port — often another browser-terminal.
  Stop it, or set a different `port` in the config file and restart.

- **The browser gets a 401 / the page will not open.**
  The token in the URL is missing or wrong. Use the exact URL printed at
  startup, or read `token` from the config file (see step 3).

- **`npm install` fails while building `node-pty`.**
  No prebuilt binary matched your platform and the native toolchain is
  missing. Install it (see Prerequisites) and run `npm install` again.

- **Windows: `Failed to start session: spawn shell failed: File not found`.**
  The shell could not be resolved to an executable. The server resolves
  the Windows shell to an absolute path on its own (`where pwsh`, then
  `where powershell`, then the stock `%SystemRoot%` location), so on a
  current build just restart the server. If it still fails, set `shell`
  in the config to the absolute path of `powershell.exe` (see
  Configuration) and restart.

## Configuration

```toml
port = 17337              # fixed port
token = "..."             # generated on first run; keep secret
bind = "127.0.0.1"        # v1: localhost only
api_enabled = false       # enable the agent API
# shell = "/bin/zsh"      # optional shell override
                          # (Windows: absolute path, e.g.
                          #  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
scrollback_bytes = 262144 # raw scrollback kept per session
# audit_log = "audit.log" # path (relative to the config dir)
idle_timeout_minutes = 0  # close sessions with no input/output this long; 0 = never
```

The UI header shows the attached session's current working directory
(`cwd: ...`), and the session list endpoints report it as `cwd`. The
server reads it from the OS (Linux `/proc`, macOS `lsof`) and from
OSC 7 sequences when the shell emits them.

## Agent API (when `api_enabled = true`)

All endpoints require the token.

```sh
# create a session
curl -X POST http://127.0.0.1:17337/api/sessions \
  -H "Authorization: Bearer <token>" -d '{"name":"work"}'

# list sessions
curl http://127.0.0.1:17337/api/sessions -H "Authorization: Bearer <token>"

# run a command in a session (returns the transcript seq at injection time)
curl -X POST http://127.0.0.1:17337/api/exec \
  -H "Authorization: Bearer <token>" \
  -d '{"session":"<id>","command":"echo hello && pwd"}'

# read new output since a seq (plain text, ANSI stripped)
curl "http://127.0.0.1:17337/api/transcript?session=<id>&since=<seq>" \
  -H "Authorization: Bearer <token>"
```

## Status

Prototype (v0.2, Node.js rewrite). Implemented: PTY sessions with
per-session state, multi-session + reattach with scrollback replay,
cell-grid terminal UI (DOM text) with ANSI colors and alternate-screen
support, direct key input with IME composition and paste, token auth,
optional agent API, audit log, the attached session's cwd in the UI
header, an optional session idle timeout (`idle_timeout_minutes`), and
OS service registration helpers for launchd / systemd
(`npm run service -- install`).

Not yet (v2 candidates): mouse reporting in the UI, in-UI indicators
for running state / sudo password wait.

## License

MIT
