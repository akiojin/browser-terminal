// Unit tests for the TermCore emulator embedded in src/ui.html.
// Extracts the code between the TERM-CORE markers and exercises it.
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "ui.html"), "utf8");
const begin = html.indexOf("/* === TERM-CORE-BEGIN === */");
const end = html.indexOf("/* === TERM-CORE-END === */");
if (begin < 0 || end < 0) { console.error("FAIL: TERM-CORE markers not found"); process.exit(1); }
const src = html.slice(begin, end);
const TermCore = new Function(src + "\nreturn TermCore;")();

let failures = 0;
function eq(actual, expected, name) {
  if (actual === expected) console.log("PASS: " + name);
  else { failures++; console.log("FAIL: " + name + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual)); }
}
function ok(cond, name) { eq(!!cond, true, name); }

// 1. CR overwrite: "hello\rH" -> "Hello"
{
  const t = new TermCore(80, 24);
  t.feed("hello\rH");
  eq(t.lineText(0), "Hello", "CR overwrite hello\\rH -> Hello");
}

// 2. \\r progress overwrite: printf 'a\\rb\\n'
{
  const t = new TermCore(80, 24);
  t.feed("a\rb\n");
  eq(t.lineText(0), "b", "progress overwrite a\\rb -> b");
}

// 3. Line-editing redraw: full-line redraw with EL (bash/zsh style)
{
  const t = new TermCore(80, 24);
  t.feed("echo abc\r\x1b[Kecho abd");
  eq(t.lineText(0), "echo abd", "redraw with CR + CSI K");
}
// 3b. Cursor-forward + EL
{
  const t = new TermCore(80, 24);
  t.feed("abcdef\r\x1b[3C\x1b[K");
  eq(t.lineText(0), "abc", "cursor forward + EL to end");
}
// 3c. Backspace moves cursor back; next char overwrites
{
  const t = new TermCore(80, 24);
  t.feed("abc\x08\x08X");
  eq(t.lineText(0), "aXc", "backspace overwrite");
}

// 4. SGR colors land on cells
{
  const t = new TermCore(80, 24);
  t.feed("\x1b[31mR\x1b[0mN");
  eq(t.cell(0, 0).s.fg, 1, "SGR 31 -> fg palette 1");
  eq(t.cell(1, 0).s.fg, null, "SGR 0 resets fg");
  const t2 = new TermCore(80, 24);
  t2.feed("\x1b[1;38;5;196mX\x1b[48;2;10;20;30mY");
  eq(t2.cell(0, 0).s.fg, 196, "SGR 38;5;196 -> fg 196");
  eq(t2.cell(0, 0).s.bold, true, "SGR 1 -> bold");
  eq(t2.cell(1, 0).s.bg, "rgb(10,20,30)", "SGR 48;2 -> truecolor bg");
}

// 5. Scrollback: lines flow out of a 3-row screen
{
  const t = new TermCore(10, 3);
  t.feed("l1\r\nl2\r\nl3\r\nl4\r\nl5");
  eq(t.scrollback.map(r => t.rowText(r)).join(","), "l1,l2", "scrollback holds l1,l2");
  eq(t.screenText(), "l3\nl4\nl5", "screen shows l3..l5");
}

// 6. DECAWM wrap
{
  const t = new TermCore(5, 4);
  t.feed("abcdefgh");
  eq(t.lineText(0), "abcde", "wrap: line0 full");
  eq(t.lineText(1), "fgh", "wrap: line1 continues");
}
// 6b. Wrap off (?7l): last column is overwritten
{
  const t = new TermCore(5, 4);
  t.feed("\x1b[?7labcdefg");
  eq(t.lineText(0), "abcdg", "DECAWM off: last col overwritten");
}

// 7. Alternate screen: enter, draw, leave -> main screen restored
{
  const t = new TermCore(20, 4);
  t.feed("main");
  t.feed("\x1b[?1049hALT");
  eq(t.lineText(0), "ALT", "alt screen shows ALT");
  t.feed("\x1b[?1049l");
  eq(t.lineText(0), "main", "leaving alt screen restores main");
}

// 7b. Mouse modes: tracking + SGR flags follow DECSET/DECRST
{
  const t = new TermCore(20, 4);
  eq(t.mouseModes.size, 0, "mouse modes start empty");
  t.feed("\x1b[?1002h\x1b[?1006h");
  eq(t.mouseModes.has(1002) && t.mouseModes.has(1006), true, "mouse modes tracked on DECSET");
  t.feed("\x1b[?1006l");
  eq(t.mouseModes.has(1006), false, "SGR flag clears on DECRST");
  eq(t.mouseModes.has(1002), true, "tracking mode survives SGR clear");
  t.feed("\x1b[?1002l");
  eq(t.mouseModes.size, 0, "all mouse modes clear");
}

// 8. Insert / delete chars, insert lines
{
  const t = new TermCore(20, 4);
  t.feed("abcd\r\x1b[2@");  // insert 2 blanks at start
  eq(t.lineText(0), "  abcd", "ICH inserts blanks");
  t.feed("\x1b[2P");        // delete 2 chars at cursor (cursor at col 2)
  eq(t.lineText(0), "abcd", "DCH deletes chars");
}
{
  const t = new TermCore(20, 4);
  t.feed("one\r\ntwo\r\nthree\x1b[2;1H\x1b[L");
  eq(t.screenText(), "one\n\ntwo\nthree", "IL inserts a blank line");
}

// 9. ED / EL modes
{
  const t = new TermCore(10, 3);
  t.feed("aaa\r\nbbb\r\nccc\x1b[2J");
  eq(t.screenText(), "\n\n", "ED 2 clears screen");
  const t2 = new TermCore(10, 3);
  t2.feed("hello\r\x1b[2K");
  eq(t2.lineText(0), "", "EL 2 clears line");
}

// 10. Scroll region: lines scroll only inside the region
{
  const t = new TermCore(10, 4);
  t.feed("r0\r\nr1\r\nr2\r\nr3");
  t.feed("\x1b[2;3r");      // region rows 2..3 (1-based)
  t.feed("\x1b[3;1H");      // cursor to region bottom
  t.feed("\r\nNEW");
  eq(t.lineText(0), "r0", "scroll region: row above untouched");
  eq(t.lineText(3), "r3", "scroll region: row below untouched");
  eq(t.lineText(2), "NEW", "scroll region: new line at region bottom");
}

// 11. DSR: cursor position report goes through onResponse
{
  const t = new TermCore(80, 24);
  let resp = null;
  t.onResponse = (s) => { resp = s; };
  t.feed("ab\x1b[6n");
  eq(resp, "\x1b[1;3R", "DSR 6n reports cursor position");
}

// 12. Wide (CJK) characters occupy 2 cells
{
  const t = new TermCore(10, 2);
  t.feed("あい");
  eq(t.cell(0, 0).w, 2, "wide char width flag");
  eq(t.cell(1, 0).w, 0, "wide char continuation cell");
  eq(t.cx, 4, "cursor advanced by 4 for two wide chars");
  eq(t.lineText(0), "あい", "wide char line text");
}

