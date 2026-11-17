// Scrollback trimming for session replay.
//
// The server keeps the last `cap` bytes of PTY output per session and
// replays them verbatim when a tab reattaches; the client resets its
// emulator and feeds the buffer as if it were a complete stream from a
// fresh terminal. Cutting at an arbitrary byte offset breaks that
// assumption: the replay can start mid-UTF-8 character (mojibake),
// mid-CSI (the tail prints as literal text), or after an alt-screen
// ENTER whose frames then pour onto the main grid and never leave.
// trimScrollback therefore only cuts where a VT parser would be in the
// ground state on the main screen — or, when the whole tail lives
// inside the alt screen, at the alt-screen entry itself.
'use strict';

// Byte-level scanner mirroring TermCore's parser states (src/ui.html).
function createScanner() {
  return {
    state: 'ground', // ground | esc | csi | osc | oscEsc | charset | escHash
    alt: false, // inside the alternate screen
    altEntryStart: -1, // offset of the ESC that began the active alt entry
    seqStart: -1, // offset of the ESC that began the current sequence
    csiPrefix: '',
    csiParams: '',
  };
}

function feedByte(st, b, i) {
  switch (st.state) {
    case 'ground':
      if (b === 0x1b) { st.state = 'esc'; st.seqStart = i; }
      break;
    case 'esc':
      if (b === 0x5b) { // [
        st.state = 'csi'; st.csiPrefix = ''; st.csiParams = '';
      } else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
        st.state = 'osc'; // ] P X ^ _ — TermCore consumes DCS/SOS/PM/APC like OSC
      } else if (b === 0x28 || b === 0x29) { // ( )
        st.state = 'charset';
      } else if (b === 0x23) { // #
        st.state = 'escHash';
      } else if (b === 0x1b) {
        st.seqStart = i; // stay in esc
      } else {
        if (b === 0x63) { st.alt = false; st.altEntryStart = -1; } // RIS resets all
        st.state = 'ground';
      }
      break;
    case 'charset':
    case 'escHash':
      st.state = 'ground';
      break;
    case 'osc':
      if (b === 0x07) st.state = 'ground';
      else if (b === 0x1b) st.state = 'oscEsc';
      break;
    case 'oscEsc':
      st.state = b === 0x5c ? 'ground' : 'osc'; // \ terminates, else back to osc
      break;
    case 'csi':
      if (b >= 0x40 && b <= 0x7e) { // final byte
        if (st.csiPrefix === '?' && (b === 0x68 || b === 0x6c)) { // h / l
          const modes = st.csiParams.split(';').map((p) => parseInt(p, 10));
          if (modes.includes(47) || modes.includes(1047) || modes.includes(1049)) {
            st.alt = b === 0x68;
            st.altEntryStart = st.alt ? st.seqStart : -1;
          }
        }
        st.state = 'ground';
      } else if (b >= 0x30 && b <= 0x3f) { // parameter / prefix bytes
        if (st.csiParams === '' && st.csiPrefix === '' &&
            (b === 0x3f || b === 0x3e || b === 0x3c || b === 0x3d)) {
          st.csiPrefix = String.fromCharCode(b);
        } else if (st.csiParams.length < 64) {
          st.csiParams += String.fromCharCode(b);
        }
      } else if (b === 0x1b) {
        st.state = 'esc'; st.seqStart = i;
      }
      // intermediate bytes 0x20-0x2f: ignored, stay in csi
      break;
  }
}

// The offset at which `buf` may be cut so the tail replays cleanly; 0
// keeps everything. Prefers the earliest offset at/after (length - cap)
// where the parser is in ground state on the main screen and the byte
// there starts a UTF-8 character.
function scrollbackCutOffset(buf, cap) {
  if (!buf || buf.length <= cap) return 0;
  const target = buf.length - cap;
  const st = createScanner();
  for (let i = 0; i < buf.length; i++) {
    if (i >= target && st.state === 'ground' && !st.alt && (buf[i] & 0xc0) !== 0x80) return i;
    feedByte(st, buf[i], i);
  }
  // No main-screen ground point inside the window: if the stream ends
  // inside the alt screen, keep its entry sequence so the replay enters
  // the alt screen too (the buffer may exceed cap while an app stays in
  // the alt screen; it trims back down once the app leaves).
  if (st.alt && st.altEntryStart >= 0) return st.altEntryStart;
  // Last resort (a single unbroken sequence longer than the cap): at
  // least stay on a UTF-8 character boundary.
  for (let i = target; i < buf.length; i++) if ((buf[i] & 0xc0) !== 0x80) return i;
  return target;
}

function trimScrollback(buf, cap) {
  const off = scrollbackCutOffset(buf, cap);
  return off > 0 ? buf.subarray(off) : buf;
}

module.exports = { scrollbackCutOffset, trimScrollback };
