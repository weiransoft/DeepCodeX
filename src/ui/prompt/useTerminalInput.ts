import { useEffect, useRef } from "react";
import { useStdin } from "ink";

export type InputKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  home: boolean;
  end: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  focusIn: boolean;
  focusOut: boolean;
};

const BACKSPACE_BYTES = new Set(["\u007F", "\b"]);
const FORWARD_DELETE_SEQUENCES = new Set(["\u001B[3~", "\u001B[P"]);
const HOME_SEQUENCES = new Set(["\u001B[H", "\u001B[1~", "\u001B[7~", "\u001BOH"]);
const END_SEQUENCES = new Set(["\u001B[F", "\u001B[4~", "\u001B[8~", "\u001BOF"]);
// Known exact Shift+Enter sequences (both xterm modifyOtherKeys and Kitty protocol).
const SHIFT_RETURN_SEQUENCES = new Set([
  "\u001B\r",
  "\u001B[13;2u",
  "\u001B[13;1u",
  "\u001B[13;2~",
  "\u001B[13;1~",
  "\u001B[27;2;13~",
  "\u001B[27;1;13~",
]);

// CSI u format: ESC [ keycode ; modifier u
// CSI ~ format: ESC [ keycode ; modifier ~
// Extended:     ESC [ 27 ; modifier ; keycode ~
const CSI_SHIFT_RETURN_RE = /^\u001B\[13;(\d+)[u~]$/;
const CSI_EXTENDED_SHIFT_RETURN_RE = /^\u001B\[27;(\d+);13~$/;

// Check whether a raw sequence represents Shift+Enter by parsing the modifier
// parameter dynamically.  This handles terminals (e.g. Windows Terminal) that
// set extra flags on the modifier (e.g. 130 = 128 + 2) while the existing
// SHIFT_RETURN_SEQUENCES Set only covers the canonical values (2 and 1).
function isShiftReturn(raw: string): boolean {
  if (SHIFT_RETURN_SEQUENCES.has(raw)) return true;

  let m: RegExpMatchArray | null;
  if ((m = raw.match(CSI_SHIFT_RETURN_RE)) !== null) {
    const mod = parseInt(m[1], 10);
    // xterm: Shift=2 (bit 1); Kitty: Shift=1 (bit 0)
    return (mod & 2) !== 0 || (mod & 1) !== 0;
  }
  if ((m = raw.match(CSI_EXTENDED_SHIFT_RETURN_RE)) !== null) {
    const mod = parseInt(m[1], 10);
    return (mod & 2) !== 0 || (mod & 1) !== 0;
  }
  return false;
}

// Any CSI sequence with keycode=13 (Enter) — with or without modifiers.
// Kitty progressive enhancement (ESC[>1u) sends plain Enter as ESC[13u
// or ESC[13;NUMBERu with extra flags; xterm sends ESC[13;2u for Shift.
const CSI_RETURN_RE = /^\u001B\[13;(\d+)[u~]$/;
const CSI_EXTENDED_RETURN_RE = /^\u001B\[27;(\d+);13~$/;

function isReturn(raw: string): boolean {
  if (raw === "\r") return true;
  if (SHIFT_RETURN_SEQUENCES.has(raw)) return true;
  if (META_RETURN_SEQUENCES.has(raw)) return true;
  return CSI_RETURN_RE.test(raw) || CSI_EXTENDED_RETURN_RE.test(raw);
}
const META_RETURN_SEQUENCES = new Set(["\u001B[13;3u", "\u001B[13;4u"]);
const CTRL_LEFT_SEQUENCES = new Set(["\u001B[1;5D", "\u001B[5D"]);
const CTRL_RIGHT_SEQUENCES = new Set(["\u001B[1;5C", "\u001B[5C"]);
const META_LEFT_SEQUENCES = new Set(["\u001B[1;3D", "\u001B[3D", "\u001Bb"]);
const META_RIGHT_SEQUENCES = new Set(["\u001B[1;3C", "\u001B[3C", "\u001Bf"]);
const TERMINAL_FOCUS_IN = "\u001B[I";
const TERMINAL_FOCUS_OUT = "\u001B[O";

// Ctrl+- (minus) sequences in modifyOtherKeys mode.
// \u001B[45;5u  — standard format: keycode=45 ('-'), modifier=5 (Ctrl)
// \u001B[27;5;45~ — extended format for function-like reporting
const CTRL_MINUS_SEQUENCES = new Set(["\u001B[45;5u", "\u001B[27;5;45~"]);

// Ctrl+Shift+- (minus) sequences in modifyOtherKeys mode.
// \u001B[45;6u  — standard format: keycode=45 ('-'), modifier=6 (Ctrl+Shift)
// \u001B[27;6;45~ — extended format for function-like reporting
const CTRL_SHIFT_MINUS_SEQUENCES = new Set(["\u001B[45;6u", "\u001B[27;6;45~"]);

export function parseTerminalInput(data: Buffer | string): { input: string; key: InputKey } {
  const raw = String(data);
  let input = raw;

  // Ctrl+- undo shortcut: only via modifyOtherKeys CSI sequences.
  // Raw 0x1F is NOT included here because it represents Ctrl+_ (Ctrl+Shift+-
  // on US keyboards), which should trigger redo instead.
  if (CTRL_MINUS_SEQUENCES.has(raw)) {
    input = "-";
    const key: InputKey = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      pageDown: false,
      pageUp: false,
      return: false,
      escape: false,
      ctrl: true,
      shift: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      focusIn: false,
      focusOut: false,
    };
    return { input, key };
  }

  // Ctrl+Shift+- redo shortcut: modifyOtherKeys CSI sequences + raw 0x1F fallback.
  // \x1F is Ctrl+_ which on US keyboards = Ctrl+Shift+-.
  if (CTRL_SHIFT_MINUS_SEQUENCES.has(raw) || raw === "\u001F") {
    input = "-";
    const key: InputKey = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      pageDown: false,
      pageUp: false,
      return: false,
      escape: false,
      ctrl: true,
      shift: true,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      focusIn: false,
      focusOut: false,
    };
    return { input, key };
  }

  const key: InputKey = {
    upArrow: raw === "\u001B[A",
    downArrow: raw === "\u001B[B",
    leftArrow: raw === "\u001B[D" || CTRL_LEFT_SEQUENCES.has(raw) || META_LEFT_SEQUENCES.has(raw),
    rightArrow: raw === "\u001B[C" || CTRL_RIGHT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw),
    home: HOME_SEQUENCES.has(raw),
    end: END_SEQUENCES.has(raw),
    pageDown: raw === "\u001B[6~",
    pageUp: raw === "\u001B[5~",
    return: isReturn(raw),
    escape: raw === "\u001B",
    ctrl: CTRL_LEFT_SEQUENCES.has(raw) || CTRL_RIGHT_SEQUENCES.has(raw),
    shift: isShiftReturn(raw),
    tab: raw === "\t" || raw === "\u001B[Z",
    backspace: BACKSPACE_BYTES.has(raw),
    delete: FORWARD_DELETE_SEQUENCES.has(raw),
    meta: META_LEFT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw) || META_RETURN_SEQUENCES.has(raw),
    focusIn: raw === TERMINAL_FOCUS_IN,
    focusOut: raw === TERMINAL_FOCUS_OUT,
  };

  if (input <= "\u001A" && !key.return) {
    input = String.fromCharCode(input.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  }

  const isKnownEscapeSequence =
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.home ||
    key.end ||
    key.pageDown ||
    key.pageUp ||
    key.tab ||
    key.delete ||
    key.return ||
    key.ctrl ||
    key.meta ||
    key.focusIn ||
    key.focusOut;

  if (raw.startsWith("\u001B")) {
    input = raw.slice(1);
    key.meta = key.meta || !isKnownEscapeSequence;
  }

  const isLatinUppercase = input >= "A" && input <= "Z";
  const isCyrillicUppercase = input >= "А" && input <= "Я";
  if (input.length === 1 && (isLatinUppercase || isCyrillicUppercase)) {
    key.shift = true;
  }

  if (key.tab && input === "[Z") {
    key.shift = true;
  }

  if (key.tab || key.backspace || key.delete || key.return) {
    input = "";
  }

  return { input, key };
}

export function useTerminalInput(
  inputHandler: (input: string, key: InputKey) => void,
  options: { isActive?: boolean } = {}
): void {
  const { stdin, setRawMode } = useStdin();
  const isActive = options.isActive ?? true;
  const handlerRef = useRef(inputHandler);
  handlerRef.current = inputHandler;

  useEffect(() => {
    if (!isActive) {
      return;
    }
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [isActive, setRawMode]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const handleData = (data: Buffer | string) => {
      const { input, key } = parseTerminalInput(data);
      handlerRef.current(input, key);
    };

    stdin?.on("data", handleData);
    return () => {
      stdin?.off("data", handleData);
    };
  }, [isActive, stdin]);
}