// 13. Tab stops every 8
{
  const t = new TermCore(40, 2);
  t.feed("a\tb");
  eq(t.lineText(0), "a       b", "tab moves to next multiple of 8");
}

// 14. Chunked feed: escape sequence split across feeds
{
  const t = new TermCore(80, 24);
  t.feed("\x1b[3");
  t.feed("1mR");
  eq(t.cell(0, 0).s.fg, 1, "CSI split across chunks still parses");
}

// 15. OSC is consumed (window title does not leak onto the screen)
{
  const t = new TermCore(80, 24);
  t.feed("\x1b]0;my title\x07ok");
  eq(t.lineText(0), "ok", "OSC sequence consumed");
}

// 16. Scroll region with DECSTBM + reverse index at top
{
  const t = new TermCore(10, 3);
  t.feed("a\r\nb\r\nc");
  t.feed("\x1b[1;1H\x1bM"); // RI at top of full-screen region scrolls down
  eq(t.lineText(0), "", "RI inserts blank at top");
  eq(t.lineText(1), "a", "RI shifts content down");
}

// 17. Prefixed CSI is NOT the plain sequence: CSI > 4 ; 2 m is XTMODKEYS
// (modifyOtherKeys), not SGR -- it must not switch on underline/dim.
{
  const t = new TermCore(80, 24);
  t.feed("\x1b[>4;2mX");
  eq(t.cell(0, 0).s.underline, false, "CSI >4;2m does not set underline (XTMODKEYS)");
  eq(t.cell(0, 0).s.dim, false, "CSI >4;2m does not set dim (XTMODKEYS)");
  const t2 = new TermCore(80, 24);
  t2.feed("\x1b[4mX");
  eq(t2.cell(0, 0).s.underline, true, "plain CSI 4m still sets underline");
}

// 18. Prefixed CSI u is the Kitty keyboard protocol, not SCOR cursor restore.
{
  const t = new TermCore(80, 24);
  t.feed("ab\x1b[s");            // save cursor at (2,0)
  t.feed("\r\n\r\nXYZ");         // move away, cursor ends at (3,2)
  const before = [t.cx, t.cy];
  t.feed("\x1b[>5u");            // kitty: push keyboard flags
  eq([t.cx, t.cy].join(","), before.join(","), "CSI >5u does not restore cursor (kitty push)");
  t.feed("\x1b[<u");             // kitty: pop keyboard flags
  eq([t.cx, t.cy].join(","), before.join(","), "CSI <u does not restore cursor (kitty pop)");
  t.feed("\x1b[?u");             // kitty: query keyboard flags
  eq([t.cx, t.cy].join(","), before.join(","), "CSI ?u does not restore cursor (kitty query)");
  t.feed("\x1b[u");              // plain SCOR: restores the saved position
  eq([t.cx, t.cy].join(","), "2,0", "plain CSI u still restores cursor");
}

// 19. DA response only for the unprefixed primary query.
{
  const t = new TermCore(80, 24);
  let resp = null;
  t.onResponse = (s) => { resp = s; };
  t.feed("\x1b[>0c");
  eq(resp, null, "CSI >0c (secondary DA) gets no primary DA response");
  t.feed("\x1b[c");
  ok(resp !== null && resp.indexOf("\x1b[?") === 0, "plain CSI c still answers primary DA");
}

// 23. visibleText: the window the UI shows at a scroll offset (Copy screen)
{
  const t = new TermCore(10, 3);
  t.feed("l1\r\nl2\r\nl3\r\nl4\r\nl5");
  eq(t.visibleText(0), "l3\nl4\nl5", "visibleText(0) is the live screen");
  eq(t.visibleText(0), t.screenText(), "visibleText(0) matches screenText");
  eq(t.visibleText(1), "l2\nl3\nl4", "visibleText(1) scrolls one line back");
  eq(t.visibleText(2), "l1\nl2\nl3", "visibleText(2) reaches the scrollback top");
  eq(t.visibleText(99), "l1\nl2\nl3", "visibleText clamps past the scrollback top");
  const t2 = new TermCore(10, 3);
  t2.feed("only");
  eq(t2.visibleText(0), "only\n\n", "visibleText keeps blank rows on a short screen");
}

