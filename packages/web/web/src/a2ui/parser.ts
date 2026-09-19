/**
 * Markdown → A2UI 消息流转换器（R9，设计文档 §3.7）。
 *
 * 职责：把助手 Markdown 文本解析为标准 A2UI v0.8 JSONL 消息序列：
 *   1 条 beginRendering{surfaceId, root:"root"}
 *   + 1 条 surfaceUpdate{surfaceId, components 全量}（扁平邻接表，childIds 引用）
 *
 * 分块规则（与设计文档逐条对应）：
 *   - `#` ~ `####`（容错至 `######`）标题行   → Heading(level)
 *   - 普通段落 / 引用（> 前缀）              → Text（引用变体 quote）
 *   - ```lang 围栏代码块                     → Card(标题=语言名, headerAction=复制) 内含 Text(monospace)
 *   - ```chart 围栏（内容为图表 JSON）        → Chart 组件；JSON 畸形时兜底渲染为普通代码块（不崩溃、不丢内容）
 *   - Markdown 表格（| 行 + 分隔行）          → List + Row/Column 结构化组件（表头加粗）
 *   - ![alt](url) 独立成行                   → Image
 *   - --- 水平分隔线                         → Divider
 *   - 空行分块；所有块依序装入根 Column
 *
 * XSS 说明：本解析器不生成任何 HTML；全部文本原样保留，
 * 由渲染层以 React 文本节点渲染（设计文档 §3.6）。
 */
import type { A2uiChartSeries, A2uiChartSpec, A2uiComponent, A2uiMessage } from "./types";

/** 内部块模型：解析阶段的中间表示 */
type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "chart"; spec: A2uiChartSpec }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "image"; alt: string; url: string }
  | { kind: "divider" };

/**
 * 判断一行是否为围栏代码块起始（```lang）。
 * @param line 原始行文本
 * @returns 匹配时返回围栏标记后的 info 字符串（语言名），否则返回 null
 */
function matchFenceStart(line: string): string | null {
  const m = /^\s{0,3}```(.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

/** 判断一行是否为围栏代码块结束（```） */
function isFenceEnd(line: string): boolean {
  return /^\s{0,3}```\s*$/.test(line);
}

/** 判断一行是否为 ATX 标题（# ~ ######），返回级别与文本 */
function matchHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1].length as 1 | 2 | 3 | 4 | 5 | 6, text: m[2] };
}

/** 判断一行是否为独立成行的图片 ![alt](url) */
function matchImage(line: string): { alt: string; url: string } | null {
  const m = /^\s{0,3}!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
  if (!m) return null;
  return { alt: m[1], url: m[2] };
}

/** 判断一行是否为水平分隔线（--- / *** / ___，至少重复 3 次） */
function isHorizontalRule(line: string): boolean {
  return /^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(line);
}

/** 判断一行是否为引用行（> 前缀），返回去掉前缀后的内容 */
function matchQuote(line: string): string | null {
  const m = /^\s{0,3}>\s?(.*)$/.exec(line);
  return m ? m[1] : null;
}

/**
 * 拆分表格行内的单元格：剥离首尾 "|" 后按未转义的 "|" 分割，
 * 支持 "\|" 转义；单元格首尾空白去除。
 */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  // 结尾 "|" 若是被转义的（"\|"）则属于单元格内容，不能剥离
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      // 转义的管道符还原为字面 "|"
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * 判断一行是否为表格分隔行（第二行，形如 | --- | :---: |）。
 * 每个单元格需匹配 :? -+ :? 且至少含一个连字符。
 */
export function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/** 判断 lines[i] 是否为表格起始（本行以 | 开头且下一行为分隔行） */
function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i];
  if (!/^\s{0,3}\|/.test(line)) return false;
  const next = lines[i + 1];
  return next !== undefined && isTableSeparatorRow(next);
}

/**
 * 校验并归一 ```chart 围栏 JSON 为 A2uiChartSpec。
 * 校验失败（畸形 JSON / 缺 series / type 非法 / data 非数组）返回 null，
 * 调用方据此兜底渲染为普通代码块。
 * @param raw 围栏内的原始文本
 */
export function parseChartSpec(raw: string): A2uiChartSpec | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;

  // type 必须是三种支持类型之一
  if (rec.type !== "bar" && rec.type !== "line" && rec.type !== "pie") return null;

  // series 必须是非空数组，且每项 data 为数组（数值逐个强制转换，非有限数归零，避免图表崩溃）
  if (!Array.isArray(rec.series) || rec.series.length === 0) return null;
  const series: A2uiChartSeries[] = [];
  for (const s of rec.series) {
    if (typeof s !== "object" || s === null) return null;
    const sr = s as Record<string, unknown>;
    if (!Array.isArray(sr.data)) return null;
    const data = sr.data.map((v) => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    });
    const item: A2uiChartSeries = { data };
    if (typeof sr.name === "string" && sr.name.length > 0) item.name = sr.name;
    series.push(item);
  }

  const spec: A2uiChartSpec = { type: rec.type, series };
  // labels：可选，字符串数组
  if (rec.labels !== undefined) {
    if (!Array.isArray(rec.labels) || rec.labels.some((l) => typeof l !== "string")) return null;
    spec.labels = rec.labels as string[];
  }
  // title：可选，字符串
  if (rec.title !== undefined) {
    if (typeof rec.title !== "string") return null;
    spec.title = rec.title;
  }
  return spec;
}

