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

Paste the ready-made prompt in [docs/install-prompt.md](docs/install-prompt.md)
into the AI agent running on the target machine (Claude Code, Codex, …).
It clones, installs, starts the server, verifies it, and reports back.

### Manual

Requires Node.js 18+ (20 LTS recommended), npm, and git.

```sh
git clone https://github.com/akiojin/browser-terminal.git ~/tools/browser-terminal
cd ~/tools/browser-terminal
npm install
npm start
# or: node src/server.js [--config /path/to/config.toml]
```

`npm install` pulls in `node-pty` (native PTY module). Prebuilt binaries
cover common platforms; if one is unavailable for yours, the module builds
from source and needs the usual native toolchain (macOS: Xcode Command Line
Tools; Windows: Visual Studio Build Tools; Linux: make, g++, python3).

On first run the server creates a config file and prints the URL to open,
including the token:

```
browser-terminal listening on http://127.0.0.1:17337/?token=<your token>
```

Config file location (default):

- Linux: `~/.config/browser-terminal/config.toml`
- macOS: `~/Library/Application Support/browser-terminal/config.toml`
- Windows: `%APPDATA%\browser-terminal\config.toml`

Open the printed URL in a browser tab. Open it again in another tab (or use
"New session") for a second, independent terminal. Use the session dropdown
to reattach to an existing session.

Shell used per session:

- macOS / Linux: `$SHELL`, falling back to zsh, then bash.
- Windows: `pwsh` if installed, otherwise Windows PowerShell (PTY via
  ConPTY, Windows 10 1809+).

## Configuration

```toml
port = 17337              # fixed port
token = "..."             # generated on first run; keep secret
bind = "127.0.0.1"        # v1: localhost only
api_enabled = false       # enable the agent API
# shell = "/bin/zsh"      # optional shell override
scrollback_bytes = 262144 # raw scrollback kept per session
# audit_log = "audit.log" # path (relative to the config dir)
```

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
optional agent API, audit log.

Not yet (v2 candidates): mouse reporting in the UI, session idle timeout,
OS service registration helpers (launchd / systemd / Windows service),
in-UI indicators for cwd / running state / sudo password wait.

## License

MIT