// --- Real-stream fixtures (recorded with script(1) / tmux pipe-pane) --------
// lessHosts:   GNU less 590 painting /etc/hosts (16 lines) at 177x40,
//              TERM=xterm-256color, full session including quit.
// lessRepaint: GNU less 590 on a 3-line file at 60x12, with a Ctrl-L repaint
//              (the repaint emits the "~" past-EOF filler lines).
// claudeBoot:  Claude Code 2.1.323 first-run screen inside tmux at 177x40.
const FIXTURES = {
  lessHosts: "G1s/MTA0OWgbWzIyOzA7MHQbWz8xaBs9DSMgTWFuYWdlZCBieSBzcGF3bmQuIFN0YXRpYyBydW50aW1lLWNlbGwgL2V0Yy9ob3N0cywgcmVuZGVyZWQgZnJvbSBpbnN0YWxsLXRpbWUNCiMgY29uc3RhbnRzIGFuZCBiaW5kLW1vdW50ZWQgcmVhZC1vbmx5IGludG8gdGhlIGNlbGwgKGFuZCBwcml2c2VwIHdvcmtlcnMpLg0KIyBUaGlzIGZpbGUgaXMgYXV0aG9yaXRhdGl2ZSBhbmQgY29tcGxldGU6IGl0IGlzIE5PVCBtZXJnZWQgd2l0aCBhbnkgaW5oZXJpdGVkDQojIHJvb3RmcyBlbnRyeS4gQWxsIHZhbHVlcyBhcmUgc3RhdGljIHJlbmRlciBjb25zdGFudHMsIHNvIHRoZSBjb250ZW50IGlzIHN0YWJsZQ0KIyBhY3Jvc3MgYm9vdHMgYW5kIGlkZW50aWNhbCBvbiBldmVyeSBWTSBvZiBhIGdpdmVuIGltYWdlLg0KMTI3LjAuMC4xIGxvY2FsaG9zdA0KOjoxIGxvY2FsaG9zdCBpcDYtbG9jYWxob3N0IGlwNi1sb29wYmFjaw0KIyBNYXAgdGhlIGNlbGwncyBvd24gaG9zdG5hbWUgdG8gbG9vcGJhY2sgaW4gYm90aCBmYW1pbGllcyBzbyBzdWRvL3N5c3RlbWN0bA0KIyBob3N0bmFtZSBjYW5vbmljYWxpemF0aW9uIHJlc29sdmVzIHZpYSBOU1MgZmlsZXMgaW5zdGVhZCBvZiBzdGFsbGluZyB+MzBzIG9uIGENCiMgRE5TIHF1ZXJ5IHRvIHRoZSBlZ3Jlc3MgZ2F0ZXdheSwgd2hpY2ggY2Fubm90IHJlc29sdmUgdGhlIGludGVybmFsIG1hY2hpbmUgbmFtZS4NCjEyNy4wLjEuMSBodGNoLXJ1bnRpbWUNCjo6MSBodGNoLXJ1bnRpbWUNCiMgRWdyZXNzIHByb3h5IGFsaWFzZXMuIFRoZSBjZWxsIChhbmQgR1dTIHByaXZzZXAgd29ya2VycyB0aGF0IGluaGVyaXQgdGhlIGNlbGwNCiMgcHJveHkgZW52KSByZXNvbHZlIGhhdGNoLWVncmVzcy1wcm94eSB0byB0aGUgdmV0aCBnYXRld2F5IGFkZHJlc3MuDQoxOTguMTkuMC4xIGhhdGNoLWVncmVzcy1wcm94eQ0KZmQ4Yjo0Zjg0OjdkMzI6OTk6OjEgaGF0Y2gtZWdyZXNzLXByb3h5DQobWzdtL2V0Yy9ob3N0cyAoRU5EKRtbMjdtG1tLDRtbSxtbPzFsGz4bWz8xMDQ5bBtbMjM7MDswdAo=",
  lessRepaint: "G1s/MTA0OWgbWzIyOzA7MHQbWz8xaBs9DWFscGhhDQpiZXRhDQpnYW1tYQ0KG1s3bXRpbnkudHh0IChFTkQpG1syN20bW0sNG1tLLi4uc2tpcHBpbmcuLi4NCmFscGhhDQpiZXRhDQpnYW1tYQ0KG1sxbX4bWzBtDQobWzFtfhtbMG0NChtbMW1+G1swbQ0KG1sxbX4bWzBtDQobWzFtfhtbMG0NChtbMW1+G1swbQ0KG1sxbX4bWzBtDQobWzFtfhtbMG0NChtbN20oRU5EKRtbMjdtG1tLDRtbSxtbPzFsGz4bWz8xMDQ5bBtbMjM7MDswdAo=",
  claudeBoot: "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4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWM4pWMG1szOW0NDQobWzJHG1szODs1OzIzMW0bWzJtIDEbWzVHG1syMm0gG1szODs1OzgxbWZ1bmN0aW9uG1szODs1OzIzMW0gG1szODs1OzE0OG1ncmVldBtbMzg7NTsyMzFtKCkbWzIzR3sbWzM5bQ0NChtbMkcbWzM4OzU7MTY3bRtbNDg7NTs1Mm0gMiAtG1szODs1OzIzMW0gIGNvbnNvbGUubG9nKCJIZWxsbywgV29ybGQhIik7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIBtbMzltG1s0OW0NDQobWzJHG1szODs1Ozc3bRtbNDg7NTsyMm0gMiArG1szODs1OzIzMW0gIGNvbnNvbGUuG1szODs1OzE0OG1sb2cbWzM4OzU7MjMxbSgbWzM4OzU7MTg2bSJIZWxsbywgG1s0ODs1OzI4bUNsYXVkZRtbNDg7NTsyMm0hIhtbMzg7NTsyMzFtKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAbWzM5bRtbNDltDQ0KG1syRxtbMzg7NTsyMzFtG1sybSAzG1s1RxtbMjJtIH0bWzM5bQ0NChtbMkcbWzM4OzU7MjM5beKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjOKVjBtbMzltDQ0KG1syRxtbMzg7NTsyNDZtIFN5bnRheBtbMTBHdGhlbWU6G1sxN0dNb25va2FpG1syNUdFeHRlbmRlZBtbMzRHKGN0cmwrdBtbNDJHdG8bWzQ1R2Rpc2FibGUpG1szOW0NDQobWzFDG1sxNEE=",
};
function fixture(name) { return Buffer.from(FIXTURES[name], "base64").toString("utf8"); }
function splitAfter(s, marker) { // [through marker, rest]
  const i = s.indexOf(marker);
  return i < 0 ? [s, ""] : [s.slice(0, i + marker.length), s.slice(i + marker.length)];
}

// 20. Real less stream: content is painted from row 0 in the alt screen and
// leaving less restores the main screen.
{
  const t = new TermCore(177, 40);
  t.feed("user@mac ~ % less /etc/hosts\r\n");
  const stream = fixture("lessHosts");
  const [active, quit] = splitAfter(stream, "/etc/hosts (END)\x1b[27m");
  t.feed(active);
  eq(t.altActive, true, "less: alt screen active while running");
  ok(t.lineText(0).indexOf("# Managed by spawnd") === 0, "less: content starts at row 0");
  ok(t.lineText(5).indexOf("127.0.0.1 localhost") === 0, "less: hosts entry on row 5");
  ok(t.lineText(15).indexOf("fd8b:4f84:7d32:99::1 hatch-egress-proxy") === 0, "less: last hosts line on row 15");
  ok(t.lineText(16).indexOf("/etc/hosts (END)") === 0, "less: (END) status on row 16");
  eq(t.cell(0, 16).s.reverse, true, "less: (END) status is reverse video");
  t.feed(quit);
  eq(t.altActive, false, "less: alt screen left after quit");
  ok(t.lineText(0).indexOf("user@mac ~ % less /etc/hosts") === 0, "less: main screen restored after quit");
}

// 21. Real less repaint (Ctrl-L): the repaint repaints the whole screen by
// scrolling; the final grid is content rows, bold "~" filler rows, then the
// (END) status on the last row.
{
  const t = new TermCore(60, 12);
  const stream = fixture("lessRepaint");
  // The first paint's status also contains "(END)"; cut after the LAST one,
  // which ends the Ctrl-L repaint (the quit tail that follows is not fed).
  const i = stream.lastIndexOf("(END)\x1b[27m");
  t.feed(stream.slice(0, i + "(END)\x1b[27m".length));
  eq(t.altActive, true, "less repaint: alt screen active");
  eq(t.lineText(0), "alpha", "less repaint: row 0 is first content line");
  eq(t.lineText(1), "beta", "less repaint: row 1");
  eq(t.lineText(2), "gamma", "less repaint: row 2");
  eq(t.lineText(3), "~", "less repaint: tilde filler starts at row 3");
  eq(t.lineText(10), "~", "less repaint: tilde filler reaches row 10");
  eq(t.cell(0, 3).s.bold, true, "less repaint: tildes are bold");
  eq(t.lineText(11), "(END)", "less repaint: (END) on the last row");
  eq(t.cell(0, 11).s.reverse, true, "less repaint: (END) is reverse video");
}