/**
 * 把 Markdown 文本按行解析为块序列。
 * 状态机逐行推进：围栏代码块优先（防止内部出现 #/| 等被误判），
 * 其后依次尝试标题 / 表格 / 图片 / 分隔线 / 引用 / 段落。
 * 未闭合围栏一直吸收到文末（内容不丢失）。
 */
export function parseMarkdownBlocks(markdownText: string): Block[] {
  const lines = markdownText.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行：块分隔，跳过
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 围栏代码块（含 ```chart 图表围栏）
    const info = matchFenceStart(line);
    if (info !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceEnd(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // 跳过结束围栏（未闭合时 i 已到文末，无越界问题）
      if (i < lines.length) i++;
      const code = body.join("\n");
      if (info === "chart") {
        // chart 围栏：尝试解析为图表规格；畸形时兜底为普通代码块（语言标 chart）
        const spec = parseChartSpec(code);
        if (spec !== null) {
          blocks.push({ kind: "chart", spec });
        } else {
          blocks.push({ kind: "code", lang: "chart", code });
        }
      } else {
        blocks.push({ kind: "code", lang: info || "text", code });
      }
      continue;
    }

    // ATX 标题
    const heading = matchHeading(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading.level, text: heading.text });
      i++;
      continue;
    }

    // Markdown 表格（| 行 + 分隔行）
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i]);
      i += 2; // 跳过表头行与分隔行
      const rows: string[][] = [];
      while (i < lines.length && /^\s{0,3}\|/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // 独立成行的图片
    const image = matchImage(line);
    if (image !== null) {
      blocks.push({ kind: "image", alt: image.alt, url: image.url });
      i++;
      continue;
    }

    // 水平分隔线
    if (isHorizontalRule(line)) {
      blocks.push({ kind: "divider" });
      i++;
      continue;
    }

    // 引用块：连续 > 行合并（去掉 "> " 前缀，保留换行）
    const quoteFirst = matchQuote(line);
    if (quoteFirst !== null) {
      const buf: string[] = [quoteFirst];
      i++;
      while (i < lines.length) {
        const q = matchQuote(lines[i]);
        if (q === null || lines[i].trim() === "") break;
        buf.push(q);
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    // 普通段落：吸收连续非空且不属于其它块起始的行（保留换行，聊天场景友好）
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") break;
      // 命中任意块起始规则则结束本段落
      if (
        matchFenceStart(l) !== null ||
        matchHeading(l) !== null ||
        matchImage(l) !== null ||
        isHorizontalRule(l) ||
        matchQuote(l) !== null ||
        isTableStart(lines, i)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }

  return blocks;
}

/**
 * 把助手 Markdown 转换为标准 A2UI JSONL 消息流。
 *
 * 产出：
 *   [{ beginRendering: { surfaceId, root: "root" } },
 *    { surfaceUpdate: { surfaceId, components } }]
 *
 * components 为扁平邻接表：根 Column（id="root"）通过 childIds 依序引用各块组件；
 * 表格展开为 List→Row→Column→Text 四级结构（表头 Text bold=true）；
 * 代码块展开为 Card（标题=语言，标题栏动作=复制）→Text(monospace)。
 *
 * @param markdownText 助手消息的完整 Markdown 文本
 * @param surfaceId    本条消息对应的 surface 标识（一般取 messageId，保证稳定可复渲染）
 */
export function parseMarkdownToA2ui(markdownText: string, surfaceId: string): A2uiMessage[] {
  const blocks = parseMarkdownBlocks(markdownText);

  /** 组件累积表（扁平邻接表） */
  const components: A2uiComponent[] = [];
  /** 自增计数器：生成 surface 内唯一且确定性可复现的组件 id */
  let counter = 0;

  /**
   * 登记一个组件并返回其 id。
   * @param type  组件类型名（协议原语名，如 "Text"）
   * @param props 属性对象
   */
  const add = (type: string, props: Record<string, unknown>): string => {
    const id = `a2ui-c${counter++}`;
    components.push({ id, component: { [type]: props } });
    return id;
  };

  /** 各顶层块对应的组件 id（供根 Column 引用） */
  const childIds: string[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        // 标题 → Heading(level)
        childIds.push(add("Heading", { text: block.text, level: block.level }));
        break;
      }
      case "paragraph": {
        // 段落 → Text(body)
        childIds.push(add("Text", { text: block.text, variant: "body" }));
        break;
      }
      case "quote": {
        // 引用 → Text(quote)
        childIds.push(add("Text", { text: block.text, variant: "quote" }));
        break;
      }
      case "code": {
        // 代码块 → Card(标题=语言名, 标题栏动作=复制) 内含 Text(monospace)
        const textId = add("Text", { text: block.code, variant: "monospace" });
        childIds.push(
          add("Card", {
            title: block.lang,
            childIds: [textId],
            headerAction: { type: "copy", text: block.code },
          })
        );
        break;
      }
      case "image": {
        // 图片 → Image(url 直接渲染，协议白名单校验在渲染层)
        childIds.push(add("Image", { url: block.url, alt: block.alt }));
        break;
      }
      case "divider": {
        // 水平分隔线 → Divider
        childIds.push(add("Divider", {}));
        break;
      }
      case "chart": {
        // 图表 → Chart（规格原样内嵌，渲染层用纯 SVG 绘制）
        childIds.push(add("Chart", { chart: block.spec }));
        break;
      }
      case "table": {
        // 表格 → List(vertical) 内含行 Row，每行内含单元格 Column，单元格内 Text
        // 列数以表头为准，数据行不足补空串，超出截断（保证每行列数一致）
        const colCount = block.header.length;
        const rowIds: string[] = [];

        const buildRow = (cells: string[], bold: boolean): string => {
          const colIds = cells.slice(0, colCount).map((cell) => {
            const textId = add("Text", { text: cell, variant: "body", bold });
            // 单元格 Column：纵向容器包住文本，渲染层以 flex 均分宽度
            return add("Column", { childIds: [textId] });
          });
          // 列数不足时补空单元格，保证表格网格对齐
          for (let c = colIds.length; c < colCount; c++) {
            const textId = add("Text", { text: "", variant: "body", bold });
            colIds.push(add("Column", { childIds: [textId] }));
          }
          return add("Row", { childIds: colIds });
        };

        // 第一行：表头（加粗）
        rowIds.push(buildRow(block.header, true));
        for (const cells of block.rows) {
          rowIds.push(buildRow(cells, false));
        }
        childIds.push(add("List", { childIds: rowIds, direction: "vertical" }));
        break;
      }
    }
  }

  // 根 Column：承载所有顶层块
  components.push({ id: "root", component: { Column: { childIds } } });

  // 标准 A2UI 消息序列：先声明 surface 与根，再全量提交组件
  return [{ beginRendering: { surfaceId, root: "root" } }, { surfaceUpdate: { surfaceId, components } }];
}
