"use strict";
/* bt-xterm-spike: vanilla xterm.js 6.0.0 wired to bt's server protocol.
 * Mirrors src/ui.html's connection/recovery behaviour, minus TermCore:
 *   WS  ws://<host>/ws?token=<t>&session=new|<id>
 *   srv -> cli : JSON {type:'session'|'cwd'|'error', ...}, then the
 *                scrollback as one binary frame, then live PTY output
 *                as binary frames.
 *   cli -> srv : JSON {type:'input', data} / {type:'resize', rows, cols}
 * Test hooks live on window.__spike. */
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const btPort = params.get("btport") || "17399";
const btHost = params.get("bthost") || location.hostname || "127.0.0.1";
const btOrigin = "http://" + btHost + ":" + btPort;
const btWsBase = "ws://" + btHost + ":" + btPort;

const statusEl = document.getElementById("status");
const sessionLabel = document.getElementById("sessionlabel");
const flashEl = document.getElementById("flash");
function setStatus(t) { statusEl.textContent = t; if (window.__spike) window.__spike.state.status = t; }
function flash(t) { flashEl.textContent = t; setTimeout(() => { flashEl.textContent = ""; }, 1500); }

const term = new Terminal({
  cols: 80, rows: 24,
  scrollback: Number(params.get("scrollback") || 10000),
  fontSize: 14, lineHeight: 1.25,
  fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  theme: { background: "#0c0f14", foreground: "#d8dee9", cursor: "#d8dee9" },
  allowProposedApi: true,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
const serializeAddon = new SerializeAddon.SerializeAddon();
term.loadAddon(serializeAddon);
term.open(document.getElementById("term"));
// Renderer choice: xterm 6's built-in renderer is DOM-based; the WebGL
// addon is the standard high-throughput option. ?renderer=webgl selects it.
let webglAddon = null;
if (params.get("renderer") === "webgl" && window.WebglAddon) {
  try {
    webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => { try { webglAddon.dispose(); } catch (e) {} webglAddon = null; });
    term.loadAddon(webglAddon);
  } catch (e) { webglAddon = null; }
}

// --- protocol ---------------------------------------------------------------
let ws = null;
let sessionId = params.get("session") || null;
let reconnectTimer = null;
let sameIdTried = false;
let deadSession = false;
let fallbackCount = 0;
const sentLog = []; // every payload term.onData produced (tests read this)

function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
    return true;
  }
  return false;
}
function sendResize(cols, rows) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", rows, cols }));
  }
}
function doFit() {
  try {
    const dims = fitAddon.proposeDimensions();
    if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
      term.resize(dims.cols, dims.rows);
      sendResize(dims.cols, dims.rows);
    }
  } catch (e) { /* container not laid out yet */ }
}
function resetRecovery() { sameIdTried = false; deadSession = false; fallbackCount = 0; }
function planReconnect() {
  if (reconnectTimer) return;
  if (fallbackCount > 3) { setStatus("disconnected (recovery exhausted)"); return; }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (deadSession || sameIdTried) fallbackAttach();
    else { sameIdTried = true; connect(); }
  }, 600);
}
async function fallbackAttach() {
  fallbackCount++;
  let list = null;
  try {
    const res = await fetch(btOrigin + "/sessions?token=" + encodeURIComponent(token));
    if (res.ok) list = await res.json();
  } catch (e) { /* server unreachable */ }
  if (!list) { planReconnect(); return; }
  deadSession = false; sameIdTried = false;
  const mine = sessionId && list.find((s) => s && s.id === sessionId && s.alive);
  if (!mine) {
    const alive = list.filter((s) => s && s.alive);
    sessionId = alive.length ? alive[alive.length - 1].id : null; // null -> fresh
  }
  connect();
}
function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    const old = ws; ws = null;
    old.onopen = old.onclose = old.onerror = old.onmessage = null;
    try { old.close(); } catch (e) {}
  }
  const q = new URLSearchParams({ token });
  q.set("session", sessionId || "new");
  const sock = new WebSocket(btWsBase + "/ws?" + q);
  ws = sock;
  sock.binaryType = "arraybuffer";
  setStatus("connecting…");
  sock.onopen = () => { setStatus("connected"); doFit(); term.focus(); };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setStatus("disconnected");
    planReconnect();
  };
  sock.onerror = () => { if (ws === sock) setStatus("error"); };
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { /* not JSON */ }
      if (msg && msg.type === "session") {
        resetRecovery();
        sessionId = msg.id;
        sessionLabel.textContent = msg.name + " (" + msg.id + ")" + (msg.alive ? "" : " exited");
        setStatus("connected — " + msg.name);
        // Fresh attach: the server replays scrollback right after this
        // message, so reset first to restore the screen exactly.
        term.reset();
        return;
      }
      if (msg && msg.type === "error") {
        if (msg.code === "no_such_session") deadSession = true;
        setStatus("error: " + msg.message);
        return;
      }
      if (msg) return; // cwd etc.: not needed for the spike
      term.write(ev.data);
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
}
term.onData((data) => { sentLog.push(data); sendInput(data); });
term.onResize(({ cols, rows }) => sendResize(cols, rows));
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doFit, 150);
});
document.getElementById("reconnect").onclick = () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  fallbackCount = 0;
  if (deadSession) fallbackAttach();
  else { sameIdTried = false; connect(); }
};

