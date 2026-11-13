// browser-terminal: a tiny local web terminal.
// A local HTTP/WebSocket server spawns real shells on PTYs and serves a
// single-page UI so the shell can be operated from a browser tab.
// Binds to 127.0.0.1 only; every endpoint requires a token.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    /// Fixed port (default 17337).
    #[serde(default = "default_port")]
    port: u16,
    /// Access token. Generated on first run and stored in this file.
    #[serde(default)]
    token: String,
    /// Bind address. v1 is localhost only by design.
    #[serde(default = "default_bind")]
    bind: String,
    /// Enable the agent-facing /api/* endpoints.
    #[serde(default)]
    api_enabled: bool,
    /// Optional shell override (path or program name).
    #[serde(default)]
    shell: Option<String>,
    /// Raw scrollback kept per session, in bytes.
    #[serde(default = "default_scrollback")]
    scrollback_bytes: usize,
    /// Audit log path (default: "audit.log" next to the config file).
    #[serde(default)]
    audit_log: Option<String>,
}

fn default_port() -> u16 {
    17337
}
fn default_bind() -> String {
    "127.0.0.1".to_string()
}
fn default_scrollback() -> usize {
    256 * 1024
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: default_port(),
            token: String::new(),
            bind: default_bind(),
            api_enabled: false,
            shell: None,
            scrollback_bytes: default_scrollback(),
            audit_log: None,
        }
    }
}

fn config_path_from_args() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--config" && i + 1 < args.len() {
            return Some(PathBuf::from(&args[i + 1]));
        }
        i += 1;
    }
    None
}

fn default_config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("browser-terminal").join("config.toml")
}

fn load_or_create_config(path: &PathBuf) -> std::io::Result<(Config, PathBuf)> {
    if path.exists() {
        let text = std::fs::read_to_string(path)?;
        let cfg: Config = toml::from_str(&text)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        if cfg.token.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "config has an empty token",
            ));
        }
        let dir = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok((cfg, dir));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut cfg = Config::default();
    cfg.token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let text = toml::to_string_pretty(&cfg).expect("serialize default config");
    std::fs::write(path, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    let dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    eprintln!("created config at {}", path.display());
    Ok((cfg, dir))
}