// 22. Real Claude Code 2.1.323 boot stream: words are placed with CHA and the
// frame must not collapse or pick up stray attributes from prefixed CSI
// (XTMODKEYS CSI >4;2m, kitty keyboard CSI >5u / <u / ?u).
{
  const t = new TermCore(177, 40);
  t.feed(fixture("claudeBoot"));
  const rows = [];
  for (let y = 0; y < 40; y++) rows.push(t.lineText(y));
  const rowOf = (text) => rows.findIndex(r => r.indexOf(text) >= 0);
  eq(rows[1], "Welcome to Claude Code v2.1.323", "claude: banner intact on row 1 (no overwrite interleave)");
  eq(t.cell(0, 1).s.underline, false, "claude: banner not underlined by XTMODKEYS mis-parse");
  eq(t.cell(0, 1).s.dim, false, "claude: banner not dimmed by XTMODKEYS mis-parse");
  ok(rowOf("Let's get started.") > 1, "claude: 'Let's get started.' on its own row below the banner");
  ok(rowOf("Choose the text style") > rowOf("Let's get started."), "claude: theme prompt below greeting");
  ok(rowOf("Dark mode") > rowOf("Choose the text style"), "claude: theme options below prompt");
  ok(rowOf("function greet()") > rowOf("Dark mode"), "claude: preview code below options");
  ok(rowOf("Syntax theme:") > rowOf("function greet()"), "claude: syntax theme line below preview");
  ok(rowOf("Syntax theme:") >= 20, "claude: frame keeps full height (no vertical collapse)");
}

// 23. Paste payload shaping: newline normalization and bracketed paste.
{
  const t = new TermCore(80, 24);
  eq(t.pastePayload("ls -la"), "ls -la", "paste: plain single line unchanged");
  eq(t.pastePayload("echo a\necho b"), "echo a\recho b", "paste: LF becomes CR without bracketed paste");
  eq(t.pastePayload("echo a\r\necho b"), "echo a\recho b", "paste: CRLF normalized to one CR");
  eq(t.pastePayload("echo a\recho b"), "echo a\recho b", "paste: lone CR treated as newline");
  eq(t.pastePayload("make test\n"), "make test\r", "paste: trailing newline kept (runs the command)");
  eq(t.pastePayload(""), "", "paste: empty text stays empty");
  t.feed("\x1b[?2004h");
  eq(t.bracketedPaste, true, "paste: DECSET 2004 tracked");
  eq(t.pastePayload("echo a\necho b"), "\x1b[200~echo a\necho b\x1b[201~", "paste: bracketed paste wraps, LF kept inside");
  eq(t.pastePayload("echo a\r\necho b"), "\x1b[200~echo a\necho b\x1b[201~", "paste: bracketed paste normalizes CRLF to LF");
  eq(t.pastePayload("a\x1b[201~b"), "\x1b[200~ab\x1b[201~", "paste: embedded end marker stripped");
  t.feed("\x1b[?2004l");
  eq(t.pastePayload("echo a\necho b"), "echo a\recho b", "paste: DECRST 2004 restores plain payload");
}

// 24. UI helpers: click-to-focus decision for drag selection.
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  if (hBegin < 0 || hEnd < 0) { console.error("FAIL: UI-HELPERS markers not found"); process.exit(1); }
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { clickShouldFocusIme, screenshotFileName, canShareScreenshot, shareFallbackAction, formatSessionError, errorBarAfterEvent };")();
  eq(helpers.clickShouldFocusIme(""), true, "ui: plain click (no selection) focuses IME");
  eq(helpers.clickShouldFocusIme("selected text"), false, "ui: click ending a drag selection keeps the selection");
  eq(helpers.screenshotFileName(new Date("2026-11-16T16:06:27.891Z")), "browser-terminal-2026-11-16T16-06-27.png",
     "ui: screenshot file name format");
  const fakeFile = { name: "x.png", type: "image/png" };
  eq(helpers.canShareScreenshot(null, fakeFile), false, "ui: no navigator -> no share");
  eq(helpers.canShareScreenshot({}, fakeFile), false, "ui: share API missing -> no share");
  eq(helpers.canShareScreenshot({ share() {} }, fakeFile), false, "ui: canShare missing -> no share");
  eq(helpers.canShareScreenshot({ share() {}, canShare: () => false }, fakeFile), false,
     "ui: canShare false for files -> no share");
  eq(helpers.canShareScreenshot({ share() {}, canShare: () => true }, fakeFile), true,
     "ui: canShare true for files -> share");
  eq(helpers.canShareScreenshot({ share() {}, canShare() { throw new Error("x"); } }, fakeFile), false,
     "ui: canShare throwing -> no share");
  eq(helpers.shareFallbackAction({ name: "AbortError" }), "ignore", "ui: share cancel -> do nothing");
  eq(helpers.shareFallbackAction({ name: "NotAllowedError" }), "download", "ui: other share error -> download");
  eq(helpers.shareFallbackAction(null), "download", "ui: unknown share error -> download");
}

// 25. UI helpers: the session error bar keeps the last creation failure
// visible across the socket close and clears it on the next success.
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { formatSessionError, errorBarAfterEvent };")();
  eq(helpers.formatSessionError("spawn shell failed: posix_spawnp failed."),
     "Failed to start session: spawn shell failed: posix_spawnp failed.",
     "errbar: server message is prefixed for display");
  eq(helpers.formatSessionError(""), "Failed to start session", "errbar: empty message still names the failure");
  eq(helpers.formatSessionError(undefined), "Failed to start session", "errbar: missing message still names the failure");
  eq(helpers.formatSessionError("  no such session  "), "Failed to start session: no such session",
     "errbar: message is trimmed");

  let text = "";
  text = helpers.errorBarAfterEvent(text, { type: "error", message: "spawn shell failed: posix_spawnp failed." });
  eq(text, "Failed to start session: spawn shell failed: posix_spawnp failed.", "errbar: error event sets the text");
  text = helpers.errorBarAfterEvent(text, { type: "close" });
  ok(text.length > 0, "errbar: socket close does NOT clear the error");
  text = helpers.errorBarAfterEvent(text, { type: "open" });
  ok(text.length > 0, "errbar: socket open does NOT clear the error");
  text = helpers.errorBarAfterEvent(text, { type: "error", message: "no such session" });
  eq(text, "Failed to start session: no such session", "errbar: a newer error replaces the older one");
  text = helpers.errorBarAfterEvent(text, { type: "session", id: "abcd1234", name: "shell-1", alive: true });
  eq(text, "", "errbar: a successful session clears the error");
  eq(helpers.errorBarAfterEvent("", null), "", "errbar: null event keeps empty state");
  eq(helpers.errorBarAfterEvent("x", {}), "x", "errbar: typeless event keeps current text");
}

