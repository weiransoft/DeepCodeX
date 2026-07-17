/**
 * 跨轮 notes.md 记忆（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/notes_memory.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Simplicity First - 标准 markdown 格式，LLM 可直接消费
 * Ponytail 红线：禁止"先写内存再异步刷盘"，必须 fsync 同步落盘
 *
 * 真实实现能力：
 *   1. 标准 markdown 格式，LLM 可直接消费
 *   2. 原子写入：先 .tmp，fsync 后 rename（避免半写）
 *   3. 段落式：每轮一个 section，标题含 iter_index
 *   4. token 估算：粗略按 char/4 估算（不依赖 tiktoken）
 *   5. 段落解析：扫描 "## " 标题 + 元数据注释行
 *   6. 自动 trim：超过 max_size_kb 时保留最近 N 段
 *   7. 缓存：避免重复读盘，写入时失效
 *   8. 真实文件 I/O（不模拟）
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 单个 notes 段落 */
export interface NotesSection {
  /** 段标题（不含 "## " 前缀） */
  title: string;
  /** 段内容（markdown） */
  body: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 所属迭代索引 */
  iterIndex: number;
  /** 标签列表（如 ["success", "test-passed"]） */
  tags: string[];
}

/** markdown 段标题正则：以 "## " 开头的行 */
const SECTION_HEADER_RE = /^##\s+(.+)$/gm;
/** 段元数据注释行：<!-- iter=N tags=tag1,tag2 --> */
const META_COMMENT_RE = /^<!--\s*iter=(\d+)(?:\s+tags=([^\s>]+))?\s*-->\s*$/gm;

/**
 * 跨轮 notes.md 记忆
 *
 * 设计原则：
 *   1. 文件格式：标准 markdown，LLM 可直接消费
 *   2. 原子写入：先写 .tmp，fsync 后 rename（避免半写）
 *   3. 段落式：每轮一个 section，标题含 iter_index
 *   4. token 估算：粗略按 char/4 估算（不依赖 tiktoken）
 */
export class NotesMemory {
  private readonly notesPath: string;
  private readonly maxSizeBytes: number;
  private readonly trimKeepLastN: number;
  /** 缓存，避免重复读盘 */
  private cachedContent: string | null = null;
  private cacheDirty: boolean = true;