// ---------------------------------------------------------------------------
// ANSI stripping (for the plain-text transcript)
// ---------------------------------------------------------------------------

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    // CSI: consume until a final byte in 0x40..=0x7e
                    chars.next();
                    for c2 in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c2) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: consume until BEL or ESC \
                    chars.next();
                    let mut prev = '\0';
                    for c2 in chars.by_ref() {
                        if c2 == '\x07' || (prev == '\x1b' && c2 == '\\') {
                            break;
                        }
                        prev = c2;
                    }
                }
                Some('(') | Some(')') => {
                    chars.next();
                    chars.next();
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if c == '\n' || c == '\r' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

struct Session {
    id: String,
    name: String,
    created_at: String,
    alive: AtomicBool,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    #[allow(dead_code)]
    child: Mutex<Box<dyn Child + Send + Sync>>,
    scrollback: Mutex<Vec<u8>>,
    transcript: Mutex<Vec<(u64, String)>>,
    transcript_bytes: Mutex<usize>,
    seq: AtomicU64,
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
}

impl Session {
    fn write_input(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(bytes)?;
        w.flush()
    }
    fn latest_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
}

struct Inner {
    config: Config,
    config_dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    counter: AtomicU64,
    audit_lock: Mutex<()>,
}

#[derive(Clone)]
struct AppState(Arc<Inner>);

impl AppState {
    fn audit(&self, session_name: &str, via: &str, line: &str) {
        let line = line.replace(['\r', '\n'], " ");
        let ts = chrono::Local::now().to_rfc3339();
        let entry = format!("{ts}\tsession={session_name}\tvia={via}\t{line}\n");
        let path = match &self.0.config.audit_log {
            Some(p) => {
                let p = PathBuf::from(p);
                if p.is_absolute() {
                    p
                } else {
                    self.0.config_dir.join(p)
                }
            }
            None => self.0.config_dir.join("audit.log"),
        };
        let _guard = self.0.audit_lock.lock().unwrap();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(entry.as_bytes());
        }
    }

    fn create_session(&self, name: Option<String>) -> Result<Arc<Session>, String> {
        let n = self.0.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let name = name.unwrap_or_else(|| format!("shell-{n}"));
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let cmd = shell_command(&self.0.config);
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell failed: {e}"))?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader failed: {e}"))?;

        let (tx, _) = tokio::sync::broadcast::channel::<Vec<u8>>(512);
        let session = Arc::new(Session {
            id: id.clone(),
            name,
            created_at: chrono::Local::now().to_rfc3339(),
            alive: AtomicBool::new(true),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            scrollback: Mutex::new(Vec::new()),
            transcript: Mutex::new(Vec::new()),
            transcript_bytes: Mutex::new(0),
            seq: AtomicU64::new(0),
            tx,
        });

        // PTY reader thread: fills scrollback + transcript, broadcasts raw output.
        let s = session.clone();
        let cap = self.0.config.scrollback_bytes;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        {
                            let mut sb = s.scrollback.lock().unwrap();
                            sb.extend_from_slice(&chunk);
                            if sb.len() > cap {
                                let cut = sb.len() - cap;
                                sb.drain(..cut);
                            }
                        }
                        let plain = strip_ansi(&String::from_utf8_lossy(&chunk));
                        if !plain.is_empty() {
                            let seq = s.seq.fetch_add(1, Ordering::SeqCst) + 1;
                            let mut t = s.transcript.lock().unwrap();
                            let mut tb = s.transcript_bytes.lock().unwrap();
                            *tb += plain.len();
                            t.push((seq, plain));
                            // Keep at most ~4x scrollback of plain text.
                            while *tb > cap * 4 && t.len() > 1 {
                                let (_, old) = t.remove(0);
                                *tb -= old.len();
                            }
                        }
                        let _ = s.tx.send(chunk);
                    }
                }
            }
            s.alive.store(false, Ordering::SeqCst);
            let note = b"\r\n\x1b[33m[process exited]\x1b[0m\r\n".to_vec();
            {
                let mut sb = s.scrollback.lock().unwrap();
                sb.extend_from_slice(&note);
            }
            let _ = s.tx.send(note);
        });

        self.0
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
        Ok(session)
    }

    fn get_session(&self, id: &str) -> Option<Arc<Session>> {
        self.0.sessions.lock().unwrap().get(id).cloned()
    }

    fn list_sessions(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self
            .0
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| SessionInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                created_at: s.created_at.clone(),
                alive: s.alive.load(Ordering::SeqCst),
            })
            .collect();
        v.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        v
    }
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    name: String,
    created_at: String,
    alive: bool,
}

// ---------------------------------------------------------------------------
// Shell selection
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn program_exists(prog: &str) -> bool {
    std::process::Command::new("where")
        .arg(prog)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn shell_command(cfg: &Config) -> CommandBuilder {
    #[cfg(windows)]
    {
        let shell = cfg.shell.clone().unwrap_or_else(|| {
            if program_exists("pwsh") {
                "pwsh".to_string()
            } else {
                "powershell".to_string()
            }
        });
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-NoLogo");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        return cmd;
    }
    #[cfg(not(windows))]
    {
        let shell = cfg
            .shell
            .clone()
            .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/zsh").exists() {
                    "/bin/zsh".to_string()
                } else {
                    "/bin/bash".to_string()
                }
            });
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd
    }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn authorized(cfg: &Config, headers: &HeaderMap, query_token: Option<&String>) -> bool {
    if let Some(h) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        let expected = format!("Bearer {}", cfg.token);
        if h == expected || h == cfg.token {
            return true;
        }
    }
    if let Some(t) = query_token {
        if t == &cfg.token {
            return true;
        }
    }
    false
}