// 26. Wide chars: overwriting or erasing either half erases the whole
// char (regression tests from bt-freeze-repro/repro-b-widechar.js — a
// leftover half used to render as a stale glyph over TUI input lines).
{
  const t = new TermCore(20, 3);
  t.feed("あいうえお");
  t.feed("\x1b[1;2H"); // cx = 1: continuation cell of あ
  t.feed("X");
  eq(t.lineText(0), " Xいうえお", "wide: overwrite continuation cell erases the lead too");

  const t2 = new TermCore(20, 3);
  t2.feed("あいう");
  t2.feed("\x1b[1;4H"); // cx = 3: continuation cell of い
  t2.feed("\x1b[K");
  eq(t2.lineText(0), "あ", "wide: EL from a continuation cell erases the whole char");

  const t3 = new TermCore(20, 3);
  t3.feed("あいう");
  t3.feed("\x1b[1;2H"); // cx = 1: continuation cell of あ
  t3.feed("\x1b[1P");
  eq(t3.lineText(0), "あう", "wide: DCH at a continuation cell does not split the char");

  const t4 = new TermCore(20, 3);
  t4.feed("abcde");
  t4.feed("\x1b[1;2H");
  t4.feed("X");
  eq(t4.lineText(0), "aXcde", "wide: narrow overwrite unchanged (control)");

  const t5 = new TermCore(20, 3);
  t5.feed("あい");
  t5.feed("\x1b[1;1H"); // cx = 0: lead cell of あ
  t5.feed("X");
  eq(t5.lineText(0), "X い", "wide: overwrite lead cell erases the continuation too");

  const t6 = new TermCore(20, 3);
  t6.feed("ab");
  t6.feed("\x1b[1;1H");
  t6.feed("あ");
  eq(t6.lineText(0), "あ", "wide: wide char overwrites two narrow cells cleanly");

  const t7 = new TermCore(20, 3);
  t7.feed("あいう");
  t7.feed("\x1b[1;4H"); // cx = 3: continuation cell of い
  t7.feed("\x1b[1X");   // ECH 1 (erase in place, no shift)
  eq(t7.lineText(0), "あ  う", "wide: ECH on a continuation cell erases the whole char");

  const t8 = new TermCore(20, 3);
  t8.feed("あいう");
  t8.feed("\x1b[1;2H"); // cx = 1: continuation cell of あ
  t8.feed("\x1b[1@");   // ICH 1
  eq(t8.lineText(0), "あ いう", "wide: ICH at a continuation cell does not split the char");
}

// 27. UI helpers: session recovery after the attached session is gone
// (server restart / idle destroy). The fallback picks a live session
// other than the dead one, or null -> create a fresh session.
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { pickRecoverySession, reconnectDelayMs };")();
  const list = [
    { id: "dead1", alive: true },
    { id: "live1", alive: true },
    { id: "gone1", alive: false },
    { id: "live2", alive: true },
  ];
  eq(helpers.pickRecoverySession(list, "dead1"), "live1", "recovery: first live session other than the dead one");
  eq(helpers.pickRecoverySession(list, "nosuch"), "dead1", "recovery: unknown exclude id -> first live session");
  eq(helpers.pickRecoverySession([{ id: "a", alive: false }], "x"), null, "recovery: no live session -> null (create fresh)");
  eq(helpers.pickRecoverySession([], "x"), null, "recovery: empty list -> null");
  eq(helpers.pickRecoverySession(null, "x"), null, "recovery: non-array list -> null");
  eq(helpers.pickRecoverySession(undefined, "x"), null, "recovery: missing list -> null");

  eq(helpers.reconnectDelayMs(0), 500, "recovery: backoff starts at 500ms");
  eq(helpers.reconnectDelayMs(1), 1000, "recovery: backoff doubles");
  eq(helpers.reconnectDelayMs(2), 2000, "recovery: backoff doubles again");
  eq(helpers.reconnectDelayMs(3), 4000, "recovery: backoff keeps doubling");
  eq(helpers.reconnectDelayMs(4), 8000, "recovery: backoff caps at 8s");
  eq(helpers.reconnectDelayMs(10), 8000, "recovery: backoff stays capped");
  eq(helpers.reconnectDelayMs(-1), 500, "recovery: negative attempt clamps to the start");
}

// 28. Synchronized update (?2026): TermCore tracks the open/close state so
// the UI can hold painting until the frame is final.
{
  const t = new TermCore(80, 24);
  eq(t.syncUpdate, false, "?2026: initially off");
  t.feed("\x1b[?2026h");
  eq(t.syncUpdate, true, "?2026: h opens a synchronized update");
  t.feed("abc");
  eq(t.syncUpdate, true, "?2026: still open while content lands");
  eq(t.lineText(0), "abc", "?2026: content is applied to the grid while open");
  t.feed("\x1b[?2026l");
  eq(t.syncUpdate, false, "?2026: l closes the update");
  // Split across feeds: the CSI itself may straddle a chunk boundary.
  const t2 = new TermCore(80, 24);
  t2.feed("\x1b[?202");
  eq(t2.syncUpdate, false, "?2026: partial CSI does not open early");
  t2.feed("6h");
  eq(t2.syncUpdate, true, "?2026: split CSI still opens");
  // Combined with other private modes in one sequence.
  const t3 = new TermCore(80, 24);
  t3.feed("\x1b[?2026;1006h");
  eq(t3.syncUpdate, true, "?2026: combined params open the update");
  ok(t3.mouseModes.has(1006), "?2026: combined params keep other modes");
  t3.feed("\x1b[?2026l");
  eq(t3.syncUpdate, false, "?2026: close after combined open");
  // Reset (session re-attach) must not leave a stale open state behind.
  t3.feed("\x1b[?2026h");
  t3.resetAll();
  eq(t3.syncUpdate, false, "?2026: resetAll clears the open state");
}

// 29. UI helpers: the ?2026 paint decision — hold while a block is open,
// arm the fallback timer only once, render as soon as no block is open.
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { syncHoldAction };")();
  eq(helpers.syncHoldAction(false, false), "render", "syncHold: no block -> render");
  eq(helpers.syncHoldAction(false, true), "render", "syncHold: block closed with timer pending -> render");
  eq(helpers.syncHoldAction(true, false), "hold", "syncHold: block open, no timer -> hold (arm fallback)");
  eq(helpers.syncHoldAction(true, true), "wait", "syncHold: block open, timer armed -> wait");
}

// 30. TermCore counts ?2026 block closes (syncClosed): the paint path
// uses the counter to notice that a frame became final inside a feed.
{
  const t = new TermCore(80, 24);
  eq(t.syncClosed, 0, "?2026 count: starts at 0");
  t.feed("\x1b[?2026h");
  eq(t.syncClosed, 0, "?2026 count: open does not count");
  t.feed("\x1b[?2026l");
  eq(t.syncClosed, 1, "?2026 count: close counts once");
  t.feed("\x1b[?2026l");
  eq(t.syncClosed, 1, "?2026 count: redundant close does not count");
  t.feed("\x1b[?2026h\x1b[?2026l");
  eq(t.syncClosed, 2, "?2026 count: open+close inside one feed counts");
  t.feed("\x1b[?1006;2026h");
  t.feed("\x1b[?1006;2026l");
  eq(t.syncClosed, 3, "?2026 count: combined params count");
  t.resetAll();
  eq(t.syncClosed, 0, "?2026 count: resetAll clears the counter");
}