  /**
   * 构造 NotesMemory
   *
   * @param notesPath notes.md 完整路径
   * @param maxSizeKb 最大文件大小（KB），超过则 trim
   * @param trimKeepLastN trim 时保留最近 N 个段落
   */
  constructor(notesPath: string, maxSizeKb: number = 1024, trimKeepLastN: number = 20) {
    this.notesPath = notesPath;
    this.maxSizeBytes = Math.max(1, maxSizeKb) * 1024;
    this.trimKeepLastN = Math.max(1, trimKeepLastN);
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 加载完整 notes.md
   *
   * @returns 完整 markdown 内容（文件不存在返回空字符串）
   */
  load(): string {
    if (!this.cacheDirty && this.cachedContent !== null) {
      return this.cachedContent;
    }
    if (!fs.existsSync(this.notesPath)) {
      this.cachedContent = "";
      this.cacheDirty = false;
      return "";
    }
    // 真实读取 UTF-8（不模拟）
    const content = fs.readFileSync(this.notesPath, "utf-8");
    this.cachedContent = content;
    this.cacheDirty = false;
    return content;
  }

  /**
   * 追加一个段落
   *
   * @param section 段落对象
   */
  append(section: NotesSection): void {
    if (!section || typeof section.title !== "string") {
      throw new TypeError(`section 必须是 NotesSection 实例，实际: ${typeof section}`);
    }

    // 加载现有内容（用于 trim 决策）
    const current = this.load();
    // 序列化新段落
    const newChunk = this.serializeSection(section);
    const merged = current ? current + newChunk : newChunk;
    // 写回（atomicWrite 内部会判断是否需要 trim）
    this.atomicWrite(merged);
  }

  /**
   * 解析 notes.md 为段落列表
   *
   * @returns 按文件顺序排列的段落
   */
  listSections(): NotesSection[] {
    const content = this.load();
    if (!content.trim()) {
      return [];
    }
    const sections: NotesSection[] = [];
    // 找到所有 "## " 标题的位置
    const matches: Array<{ start: number; end: number; title: string }> = [];
    let m: RegExpExecArray | null;
    // 每次调用都新建正则（避免 lastIndex 状态泄漏）
    const re = new RegExp(SECTION_HEADER_RE.source, SECTION_HEADER_RE.flags);
    while ((m = re.exec(content)) !== null) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        title: m[1]!.trim(),
      });
    }
    if (matches.length === 0) {
      return [];
    }
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i]!;
      const next = matches[i + 1];
      // 段起始 = 标题行起始
      const start = cur.start;
      // 段结束 = 下一个标题起始 或 文件结尾
      const end = next ? next.start : content.length;
      const chunk = content.slice(start, end);
      // 解析元数据注释行
      const meta = parseMetaComment(chunk);
      let iterIndex: number;
      let tags: string[];
      let body: string;
      if (meta) {
        iterIndex = meta.iterIndex;
        tags = meta.tags;
        // body = 注释行之后到下一个 ## 之前
        const afterMeta = chunk.slice(meta.endOffset);
        body = afterMeta.replace(/^\n+/, "").replace(/\s+$/, "");
      } else {
        // 没有元数据 → 推断 iter_index 为列表位置 + 1
        iterIndex = i + 1;
        tags = [];
        // 去掉标题行
        const titleLine = `## ${cur.title}`;
        body = chunk.slice(titleLine.length).replace(/^\n+/, "").replace(/\s+$/, "");
      }
      sections.push({
        title: cur.title,
        body,
        timestamp: "",
        iterIndex,
        tags,
      });
    }
    return sections;
  }

  /**
   * 获取最近 N 个段落
   *
   * @param n 取最近 N 个
   */
  getRecentSections(n: number = 5): NotesSection[] {
    const allSections = this.listSections();
    if (n <= 0) {
      return [];
    }
    return allSections.slice(-n);
  }

  /**
   * 粗略 token 估算（char/4 启发式）
   *
   * @returns 估算 token 数
   */
  estimateTokens(): number {
    return Math.floor(this.load().length / 4);
  }

  /**
   * 写入最终总结（追加到末尾）
   *
   * @param summary 总结内容
   */
  writeFinalSummary(summary: string): void {
    if (!summary) {
      return;
    }
    const section: NotesSection = {
      title: "Final Summary",
      body: summary.trim(),
      timestamp: new Date().toISOString(),
      iterIndex: 0,
      tags: ["final"],
    };
    this.append(section);
  }

  /**
   * 清空 notes.md（仅用于测试或显式重置）
   */
  clear(): void {
    if (fs.existsSync(this.notesPath)) {
      fs.unlinkSync(this.notesPath);
    }
    this.cachedContent = "";
    this.cacheDirty = false;
  }

  /**
   * 强制失效缓存（外部修改文件后调用）
   */
  invalidateCache(): void {
    this.cacheDirty = true;
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 序列化单个段落为 markdown 字符串
   *
   * 格式：
   *   ## <title>
   *   <!-- iter=<N> tags=t1,t2 -->
   *   <body>
   */
  private serializeSection(section: NotesSection): string {
    const ts = section.timestamp || new Date().toISOString();
    const tagsPart = section.tags.length > 0 ? ` tags=${section.tags.join(",")}` : "";
    const metaLine = `<!-- iter=${section.iterIndex}${tagsPart} -->`;
    const body = section.body.replace(/\s+$/, "");
    // 段之间保留一个空行
    return `## ${section.title}\n${metaLine}\n\n${body}\n\n`;
  }

  /**
   * 原子写入（先 .tmp，fsync，rename）
   *
   * @param content 完整 markdown 内容
   */
  private atomicWrite(content: string): void {
    // 确保父目录存在
    const parentDir = path.dirname(this.notesPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    // 检查是否需要 trim
    const trimmed = this.trimContent(content);
    // 写 .tmp
    const tmpPath = `${this.notesPath}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, trimmed, 0, "utf-8");
      // 强制 fsync（确保数据落盘后再 rename）
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // 原子 rename（跨平台）
    fs.renameSync(tmpPath, this.notesPath);
    // 更新缓存
    this.cachedContent = trimmed;
    this.cacheDirty = false;
  }

  /**
   * 检查并 trim（超过 max_size_kb 时保留最近 N 个段落）
   */
  private trimContent(content: string): string {
    const encodedSize = Buffer.byteLength(content, "utf-8");
    if (encodedSize <= this.maxSizeBytes) {
      return content;
    }

    // 解析所有段，保留最近 N 段
    const sections = this.splitIntoRawSections(content);
    if (sections.length <= this.trimKeepLastN) {
      return content; // 段数太少，无法 trim
    }

    const keep = sections.slice(-this.trimKeepLastN);
    // 加一个 trim 提示段
    const trimMarker =
      `## _trimmed_at_${new Date().toISOString()}\n` +
      `<!-- iter=0 tags=trimmed -->\n\n` +
      `_Earlier ${sections.length - this.trimKeepLastN} sections ` +
      `were trimmed to stay under max_size_kb=${Math.floor(this.maxSizeBytes / 1024)}._\n\n`;
    return trimMarker + keep.join("");
  }

  /**
   * 将完整 markdown 拆分为原始段字符串列表
   */
  private splitIntoRawSections(content: string): string[] {
    const matches: Array<{ start: number; title: string }> = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(SECTION_HEADER_RE.source, SECTION_HEADER_RE.flags);
    while ((m = re.exec(content)) !== null) {
      matches.push({ start: m.index, title: m[1]!.trim() });
    }
    if (matches.length === 0) {
      return [content];
    }
    const result: string[] = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i]!;
      const next = matches[i + 1];
      const start = cur.start;
      const end = next ? next.start : content.length;
      result.push(content.slice(start, end));
    }
    return result;
  }
}

// ============================================================================
// 内部辅助函数
// ============================================================================

interface ParsedMeta {
  iterIndex: number;
  tags: string[];
  /** chunk 中 meta 行结尾的偏移（用于切片 body） */
  endOffset: number;
}

/**
 * 解析 chunk 中的元数据注释行
 *
 * @returns 解析结果，chunk 中无元数据返回 null
 */
function parseMetaComment(chunk: string): ParsedMeta | null {
  // 重置 lastIndex
  const re = new RegExp(META_COMMENT_RE.source, META_COMMENT_RE.flags);
  const m = re.exec(chunk);
  if (!m) return null;
  const iterIndex = parseInt(m[1]!, 10);
  const tagsStr = m[2] || "";
  const tags = tagsStr ? tagsStr.split(",").filter((t) => t.length > 0) : [];
  return {
    iterIndex,
    tags,
    endOffset: m.index + m[0].length,
  };
}
