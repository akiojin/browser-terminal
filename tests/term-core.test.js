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
    "\nreturn { clickShouldFocusIme };")();
  eq(helpers.clickShouldFocusIme(""), true, "ui: plain click (no selection) focuses IME");
  eq(helpers.clickShouldFocusIme("selected text"), false, "ui: click ending a drag selection keeps the selection");
}

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : "\n" + failures + " UNIT TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