// 31. UI helpers: the sync-close paint decision and the wheel send plan.
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { syncClosePaint, planWheelSend };")();
  const scp = helpers.syncClosePaint;
  eq(scp(-Infinity, 0, 8), true, "syncClosePaint: never painted -> paint now");
  eq(scp(100, 105, 8), false, "syncClosePaint: 5ms after last paint -> coalesce");
  eq(scp(100, 108, 8), true, "syncClosePaint: 8ms after last paint -> paint now");
  const plan = helpers.planWheelSend;
  const check = (acc, gestureStart, cap, steps, rest, name) => {
    const p = plan(acc, 20, cap, gestureStart);
    eq(p.steps, steps, name + " (steps)");
    eq(p.restPx, rest, name + " (rest)");
  };
  check(0, false, 3, 0, 0, "wheelPlan: no delta");
  check(19, false, 3, 0, 19, "wheelPlan: sub-line mid-gesture waits");
  check(19, true, 3, 1, -1, "wheelPlan: gesture start borrows the first line");
  check(3, true, 3, 1, -17, "wheelPlan: small first delta still starts");
  check(1, true, 3, 0, 1, "wheelPlan: 1px jitter does not start");
  check(-3, true, 3, -1, 17, "wheelPlan: upward gesture start borrows");
  check(20, false, 3, 1, 0, "wheelPlan: exactly one line");
  check(75, false, 3, 3, 15, "wheelPlan: event cap leaves a drainable backlog");
  check(-75, false, 3, -3, -15, "wheelPlan: upward event cap");
  check(45, false, 2, 2, 5, "wheelPlan: drain cap");
  // Distance preservation over a gesture: borrowed line is repaid by the
  // accumulator, so the total steps match the pixel distance.
  let acc = 0, total = 0;
  for (const d of [3, 5, 8, 12, 17, 23, 30]) {
    acc += d;
    const p = plan(acc, 20, 3, total === 0);
    total += p.steps; acc = p.restPx;
  }
  eq(total, Math.floor(98 / 20), "wheelPlan: gesture total matches distance");
}

// --- 32. Row mutation versions (render() element-reuse key) -----------------
// render() reuses a row's DOM element iff the row array is identical and
// its version is unchanged, so every cell-level mutation path must bump
// the version of the row array it writes — and pure cursor/scroll
// movement must not.
{
  const t = new TermCore(10, 3);
  const row0 = t.grid[0];
  eq(t.rowVersion(row0), 0, "rowVer: fresh row starts at 0");
  t.feed("ab");
  eq(t.rowVersion(row0), 2, "rowVer: printChar bumps per char");
  const v = t.rowVersion(row0);
  t.feed("\x1b[3;1H"); // cursor move only
  eq(t.rowVersion(row0), v, "rowVer: cursor move does not bump");
  t.feed("\x1b[K");
  ok(t.rowVersion(t.grid[2]) > 0, "rowVer: erase-in-line bumps its row");
  eq(t.rowVersion(row0), v, "rowVer: erase on another row leaves this one");
  t.feed("\x1b[1;1H\x1b[2P"); // DCH on row 0
  ok(t.rowVersion(row0) > v, "rowVer: DCH bumps its row");
  const v2 = t.rowVersion(row0);
  t.feed("\x1b[2@"); // ICH on row 0
  ok(t.rowVersion(row0) > v2, "rowVer: ICH bumps its row");
  const v3 = t.rowVersion(row0);
  t.feed("́"); // combining char attaches to lastCell
  ok(t.rowVersion(row0) > v3, "rowVer: combining char bumps the cell's row");
  const t2 = new TermCore(4, 2);
  t2.feed("xy\x1b[2J");
  ok(t2.rowVersion(t2.grid[0]) > 0 && t2.rowVersion(t2.grid[1]) > 0,
     "rowVer: erase-in-display bumps all rows");
  const t3 = new TermCore(4, 2);
  t3.feed("\x1b#8");
  ok(t3.rowVersion(t3.grid[0]) > 0 && t3.rowVersion(t3.grid[1]) > 0,
     "rowVer: DECALN bumps all rows");
  // A row scrolled into scrollback keeps identity + version (no bump):
  // the local-scroll fast path repositions its element without repaint.
  const t4 = new TermCore(4, 2);
  t4.feed("one\r\ntwo\r\nthree\r\n");
  const sbRow = t4.scrollback[t4.scrollback.length - 1];
  const sbVer = t4.rowVersion(sbRow);
  t4.feed("four\r\n");
  eq(t4.rowVersion(sbRow), sbVer, "rowVer: scrollback row is not mutated by later output");
}