// --- screen text / PNG from the xterm buffer (screenshot alternatives) ------
const PALETTE256 = (() => {
  const p = ["#0c0c0c","#c50f1f","#13a10e","#c19c00","#0037da","#881798","#3a96dd","#cccccc",
             "#767676","#e74856","#16c60c","#f9f1a5","#3b78ff","#b4009e","#61d6d6","#f2f2f2"];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
    p.push("rgb(" + levels[r] + "," + levels[g] + "," + levels[b] + ")");
  for (let i = 0; i < 24; i++) { const v = 8 + 10 * i; p.push("rgb(" + v + "," + v + "," + v + ")"); }
  return p;
})();
// xterm color modes: get*ColorMode() returns the raw attribute bitfield,
// not a small enum (src/common/buffer/Constants.ts): mask with 0x3000000 —
// 0x2000000 = palette index, 0x3000000 = RGB (value packed 0xRRGGBB),
// 0 = default. Verified empirically against known cells.
function cellColor(cell, isBg) {
  const mode = (isBg ? cell.getBgColorMode() : cell.getFgColorMode()) & 0x3000000;
  const val = isBg ? cell.getBgColor() : cell.getFgColor();
  if (mode === 0x2000000) return PALETTE256[val] || (isBg ? "#0c0f14" : "#d8dee9");
  if (mode === 0x3000000)
    return "rgb(" + ((val >> 16) & 255) + "," + ((val >> 8) & 255) + "," + (val & 255) + ")";
  return isBg ? "#0c0f14" : "#d8dee9";
}
function visibleTextViaBuffer() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
  }
  return lines.join("\n");
}
function screenToCanvasViaBuffer() {
  const buf = term.buffer.active;
  // Cell metrics from xterm's own render service dimensions.
  const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
  const cellW = dims ? dims.css.cell.width : 8.4;
  const cellH = dims ? dims.css.cell.height : 17.5;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const wCss = term.cols * cellW, hCss = term.rows * cellH;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(wCss * scale); cv.height = Math.ceil(hCss * scale);
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0c0f14";
  ctx.fillRect(0, 0, wCss, hCss);
  ctx.textBaseline = "middle";
  const cell = buf.getNullCell();
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      let fg = cellColor(cell, false), bg = cellColor(cell, true);
      if (cell.isInverse()) { const t = fg; fg = bg; bg = t; }
      const x0 = x * cellW, y0 = y * cellH;
      if (bg !== "#0c0f14") { ctx.fillStyle = bg; ctx.fillRect(x0, y0, w * cellW, cellH); }
      const chars = cell.getChars();
      if (chars && chars !== " ") {
        ctx.font = (cell.isItalic() ? "italic " : "") + (cell.isBold() ? "bold " : "") +
          "14px " + term.options.fontFamily;
        ctx.globalAlpha = cell.isDim() ? 0.6 : 1;
        ctx.fillStyle = fg;
        ctx.fillText(chars, x0, y0 + cellH / 2);
        ctx.globalAlpha = 1;
      }
    }
  }
  return cv;
}
document.getElementById("copyscreen").onclick = async () => {
  const text = visibleTextViaBuffer();
  try { await navigator.clipboard.writeText(text); flash("Copied"); }
  catch (e) { flash("Copy failed"); }
  term.focus();
};
document.getElementById("shot").onclick = () => {
  screenToCanvasViaBuffer().toBlob((blob) => {
    if (!blob) { flash("Failed"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spike-screen.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flash("Saved");
  }, "image/png");
  term.focus();
};

window.__spike = {
  term, fitAddon, serializeAddon,
  get rendererActive() { return webglAddon ? "webgl" : "dom"; },
  state: { status: "init" },
  sentLog,
  sendInput,
  connect,
  disconnect() { if (ws) { const s = ws; ws = null; s.onclose = null; try { s.close(); } catch (e) {} } },
  get sessionId() { return sessionId; },
  setSession(id) { sessionId = id; },
  visibleTextViaBuffer,
  screenToCanvasViaBuffer,
};
connect();
