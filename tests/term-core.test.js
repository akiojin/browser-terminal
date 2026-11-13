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

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : "\n" + failures + " UNIT TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