// 33. Terminal queries: OSC 10/11 color reports, primary DA, kitty flags
// query. Apps (Codex measured) probe these at startup to pick a theme;
// the replies must go through onResponse and never reach the screen.
{
  const t = new TermCore(80, 24);
  const resps = [];
  t.onResponse = (s) => { resps.push(s); };
  t.feed("\x1b]11;?\x1b\\");
  eq(resps.join(""), "\x1b]11;rgb:0c0c/0f0f/1414\x1b\\", "OSC 11;? reports the theme background (ST)");
  resps.length = 0;
  t.feed("\x1b]10;?\x07");
  eq(resps.join(""), "\x1b]10;rgb:d8d8/dede/e9e9\x1b\\", "OSC 10;? reports the theme foreground (BEL)");
  resps.length = 0;
  t.feed("\x1b]10;rgb:0000/0000/0000\x07"); // setting form: not a query
  eq(resps.length, 0, "OSC 10 set form gets no reply");
  t.feed("\x1b]0;window title\x07");
  eq(resps.length, 0, "OSC 0 (title) gets no reply");
  eq(t.screenText().trim(), "", "OSC content is never drawn");
  t.feed("\x1b[c");
  eq(resps.join(""), "\x1b[?1;2c", "primary DA answers VT220-style");
  resps.length = 0;
  t.feed("\x1b[?u");
  eq(resps.join(""), "\x1b[?0u", "kitty flags query answers 0 (unsupported)");
  resps.length = 0;
  t.feed("\x1b[>7u"); // kitty push: not a query
  eq(resps.length, 0, "kitty push gets no reply");
  // A query split across feeds still answers once, at the terminator.
  t.feed("\x1b]11");
  eq(resps.length, 0, "no reply before the OSC terminator");
  t.feed(";?\x1b\\");
  eq(resps.join(""), "\x1b]11;rgb:0c0c/0f0f/1414\x1b\\", "split OSC 11;? answers at ST");
}
{
  // Caller-supplied theme colors (the UI layer passes the CSS variables).
  const t = new TermCore(80, 24, { fg: "#112233", bg: "#AABBCC" });
  const resps = [];
  t.onResponse = (s) => { resps.push(s); };
  t.feed("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
  eq(resps.join(""), "\x1b]10;rgb:1111/2222/3333\x1b\\\x1b]11;rgb:aaaa/bbbb/cccc\x1b\\",
     "OSC replies use the configured colors, channels scaled to 16 bit");
  const t2 = new TermCore(80, 24, { fg: "red", bg: "#12345" }); // invalid: defaults
  const resps2 = [];
  t2.onResponse = (s) => { resps2.push(s); };
  t2.feed("\x1b]11;?\x07");
  eq(resps2.join(""), "\x1b]11;rgb:0c0c/0f0f/1414\x1b\\", "invalid color opts fall back to the theme defaults");
}
{
  // Real stream: Codex 0.164.0-alpha.9 (VM) startup, the first 55 bytes of
  // a pty recording (the same probe column bt-scroll-perf/cap_vm.py
  // answers). The probes arrive in this order: DSR 6n, OSC 10;?, OSC 11;?,
  // kitty query, primary DA — and the replies must come back in order.
  const raw = Buffer.from("G1s/MjAwNGgbWz40OzBtG1s+N3UbWz8xMDA0aBtbNm4bXTEwOz8bXBtdMTE7PxtcG1s/dRtbYw==", "base64").toString("utf8");
  const t = new TermCore(120, 30);
  const resps = [];
  t.onResponse = (s) => { resps.push(s); };
  t.feed(raw);
  eq(resps.join(""),
     "\x1b[1;1R" +
     "\x1b]10;rgb:d8d8/dede/e9e9\x1b\\" +
     "\x1b]11;rgb:0c0c/0f0f/1414\x1b\\" +
     "\x1b[?0u" +
     "\x1b[?1;2c",
     "Codex startup probes get the full reply column in order");
  eq(t.screenText().trim(), "", "Codex probe bytes draw nothing");
}

// 34. UI helpers: SyncScan + planOutFeed — the receive-path batching
// must know where ?2026 blocks begin and end in output TermCore has
// not parsed yet, so a flush can feed whole frames and hold a frame
// whose close has not arrived. The scanner mirrors TermCore's own
// sequence handling (strings swallow up to BEL/ST, ESC aborts a CSI).
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { SyncScan, planOutFeed };")();
  const { SyncScan, planOutFeed } = helpers;
  const CAP = 64 * 1024, EXT = 64 * 1024;

  // Plain text: no blocks, the cap is the only limit.
  {
    const s = new SyncScan();
    s.scan("hello world");
    eq(s.blocks.length, 0, "scan: plain text has no blocks");
    eq(s.syncOpen, false, "scan: plain text leaves sync closed");
    eq(planOutFeed(11, s.blocks, CAP, EXT), 11, "plan: short plain text feeds whole");
    eq(planOutFeed(100000, s.blocks, CAP, EXT), CAP, "plan: plain text slices at the cap");
    eq(planOutFeed(0, s.blocks, CAP, EXT), 0, "plan: empty queue feeds nothing");
  }
  // One complete block.
  {
    const s = new SyncScan();
    const stream = "\x1b[?2026h" + "abc" + "\x1b[?2026l";
    s.scan(stream);
    eq(s.blocks.length, 1, "scan: one block recorded");
    eq(s.blocks[0][0], 0, "scan: block starts at the open ESC");
    eq(s.blocks[0][1], stream.length, "scan: block ends past the close final");
    eq(s.syncOpen, false, "scan: closed block leaves sync closed");
    eq(planOutFeed(stream.length, s.blocks, CAP, EXT), stream.length, "plan: a whole frame feeds whole");
    s.consume(stream.length);
    eq(s.blocks.length, 0, "scan: consume drops a fully fed block");
  }
  // Open block at the tail: feed only what precedes it.
  {
    const s = new SyncScan();
    s.scan("ab\x1b[?2026hcd");
    eq(s.syncOpen, true, "scan: unclosed block is open");
    eq(s.blocks[0][0], 2, "scan: open block starts after the prefix");
    eq(s.blocks[0][1], Infinity, "scan: open block has no end yet");
    eq(planOutFeed(9, s.blocks, CAP, EXT), 2, "plan: an open tail block feeds only its prefix");
    eq(planOutFeed(5000, [[0, Infinity]], CAP, EXT), 0, "plan: an open head block holds everything");
  }
  // Sequences split across chunks are still recognized.
  {
    const s = new SyncScan();
    s.scan("\x1b[?202");
    eq(s.blocks.length, 0, "scan: a split open is not yet a block");
    s.scan("6h");
    eq(s.blocks.length, 1, "scan: a split open completes across chunks");
    s.scan("xx\x1b[?202");
    s.scan("6l");
    eq(s.blocks[0][1], 18, "scan: a split close completes across chunks");
    eq(s.syncOpen, false, "scan: split close closes the block");
  }
  // ?2026 bytes inside a string are content, not a block (TermCore
  // swallows them the same way: an ESC inside a string only ends it
  // when followed by "\\").
  {
    const s = new SyncScan();
    s.scan("\x1b]0;title\x1b[?2026h\x07");
    eq(s.blocks.length, 0, "scan: ?2026 inside an OSC string is not a block");
    const s2 = new SyncScan();
    s2.scan("\x1bPz\x1b[?2026h\x1b\\");
    eq(s2.blocks.length, 0, "scan: ?2026 inside a DCS string is not a block");
    const s3 = new SyncScan();
    s3.scan("\x1b]0;t\x1b\\" + "\x1b[?2026h");
    eq(s3.blocks.length, 1, "scan: a block after an ST-terminated string is seen");
    eq(s3.blocks[0][0], 7, "scan: block offset counts the string bytes");
  }
  // Multi-parameter mode sequences: only a list containing 2026 counts.
  {
    const s = new SyncScan();
    s.scan("\x1b[?2026;1006h");
    eq(s.syncOpen, true, "scan: ?2026;1006h opens");
    s.scan("\x1b[?1006l");
    eq(s.syncOpen, true, "scan: ?1006l alone does not close");
    s.scan("\x1b[?2026l");
    eq(s.syncOpen, false, "scan: ?2026l closes");
    const s2 = new SyncScan();
    s2.scan("\x1b[?2026h\x1b[?2026h\x1b[?2026l");
    eq(s2.blocks.length, 1, "scan: a repeated open is one block (transitions only)");
  }
  // planOutFeed at the cap boundary.
  {
    eq(planOutFeed(70000, [[0, 70000]], CAP, EXT), 70000,
       "plan: a frame ending within extend past the cap feeds whole");
    eq(planOutFeed(200000, [[0, 200000]], CAP, EXT), CAP,
       "plan: a giant closed frame slices at the cap");
    eq(planOutFeed(1000, [[100, 200]], 150, EXT), 100,
       "plan: cap inside a later block feeds the prefix first");
    eq(planOutFeed(1000, [[100, 200]], CAP, EXT), 1000,
       "plan: a block ending before the cap does not limit the feed");
  }
  // consume() shifts the spans of partially fed blocks.
  {
    const s = new SyncScan();
    s.scan("0123456789\x1b[?2026hAB\x1b[?2026l");
    s.consume(10);
    eq(s.blocks[0][0], 0, "scan: consume shifts a block start to the head");
    eq(s.blocks[0][1], 18, "scan: consume shifts a block end");
  }
  // Cross-check against TermCore: chunked feeding along the scanner's
  // plan reaches the same screen as one whole feed.
  {
    const stream = "pre\x1b[?2026h\x1b[H\x1b[38;5;75mframe one\x1b[K\x1b[?2026l" +
                   "mid\x1b]0;title\x07\x1b[?2026h\x1b[Hframe two\x1b[?2026lpost";
    const whole = new TermCore(40, 5);
    whole.feed(stream);
    const s = new SyncScan();
    const chunked = new TermCore(40, 5);
    let rest = stream;
    s.scan(rest);
    let guard = 0;
    while (rest.length && guard++ < 50) {
      const n = planOutFeed(rest.length, s.blocks, 16, 16);
      if (n <= 0) break;
      chunked.feed(rest.slice(0, n));
      s.consume(n);
      rest = rest.slice(n);
    }
    eq(rest.length, 0, "scan/plan: the whole stream is feedable in slices");
    eq(chunked.screenText(), whole.screenText(), "scan/plan: sliced feeding matches whole feeding");
    eq(chunked.syncClosed, whole.syncClosed, "scan/plan: block closes are counted the same");
  }
}