const TOKEN_FORM: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>browser-terminal</title></head>
<body style="font-family:monospace;background:#111;color:#ddd;padding:2em">
<h1>browser-terminal</h1>
<p>Access token required.</p>
<form method="GET" action="/">
<label>Token: <input type="password" name="token" size="48"></label>
<button type="submit">Open terminal</button>
</form>
</body></html>"#;

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn index(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> impl IntoResponse {
    if !authorized(&st.0.config, &headers, q.token.as_ref()) {
        return (StatusCode::UNAUTHORIZED, Html(TOKEN_FORM.to_string())).into_response();
    }
    Html(include_str!("ui.html").to_string()).into_response()
}

async fn list_sessions(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> impl IntoResponse {
    if !authorized(&st.0.config, &headers, q.token.as_ref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(st.list_sessions()).into_response()
}

async fn kill_session(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !authorized(&st.0.config, &headers, q.token.as_ref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let session = st.0.sessions.lock().unwrap().remove(&id);
    match session {
        Some(s) => {
            let _ = s.child.lock().unwrap().kill();
            s.alive.store(false, Ordering::SeqCst);
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
    session: Option<String>,
    name: Option<String>,
}

async fn ws_handler(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !authorized(&st.0.config, &headers, q.token.as_ref()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(st, q, socket))
        .into_response()
}

#[derive(Deserialize)]
struct WsControl {
    #[serde(rename = "type")]
    kind: String,
    data: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
}

async fn handle_ws(st: AppState, q: WsQuery, socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();

    // Resolve or create the session.
    let session = match q.session.as_deref() {
        None | Some("") | Some("new") => match st.create_session(q.name.clone()) {
            Ok(s) => s,
            Err(e) => {
                let _ = sender
                    .send(Message::Text(
                        serde_json::json!({"type":"error","message":e}).to_string(),
                    ))
                    .await;
                return;
            }
        },
        Some(id) => match st.get_session(id) {
            Some(s) => s,
            None => {
                let _ = sender
                    .send(Message::Text(
                        serde_json::json!({"type":"error","message":"no such session"})
                            .to_string(),
                    ))
                    .await;
                return;
            }
        },
    };

    let info = serde_json::json!({
        "type": "session",
        "id": session.id,
        "name": session.name,
        "alive": session.alive.load(Ordering::SeqCst),
    });
    if sender.send(Message::Text(info.to_string())).await.is_err() {
        return;
    }

    // Replay scrollback so a reattached tab restores its screen.
    let snapshot = session.scrollback.lock().unwrap().clone();
    if !snapshot.is_empty() {
        if sender.send(Message::Binary(snapshot)).await.is_err() {
            return;
        }
    }

    // Forward live PTY output to this socket.
    let mut rx = session.tx.subscribe();
    let forward = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(chunk) => {
                    if sender.send(Message::Binary(chunk)).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Read client input.
    let mut line_buf = String::new();
    while let Some(msg) = receiver.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(t) => {
                if t.starts_with('{') {
                    if let Ok(ctrl) = serde_json::from_str::<WsControl>(&t) {
                        match ctrl.kind.as_str() {
                            "input" => {
                                if let Some(d) = ctrl.data {
                                    feed_input(&st, &session, &mut line_buf, &d);
                                }
                            }
                            "resize" => {
                                if let (Some(rows), Some(cols)) = (ctrl.rows, ctrl.cols) {
                                    let _ = session.master.lock().unwrap().resize(PtySize {
                                        rows,
                                        cols,
                                        pixel_width: 0,
                                        pixel_height: 0,
                                    });
                                }
                            }
                            _ => {}
                        }
                        continue;
                    }
                }
                // Plain text frame: treat as raw input.
                feed_input(&st, &session, &mut line_buf, &t);
            }
            Message::Binary(b) => {
                let _ = session.write_input(&b);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    forward.abort();
}

/// Write input to the PTY and audit-log completed lines.
fn feed_input(st: &AppState, session: &Arc<Session>, line_buf: &mut String, data: &str) {
    let _ = session.write_input(data.as_bytes());
    for ch in data.chars() {
        if ch == '\r' || ch == '\n' {
            if !line_buf.is_empty() {
                st.audit(&session.name, "ws", line_buf);
                line_buf.clear();
            }
        } else if ch == '\x7f' {
            line_buf.pop();
        } else if !ch.is_control() {
            line_buf.push(ch);
        }
    }
}

// ---------------------------------------------------------------------------
// Agent API (only when api_enabled = true)
// ---------------------------------------------------------------------------

fn api_guard(st: &AppState, headers: &HeaderMap, token: Option<&String>) -> Result<(), StatusCode> {
    if !st.0.config.api_enabled {
        return Err(StatusCode::NOT_FOUND);
    }
    if !authorized(&st.0.config, headers, token) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

async fn api_sessions(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> impl IntoResponse {
    if let Err(code) = api_guard(&st, &headers, q.token.as_ref()) {
        return code.into_response();
    }
    Json(st.list_sessions()).into_response()
}

#[derive(Deserialize)]
struct CreateSessionBody {
    name: Option<String>,
    token: Option<String>,
}

async fn api_create_session(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateSessionBody>,
) -> impl IntoResponse {
    if let Err(code) = api_guard(&st, &headers, body.token.as_ref()) {
        return code.into_response();
    }
    match st.create_session(body.name) {
        Ok(s) => Json(SessionInfo {
            id: s.id.clone(),
            name: s.name.clone(),
            created_at: s.created_at.clone(),
            alive: true,
        })
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct ExecBody {
    session: String,
    command: String,
    token: Option<String>,
}

async fn api_exec(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ExecBody>,
) -> impl IntoResponse {
    if let Err(code) = api_guard(&st, &headers, body.token.as_ref()) {
        return code.into_response();
    }
    let session = match st.get_session(&body.session) {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if !session.alive.load(Ordering::SeqCst) {
        return (
            StatusCode::GONE,
            Json(serde_json::json!({"error": "session has exited"})),
        )
            .into_response();
    }
    st.audit(&session.name, "api", &body.command);
    let mut bytes = body.command.clone().into_bytes();
    bytes.push(b'\r');
    match session.write_input(&bytes) {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "session": session.id,
            "seq": session.latest_seq(),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct TranscriptQuery {
    session: String,
    since: Option<u64>,
    token: Option<String>,
}

async fn api_transcript(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TranscriptQuery>,
) -> impl IntoResponse {
    if let Err(code) = api_guard(&st, &headers, q.token.as_ref()) {
        return code.into_response();
    }
    let session = match st.get_session(&q.session) {
        Some(s) => s,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let since = q.since.unwrap_or(0);
    let text: String = {
        let t = session.transcript.lock().unwrap();
        t.iter()
            .filter(|(seq, _)| *seq > since)
            .map(|(_, s)| s.as_str())
            .collect()
    };
    Json(serde_json::json!({
        "session": session.id,
        "name": session.name,
        "seq": session.latest_seq(),
        "alive": session.alive.load(Ordering::SeqCst),
        "text": text,
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let path = config_path_from_args().unwrap_or_else(default_config_path);
    let (config, config_dir) = match load_or_create_config(&path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("failed to load config {}: {e}", path.display());
            std::process::exit(1);
        }
    };
    let addr = format!("{}:{}", config.bind, config.port);
    let state = AppState(Arc::new(Inner {
        config,
        config_dir,
        sessions: Mutex::new(HashMap::new()),
        counter: AtomicU64::new(0),
        audit_lock: Mutex::new(()),
    }));

    let app = Router::new()
        .route("/", get(index))
        .route("/sessions", get(list_sessions))
        .route("/sessions/:id", axum::routing::delete(kill_session))
        .route("/ws", get(ws_handler))
        .route("/api/sessions", get(api_sessions).post(api_create_session))
        .route("/api/exec", post(api_exec))
        .route("/api/transcript", get(api_transcript))
        .with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "browser-terminal listening on http://{addr}/?token={}",
        state.0.config.token
    );
    println!("config: {}", path.display());
    if state.0.config.api_enabled {
        println!("agent API: enabled");
    }
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
