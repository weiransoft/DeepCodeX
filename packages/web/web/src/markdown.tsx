/**
 * 极简 Markdown 渲染器（安全版，零 HTML 注入）
 *
 * ## 为什么自己写而不是引入 marked / markdown-it
 *
 * 1. **XSS 防线**：审计报告含 LLM 生成的结论文本（`llmSummary`），是不可信输入。
 *    通用 Markdown 库通常走 `dangerouslySetInnerHTML`，一旦漏做转义就是漏洞。
 *    本实现**全程输出 React 文本节点**，不产生 HTML 字符串——所有文本由 React
 *    自动转义，从根上不存在注入面。
 * 2. **零新依赖**：前端产物是单文件 IIFE bundle（esbuild），为一份固定语法的
 *    报告引入完整 Markdown 库（含 HTML 插件等攻击面）不划算。
 * 3. **语法子集可控**：渲染目标只有 `eag/report-render.ts` 产出的确定性报告，
 *    语法封闭（见下方 SUPPORTED），覆盖即完整。
 *
 * ## 支持的语法子集
 *
 * - ATX 标题：`#` ~ `######`
 * - 无序列表：`- ` / `* `，支持二级缩进嵌套
 * - 有序列表：`1. `
 * - 表格：`| a | b |` + 分隔行 `| --- | --- |`
 * - 段落与软换行
 * - 强调：`**粗体**`、`*斜体*`、`_斜体_`
 * - 行内代码：`` `code` ``
 * - 水平线：`---`
 *
 * 链接、HTML 块、代码围栏不解析——按纯文本展示（原文保真优先于花哨）。
 *
 * @module markdown
 */

import type { ReactNode } from "react";

/** 渲染块类型 */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "hr" };

/** 行内片段类型（全部为文本，无 HTML） */
type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string };

/** 表格行拆分：去掉首尾竖线，按 | 切分并 trim */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** 是否为表格分隔行（如 `| --- | :--- |`） */
function isTableDivider(line: string): boolean {
  return /^\|?[\s:-]*-[-\s:|]*\|?$/.test(line) && line.includes("-");
}

/**
 * 行内解析：`**粗体**` / `*斜体*` / `_斜体_` / `` `代码` ``
 *
 * 只做一次线性扫描，不支持嵌套强调——报告语法不需要。
 *
 * @param text 原始行内文本
 * @returns 行内片段数组
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let i = 0;

  /** 把累积的普通文本刷入结果 */
  const flush = (): void => {
    if (buffer !== "") {
      out.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // 行内代码：`` `code` ``
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // 粗体：`**text**`
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", value: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // 斜体：`*text*` 或 `_text_`
    if (ch === "*" || ch === "_") {
      const end = text.indexOf(ch, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "em", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/**
 * 解析 Markdown 为块序列
 *
 * @param source Markdown 原文
 * @returns 块数组（空输入返回空数组）
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行：跳过
    if (trimmed === "") {
      i += 1;
      continue;
    }

    // 水平线：--- / ***（需独占一行且至少 3 个）
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // ATX 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (trimmed.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1].trim())) {
      const header = splitTableRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i].trim()));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // 列表：`- ` / `* ` / `1. `（含二级缩进，缩进 2 空格）
    const listItem = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (listItem !== null) {
      const ordered = /^\d+\.$/.test(listItem[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i].trim();
        const itemMatch = itemLine.match(/^([-*]|\d+\.)\s+(.*)$/);
        if (itemMatch === null) break;
        // 列表项内的二级缩进（原文以 2 空格起）视为同项续行
        items.push(itemMatch[2]);
        i += 1;
        // 续行：下一行是非列表、非空、且原行有缩进 → 并入上一项
        if (i < lines.length && lines[i].trim() !== "" && !/^([-*]|\d+\.)\s+/.test(lines[i].trim())) {
          const indent = lines[i].length - lines[i].trimStart().length;
          if (indent >= 2) {
            items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
            i += 1;
          }
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // 段落：连续非空、非结构行合并（软换行用空格连接）
    const paragraph: string[] = [];
    while (i < lines.length) {
      const p = lines[i].trim();
      if (
        p === "" ||
        /^#{1,6}\s+/.test(p) ||
        /^([-*]|\d+\.)\s+/.test(p) ||
        /^(-{3,}|\*{3,})$/.test(p) ||
        (p.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1].trim()))
      ) {
        break;
      }
      paragraph.push(p);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

/**
 * 把行内片段渲染为 React 节点
 *
 * @param text 行内文本
 * @returns React 节点数组（全部为文本节点 / 受控元素，无 innerHTML）
 */
function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((part, idx) => {
    switch (part.kind) {
      case "code":
        return <code key={idx}>{part.value}</code>;
      case "strong":
        return <strong key={idx}>{part.value}</strong>;
      case "em":
        return <em key={idx}>{part.value}</em>;
      default:
        return <span key={idx}>{part.value}</span>;
    }
  });
}

/**
 * Markdown 渲染组件
 *
 * 用法：`<Markdown source={report} />`
 *
 * @param props.source Markdown 原文
 */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);

  return (
    <div className="markdown-body">
      {blocks.map((block, idx) => {
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return <Tag key={idx}>{renderInline(block.text)}</Tag>;
          }
          case "paragraph":
            return <p key={idx}>{renderInline(block.text)}</p>;
          case "hr":
            return <hr key={idx} />;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={idx}>
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <table key={idx} className="markdown-table">
                <thead>
                  <tr>
                    {block.header.map((cell, cellIdx) => (
                      <th key={cellIdx}>{renderInline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIdx) => (
                    <tr key={rowIdx}>
                      {row.map((cell, cellIdx) => (
                        <td key={cellIdx}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