// 35. UI helpers: perf instrumentation aggregation (?perf=1). The frame
// buckets, UTF-8 byte counting and the window aggregator are pure, so
// they are driven here with synthetic values; the render counters are
// the H1/H2 probes (target = rows render() had to decide on, rebuilt =
// rows paintRow() actually rebuilt, sigHit = the difference).
{
  const hBegin = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const hEnd = html.indexOf("/* === UI-HELPERS-END === */");
  const helpers = new Function(html.slice(hBegin, hEnd) +
    "\nreturn { perfFrameBucket, utf8ByteLength, PerfAgg };")();

  eq(helpers.perfFrameBucket(0), 0, "perf bucket: 0ms -> 0");
  eq(helpers.perfFrameBucket(16.7), 0, "perf bucket: 16.7ms -> 0 (boundary)");
  eq(helpers.perfFrameBucket(16.8), 1, "perf bucket: 16.8ms -> 1");
  eq(helpers.perfFrameBucket(33), 1, "perf bucket: 33ms -> 1 (boundary)");
  eq(helpers.perfFrameBucket(33.1), 2, "perf bucket: 33.1ms -> 2");
  eq(helpers.perfFrameBucket(50), 2, "perf bucket: 50ms -> 2 (boundary)");
  eq(helpers.perfFrameBucket(50.1), 3, "perf bucket: 50.1ms -> 3");
  eq(helpers.perfFrameBucket(100), 3, "perf bucket: 100ms -> 3 (boundary)");
  eq(helpers.perfFrameBucket(100.1), 4, "perf bucket: 100.1ms -> 4");
  eq(helpers.perfFrameBucket(5000), 4, "perf bucket: huge -> 4");

  eq(helpers.utf8ByteLength(""), 0, "utf8: empty");
  eq(helpers.utf8ByteLength("abc\x1b[0m"), 7, "utf8: ASCII + escapes count 1 each");
  eq(helpers.utf8ByteLength("é"), 2, "utf8: 2-byte char");
  eq(helpers.utf8ByteLength("あ"), 3, "utf8: 3-byte char");
  eq(helpers.utf8ByteLength("😀"), 4, "utf8: surrogate pair counts 4, not 6");
  eq(helpers.utf8ByteLength("aあb"), 5, "utf8: mixed widths");

  const agg = new helpers.PerfAgg(1000);
  agg.noteFrameInterval(16.7);
  agg.noteFrameInterval(20);
  agg.noteFrameInterval(120);
  agg.noteFrameInterval(-5); // clock noise: ignored
  agg.noteLongTask(80);
  agg.noteLongTask(55.25);
  agg.noteRender(12.34, 60, 60); // H1 shape: every target row rebuilt
  agg.noteRender(3, 10, 4);       // signature fallback rescued 6 rows
  agg.noteFeed(100, 100);
  agg.noteFeed(10, 30);
  const snap = agg.snapshot({
    cols: 235, rows: 60, dpr: 2, visibilityChanges: 1,
    longtaskSupported: true, final: false, clientTs: "2026-11-18T00:00:00.000Z",
  }, 6000);
  eq(snap.kind, "bt-perf", "perf snap: kind tag");
  eq(snap.windowMs, 5000, "perf snap: window length");
  eq(snap.cols, 235, "perf snap: cols carried from meta");
  eq(snap.rows, 60, "perf snap: rows carried from meta");
  eq(snap.dpr, 2, "perf snap: dpr carried from meta");
  eq(snap.visibilityChanges, 1, "perf snap: visibility changes carried");
  eq(snap.longtaskSupported, true, "perf snap: longtask support flag");
  eq(snap.final, false, "perf snap: final flag");
  eq(snap.frames.count, 3, "perf snap: negative interval ignored");
  eq(JSON.stringify(snap.frames.hist), JSON.stringify([1, 1, 0, 0, 1]), "perf snap: frame histogram");
  eq(snap.frames.maxMs, 120, "perf snap: frame max");
  eq(snap.longtasks.count, 2, "perf snap: longtask count");
  eq(snap.longtasks.totalMs, 135.3, "perf snap: longtask total (0.1ms rounding)");
  eq(snap.longtasks.maxMs, 80, "perf snap: longtask max");
  eq(snap.renders.count, 2, "perf snap: render count");
  eq(snap.renders.totalMs, 15.3, "perf snap: render total (0.1ms rounding)");
  eq(snap.renders.maxMs, 12.3, "perf snap: render max");
  eq(snap.renders.targetRowsTotal, 70, "perf snap: target rows total");
  eq(snap.renders.targetRowsMax, 60, "perf snap: target rows max");
  eq(snap.renders.rebuiltRowsTotal, 64, "perf snap: rebuilt rows total");
  eq(snap.renders.rebuiltRowsMax, 60, "perf snap: rebuilt rows max");
  eq(snap.renders.sigHitRowsTotal, 6, "perf snap: sig hits = target - rebuilt");
  eq(snap.feeds.count, 2, "perf snap: feed count");
  eq(snap.feeds.chars, 110, "perf snap: feed chars");
  eq(snap.feeds.bytes, 130, "perf snap: feed bytes");

  // snapshot() resets the window: a second snapshot is all zeros and
  // its window starts where the first one ended.
  const snap2 = agg.snapshot({
    cols: 235, rows: 60, dpr: 2, visibilityChanges: 0,
    longtaskSupported: false, final: true, clientTs: "2026-11-18T00:00:05.000Z",
  }, 11000);
  eq(snap2.windowMs, 5000, "perf snap2: window restarts at previous snapshot");
  eq(snap2.frames.count, 0, "perf snap2: counters reset");
  eq(snap2.renders.count, 0, "perf snap2: renders reset");
  eq(snap2.feeds.bytes, 0, "perf snap2: feeds reset");
  eq(snap2.longtaskSupported, false, "perf snap2: unsupported longtask recorded as false");
  eq(snap2.final, true, "perf snap2: final flag set");
}

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : "\n" + failures + " UNIT TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
