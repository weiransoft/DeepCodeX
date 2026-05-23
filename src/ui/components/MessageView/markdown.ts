import chalk from "chalk";

/**
 * A rendered piece of markdown.  Consumers should use `wrap="truncate-end"` for
 * `table` segments and the default wrap mode for `text` segments so that Ink
 * never breaks box-drawing lines at cell boundary spaces.
 */
export type MarkdownSegment =
  | { kind: "text"; body: string }
  | { kind: "table"; body: string }
  | { kind: "code"; body: string; lang: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render markdown to a single string (backward-compatible). */
export function renderMarkdown(text: string, maxWidth?: number): string {
  return renderMarkdownSegments(text, maxWidth)
    .map((s) => s.body)
    .join("");
}

/** Render markdown, returning typed segments so the caller can choose the
    right `<Text wrap>` per segment. */
export function renderMarkdownSegments(text: string, maxWidth?: number): MarkdownSegment[] {
  if (!text) return [];

  const segments: MarkdownSegment[] = [];
  const fenceSegments = splitByFences(text);

  for (const seg of fenceSegments) {
    if (seg.kind === "code") {
      const langTag = seg.lang ? chalk.dim(`[${seg.lang}]`) + "\n" : "";
      segments.push({ kind: "code", body: langTag + chalk.cyan(seg.body), lang: seg.lang });
      continue;
    }
    const blocks = splitTableBlocks(seg.body);
    for (const b of blocks) {
      if (b.kind === "table") {
        segments.push({ kind: "table", body: renderTableBorder(b.rows, maxWidth) });
      } else {
        const body = b.body
          .split("\n")
          .map((line) => renderInlineLine(line))
          .join("\n");
        if (body) segments.push({ kind: "text", body });
      }
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Code fences
// ---------------------------------------------------------------------------

type FenceSegment = { kind: "text"; body: string } | { kind: "code"; lang: string; body: string };

function splitByFences(text: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  const lines = text.split(/\r?\n/);
  let buffer: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fenceBody: string[] = [];

  const flushText = () => {
    if (buffer.length > 0) {
      segments.push({ kind: "text", body: buffer.join("\n") });
      buffer = [];
    }
  };

  for (const line of lines) {
    const m = /^\s*```(\w*)\s*$/.exec(line);
    if (m) {
      if (!inFence) {
        flushText();
        inFence = true;
        fenceLang = m[1] ?? "";
        fenceBody = [];
      } else {
        segments.push({ kind: "code", lang: fenceLang, body: fenceBody.join("\n") });
        inFence = false;
      }
      continue;
    }
    (inFence ? fenceBody : buffer).push(line);
  }

  if (inFence) {
    segments.push({ kind: "code", lang: fenceLang, body: fenceBody.join("\n") });
  } else {
    flushText();
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Table parsing
// ---------------------------------------------------------------------------

type TableBlock = { kind: "text"; body: string } | { kind: "table"; rows: string[][] };

function splitTableBlocks(text: string): TableBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: TableBlock[] = [];
  let buffer: string[] = [];
  let tableRows: string[][] = [];
  let inTable = false;

  const flushText = () => {
    if (buffer.length > 0) {
      blocks.push({ kind: "text", body: buffer.join("\n") });
      buffer = [];
    }
  };
  const flushTable = () => {
    if (tableRows.length >= 2) {
      blocks.push({ kind: "table", rows: tableRows });
    } else if (tableRows.length > 0) {
      buffer.push(...tableRows.map((r) => r.join(" | ")));
    }
    tableRows = [];
  };

  const sepRe = /^\|?\s*:?[-]{3,}:?\s*(\|\s*:?[-]{3,}:?\s*)*\|?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const nextTrimmed = (lines[i + 1] ?? "").trim();

    // skip separator line
    if (inTable && sepRe.test(trimmed) && tableRows.length === 1) continue;

    const isRow = /^\|.+\|$/.test(trimmed);
    const isHeader = isRow && i + 1 < lines.length && sepRe.test(nextTrimmed);

    if (isHeader && !inTable) {
      flushText();
      inTable = true;
      tableRows = [
        trimmed
          .split("|")
          .filter(Boolean)
          .map((s) => s.trim()),
      ];
      continue;
    }

    if (isRow && inTable) {
      tableRows.push(
        trimmed
          .split("|")
          .filter(Boolean)
          .map((s) => s.trim())
      );
      continue;
    }

    if (inTable && !isRow) {
      flushTable();
      inTable = false;
    }
    buffer.push(line);
  }

  return inTable ? [...blocks, ...flushTableResult(tableRows)] : [...blocks, ...flushTextOnly(buffer, tableRows)];
}

function flushTableResult(rows: string[][]): TableBlock[] {
  if (rows.length >= 2) return [{ kind: "table", rows }];
  if (rows.length > 0) return [{ kind: "text", body: rows.map((r) => r.join(" | ")).join("\n") }];
  return [];
}

function flushTextOnly(buffer: string[], tableRows: string[][]): TableBlock[] {
  const result: TableBlock[] = [];
  if (buffer.length > 0) result.push({ kind: "text", body: buffer.join("\n") });
  if (tableRows.length >= 2) result.push({ kind: "table", rows: tableRows });
  else if (tableRows.length > 0) result.push({ kind: "text", body: tableRows.map((r) => r.join(" | ")).join("\n") });
  return result;
}

// ---------------------------------------------------------------------------
// Terminal visual width (CJK / emoji = 2 cols, ASCII = 1)
// ---------------------------------------------------------------------------

function visualWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch.length >= 2) {
      w += 2;
      continue;
    }
    const code = ch.codePointAt(0) ?? ch.charCodeAt(0);
    w += isWideChar(code) ? 2 : 1;
  }
  return w;
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2329 && code <= 0x232a) || // Misc technical
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK Radicals, Kangxi, CJK all
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat
    (code >= 0xfe10 && code <= 0xfe6f) || // CJK Compat Forms
    (code >= 0xff00 && code <= 0xffe6) || // Fullwidth
    (code >= 0x20000 && code <= 0x3fffd) || // CJK Ext B+
    (code >= 0x1f300 && code <= 0x1faff) || // Emoji & pictographs
    (code >= 0x2600 && code <= 0x27bf) || // Misc Symbols
    (code >= 0x2300 && code <= 0x23ff) || // Misc Technical
    (code >= 0x2b00 && code <= 0x2bff) || // Misc Symbols & Arrows
    (code >= 0x1f000 && code <= 0x1f02f) // Mahjong & Domino
  );
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTableBorder(rows: string[][], maxWidth?: number): string {
  if (rows.length === 0) return "";

  const colCount = rows[0].length;
  const calcW = (cs: number[]) => cs.reduce((a, b) => a + b + 2, 0) + cs.length + 1;

  // Ideal widths — longest word / 1.5 so cells can wrap in 2-3 lines
  const ideal: number[] = Array.from({ length: colCount }, (_, i) => {
    const texts = rows.map((r) => r[i] ?? "");
    const maxLine = Math.max(...texts.map((t) => visualWidth(t)));
    const words = texts.flatMap((t) => t.split(/\s+/));
    const maxWord = Math.max(4, ...words.map((w) => visualWidth(w)));
    return Math.max(maxWord + 2, Math.ceil(maxLine / 1.5));
  });

  const colWidths = [...ideal];

  // Shrink to fit terminal width
  if (maxWidth != null && calcW(colWidths) > maxWidth) {
    const narrow = new Set([0, 1, colCount - 2, colCount - 1]); // #, status, count, date
    const MIN_NARROW = 6;
    const MIN_CONTENT = 12;
    const contentCols = Array.from({ length: colCount }, (_, i) => i).filter((i) => !narrow.has(i));

    // Cap narrow columns first
    for (const ci of narrow) colWidths[ci] = Math.min(colWidths[ci], MIN_NARROW);

    // Shrink until we fit
    while (calcW(colWidths) > maxWidth) {
      // Try narrow columns first
      let shrunk = false;
      for (const ci of narrow) {
        if (colWidths[ci] > 4 && calcW(colWidths) > maxWidth) {
          colWidths[ci]--;
          shrunk = true;
        }
      }
      if (shrunk) continue;
      // Then content columns
      const widest = contentCols.reduce((a, b) => (colWidths[a] > colWidths[b] ? a : b), contentCols[0]);
      if (colWidths[widest] > MIN_CONTENT) colWidths[widest]--;
      else break;
    }
  }

  // Word-wrap a single cell
  const wrapCell = (text: string, width: number): string[] => {
    if (!text) return [""];
    const lines: string[] = [];
    let cur = "";
    const flush = () => {
      if (cur.trim()) lines.push(cur.replace(/\s+$/, ""));
      cur = "";
    };

    for (const ch of text) {
      const cw = visualWidth(ch);
      if (visualWidth(cur) + cw > width) {
        const lastSpace = cur.lastIndexOf(" ");
        if (lastSpace > width / 3) {
          const carry = cur.slice(lastSpace + 1);
          cur = cur.slice(0, lastSpace);
          flush();
          cur = carry + ch;
        } else {
          flush();
          cur = ch;
        }
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) lines.push(cur.replace(/\s+$/, ""));
    return lines.length > 0 ? lines : [""];
  };

  const wrapped = rows.map((r) => r.map((c, ci) => wrapCell(c, colWidths[ci])));
  const heights = wrapped.map((wr) => Math.max(1, ...wr.map((lines) => lines.length)));

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visualWidth(s)));

  const top = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const hdr = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const sep = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bot = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";

  const out: string[] = [top];

  for (let ri = 0; ri < wrapped.length; ri++) {
    const h = heights[ri];
    for (let li = 0; li < h; li++) {
      const line = wrapped[ri].map((cellLines, ci) => " " + pad(cellLines[li] ?? "", colWidths[ci]) + " ");
      out.push("│" + line.join("│") + "│");
    }
    if (ri === 0 && rows.length > 1) out.push(hdr);
    else if (ri < rows.length - 1) out.push(sep);
  }

  out.push(bot);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Inline formatting (headings, lists, quotes, bold/italic/code)
// ---------------------------------------------------------------------------

function renderInlineLine(line: string): string {
  const headingMatch = /^(\s*)(#{1,6})\s+(.*)$/.exec(line);
  if (headingMatch) {
    const [, lead, hashes, content] = headingMatch;
    const styled = hashes.length <= 2 ? chalk.bold.cyanBright(content) : chalk.bold.cyan(content);
    return `${lead}${chalk.dim(hashes)} ${styled}`;
  }

  const listMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (listMatch) {
    const [, lead, bullet, content] = listMatch;
    return `${lead}${chalk.yellow(bullet)} ${renderInlineSpans(content)}`;
  }

  const numListMatch = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
  if (numListMatch) {
    const [, lead, marker, content] = numListMatch;
    return `${lead}${chalk.yellow(marker)} ${renderInlineSpans(content)}`;
  }

  const quoteMatch = /^(\s*)>\s?(.*)$/.exec(line);
  if (quoteMatch) {
    const [, lead, content] = quoteMatch;
    return `${lead}${chalk.dim("│ ")}${chalk.italic(renderInlineSpans(content))}`;
  }

  return renderInlineSpans(line);
}

function renderInlineSpans(text: string): string {
  if (!text) return text;
  let result = text;
  result = result.replace(/`([^`]+)`/g, (_, inner) => chalk.cyan(inner));
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, inner) => chalk.bold(inner));
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, inner) => chalk.italic(inner));
  result = result.replace(/_([^_\n]+)_/g, (_, inner) => chalk.italic(inner));
  return result;
}
