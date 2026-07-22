/**
 * EAG-P5 Phase 5.2 NotesMemory 跨轮记忆（TASK-P5-1.2-002）
 *
 * 本模块实现 `NotesMemory` 类，提供 AutonomousOrchestrator 4 阶段循环的
 * 跨轮 notes.md 记忆能力，是 EAG-P5 无人值守模式跨轮上下文传递（FR-7）
 * 的核心基础设施。
 *
 * 核心职责（对齐架构师审查文档 §4.1 + §11 兼容性矩阵）：
 * 1. 将 notes 以标准 markdown 格式持久化（LLM 可直接消费）
 * 2. 原子写入：先 .tmp，fsync 后 rename（避免半写）
 * 3. 段落式：每轮迭代一个 section，标题含 iter_index + stage
 * 4. 跨轮记忆：loadNotes(runId) 加载完整 notes 内容
 * 5. 追加段落：appendNote(runId, note) 追加新段落
 * 6. 决策提取：getDecisions(runId) 从 notes 中提取 DECISION 标签段落
 *
 * 与 team/autonomous/notes-memory.ts 的差异：
 * - team 版：面向 RalphLoopController，基于 notesPath 单文件
 * - P5 版：面向 AutonomousOrchestrator，基于 runId + projectRoot 多 run 隔离
 * - P5 版接口更聚焦：loadNotes / appendNote / getDecisions（3 个方法）
 * - P5 版支持 DECISION 标签提取（供 SmartConfirmation 决策回溯）
 *
 * 关键技术决策（对齐架构师审查 §4.1）：
 * - 存储格式：标准 markdown（每段一个 ## 标题）
 * - 原子写入：.tmp → fsync → rename（操作系统级原子性）
 * - 路径布局：<projectRoot>/.eag/p5/notes/<run-id>.md
 * - 元数据：HTML 注释行（<!-- iter=N stage=dev tags=success,decision -->）
 * - 缓存：内存缓存避免重复读盘，写入时失效
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/p5/notes-memory
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * P5 NotesMemory 默认存储目录（相对 projectRoot）
 *
 * 与 P3 版 .eag/notes/ 区分，避免与 long-horizon 模块的 notes 文件冲突。
 */
const P5_DEFAULT_NOTES_DIR = ".eag/p5/notes" as const;

/**
 * Notes 文件扩展名
 */
const P5_NOTES_EXTENSION = ".md" as const;

/**
 * 默认最大 notes 文件大小（KB）
 *
 * 超过此大小触发 trim，保留最近 N 段。
 * 取值 1024KB（1MB）：平衡内存占用与跨轮记忆深度。
 */
const P5_DEFAULT_MAX_SIZE_KB = 1024 as const;

/**
 * 默认 trim 时保留的最近段落数
 *
 * 取值 20：覆盖大多数 4 阶段循环的迭代深度（50 次迭代 × 4 阶段 = 200 段，
 * 但每段平均 5KB，超过 1MB 时保留最近 20 段足够上下文）。
 */
const P5_DEFAULT_TRIM_KEEP_LAST_N = 20 as const;

/**
 * 决策标签（用于 getDecisions 提取）
 *
 * 段落元数据注释行中 tags 字段含 "decision" 时，该段落视为决策记录。
 */
const P5_DECISION_TAG = "decision" as const;

/**
 * markdown 段标题正则：以 "## " 开头的行
 *
 * 全局匹配，用于段落切分。
 */
const SECTION_HEADER_RE = /^##\s+(.+)$/gm;

/**
 * 段元数据注释行正则：<!-- iter=N stage=plan tags=tag1,tag2 -->
 *
 * 各字段均为可选，但至少需含 iter 或 stage 之一。
 */
const META_COMMENT_RE = /^<!--\s*iter=(\d+)(?:\s+stage=([a-z]+))?(?:\s+tags=([^\s>]+))?\s*-->\s*$/gm;

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * Notes 段落（单个 markdown section）
 *
 * 每段对应一次 4 阶段循环中某个阶段的执行记录。
 *
 * 字段全部 readonly——段落一经写入即不可变。
 *
 * 范例：
 *   {
 *     title: "Iter 3 / dev 阶段",
 *     body: "实现了 UserService.login 方法，新增 5 个测试用例全部通过",
 *     timestamp: "2026-07-21T10:30:00.000Z",
 *     iterIndex: 3,
 *     stage: "dev",
 *     tags: ["success", "test-passed"]
 *   }
 */
export interface P5NotesSection {
  /** 段标题（不含 "## " 前缀） */
  readonly title: string;
  /** 段内容（markdown 格式） */
  readonly body: string;
  /** 时间戳（ISO 8601 字符串） */
  readonly timestamp: string;
  /** 所属迭代号（0-based） */
  readonly iterIndex: number;
  /** 所属阶段（plan/dev/verify/fix） */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 标签列表（如 ["success", "test-passed", "decision"]） */
  readonly tags: ReadonlyArray<string>;
}

/**
 * 决策记录（从 notes 中提取的决策段落）
 *
 * 段落 tags 含 "decision" 时，该段落视为决策记录。
 * 用于 SmartConfirmation 回溯用户决策（如"放宽 E7 评估器规则"）。
 *
 * 字段全部 readonly。
 *
 * 范例：
 *   {
 *     iterIndex: 3,
 *     stage: "verify",
 *     decision: "放宽 E7 评估器规则，允许值对象不含业务方法",
 *     timestamp: "2026-07-21T10:45:00.000Z"
 *   }
 */
export interface P5DecisionRecord {
  /** 决策所属迭代号 */
  readonly iterIndex: number;
  /** 决策所属阶段 */
  readonly stage: "plan" | "dev" | "verify" | "fix";
  /** 决策内容（段落 body） */
  readonly decision: string;
  /** 决策时间戳 */
  readonly timestamp: string;
}

/**
 * NotesMemory 错误类型（字面量联合类型）
 *
 * - io-failed：底层文件系统 I/O 失败
 * - invalid-request：请求字段非法
 */
export type P5NotesMemoryErrorKind = "io-failed" | "invalid-request";

/**
 * P5 NotesMemory 错误基类
 *
 * 所有 P5 NotesMemory 相关错误均继承自此基类，
 * 调用方可以通过 instanceof P5NotesMemoryError 统一捕获，
 * 也可通过 err.kind 区分具体错误类型分别处理。
 */
export class P5NotesMemoryError extends Error {
  /**
   * @param kind 错误类型（P5NotesMemoryErrorKind 之一）
   * @param detail 错误详情（人类可读）
   * @param runId 关联的 run-id（便于日志溯源）
   */
  constructor(
    public readonly kind: P5NotesMemoryErrorKind,
    public readonly detail: string,
    public readonly runId?: string
  ) {
    super(`P5 NotesMemory 错误 [${kind}]${runId ? ` runId=${runId}` : ""}：${detail}`);
    this.name = "P5NotesMemoryError";
    Object.setPrototypeOf(this, P5NotesMemoryError.prototype);
  }
}

// ============================================================================
// 3. NotesMemory 主类
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 */
function p5NotesNoopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

/**
 * 日志回调函数类型（复用 run-state-store 的 P5LogCallback 定义）
 */
export type P5NotesLogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * NotesMemory —— 跨轮 notes.md 记忆（P5 版）
 *
 * 算法：
 * 1. loadNotes(runId, projectRoot)：读取 <projectRoot>/.eag/p5/notes/<runId>.md 全部内容
 * 2. appendNote(runId, projectRoot, note)：原子追加新段落（.tmp → fsync → rename）
 * 3. getDecisions(runId, projectRoot)：解析 notes，提取 tags 含 "decision" 的段落
 * 4. listSections(runId, projectRoot)：解析 notes 为段落列表
 *
 * 并发安全：
 * - 单 run-id 同一时刻允许并发读写（notes 是追加式，写入冲突概率低）
 * - 写入采用原子 rename，避免半写
 *
 * 使用方式：
 * ```typescript
 * const memory = new P5NotesMemory();
 * // 追加段落
 * await memory.appendNote("run-001", "/path/to/project", {
 *   title: "Iter 0 / plan 阶段",
 *   body: "分析需求，制定计划：1. 实现 UserService 2. 编写测试",
 *   timestamp: new Date().toISOString(),
 *   iterIndex: 0,
 *   stage: "plan",
 *   tags: ["planning"],
 * });
 * // 加载完整 notes
 * const content = await memory.loadNotes("run-001", "/path/to/project");
 * // 提取决策
 * const decisions = await memory.getDecisions("run-001", "/path/to/project");
 * ```
 */
export class P5NotesMemory {
  /** 最大文件大小（字节） */
  private readonly maxSizeBytes: number;
  /** trim 时保留的最近段落数 */
  private readonly trimKeepLastN: number;
  /** 日志回调 */
  private readonly log: P5NotesLogCallback;
  /** runId → 缓存内容（避免重复读盘） */
  private readonly cache: Map<string, string>;

  /**
   * @param maxSizeKb 最大 notes 文件大小（KB），超过则 trim（默认 1024KB）
   * @param trimKeepLastN trim 时保留最近 N 段（默认 20）
   * @param logger 日志回调（可选）
   */
  constructor(
    maxSizeKb: number = P5_DEFAULT_MAX_SIZE_KB,
    trimKeepLastN: number = P5_DEFAULT_TRIM_KEEP_LAST_N,
    logger: P5NotesLogCallback = p5NotesNoopLog
  ) {
    this.maxSizeBytes = Math.max(1, maxSizeKb) * 1024;
    this.trimKeepLastN = Math.max(1, trimKeepLastN);
    this.log = logger;
    this.cache = new Map();
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  /**
   * 加载完整 notes.md 内容
   *
   * 算法：
   * 1. 校验入参
   * 2. 检查缓存，命中则直接返回
   * 3. 解析路径，检查文件存在
   * 4. 读取 UTF-8 内容，更新缓存
   * 5. 返回完整 markdown 字符串
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 完整 markdown 内容（文件不存在返回空字符串）
   * @throws P5NotesMemoryError 请求非法 / I/O 失败
   */
  async loadNotes(runId: string, projectRoot: string): Promise<string> {
    // 1. 校验入参
    this.validateRunIdAndProjectRoot(runId, projectRoot);

    // 2. 检查缓存
    const cacheKey = this.cacheKey(runId, projectRoot);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // 3. 解析路径
    const notesPath = this.resolveNotesPath(runId, projectRoot);

    // 4. 检查文件存在
    if (!fs.existsSync(notesPath)) {
      this.log(`P5 loadNotes：文件不存在，返回空字符串：runId=${runId}`, "info");
      return "";
    }

    // 5. 读取内容
    let content: string;
    try {
      content = fs.readFileSync(notesPath, "utf8");
    } catch (err) {
      throw new P5NotesMemoryError(
        "io-failed",
        `读取 notes 文件失败：${notesPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    // 6. 更新缓存
    this.cache.set(cacheKey, content);

    return content;
  }

  /**
   * 追加一个段落到 notes.md
   *
   * 算法：
   * 1. 校验入参
   * 2. 加载现有内容（用于 trim 决策）
   * 3. 序列化新段落为 markdown 字符串
   * 4. 合并内容（现有 + 新段落）
   * 5. 检查是否需要 trim（超过 maxSizeBytes 时保留最近 N 段）
   * 6. 原子写入（.tmp → fsync → rename）
   * 7. 更新缓存
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @param section 段落对象
   * @throws P5NotesMemoryError 请求非法 / I/O 失败
   */
  async appendNote(runId: string, projectRoot: string, section: Readonly<P5NotesSection>): Promise<void> {
    // 1. 校验入参
    this.validateRunIdAndProjectRoot(runId, projectRoot);
    if (!section || typeof section.title !== "string" || section.title.trim().length === 0) {
      throw new P5NotesMemoryError("invalid-request", "section.title 必须为非空字符串", runId);
    }
    if (typeof section.body !== "string") {
      throw new P5NotesMemoryError("invalid-request", "section.body 必须为字符串", runId);
    }
    if (typeof section.iterIndex !== "number" || section.iterIndex < 0) {
      throw new P5NotesMemoryError("invalid-request", "section.iterIndex 必须为非负整数", runId);
    }
    if (!["plan", "dev", "verify", "fix"].includes(section.stage)) {
      throw new P5NotesMemoryError(
        "invalid-request",
        `section.stage 非法：${section.stage}（合法值：plan/dev/verify/fix）`,
        runId
      );
    }

    // 2. 加载现有内容
    const current = await this.loadNotes(runId, projectRoot);

    // 3. 序列化新段落
    const newChunk = this.serializeSection(section);

    // 4. 合并内容
    const merged = current ? current + newChunk : newChunk;

    // 5. 原子写入（内部会判断是否需要 trim）
    await this.atomicWrite(runId, projectRoot, merged);

    this.log(`P5 appendNote：runId=${runId} iterIndex=${section.iterIndex} stage=${section.stage}`, "info");
  }

  /**
   * 从 notes.md 提取决策记录（tags 含 "decision" 的段落）
   *
   * 算法：
   * 1. 调用 listSections 解析全部段落
   * 2. 过滤 tags 含 "decision" 的段落
   * 3. 转换为 P5DecisionRecord 格式
   * 4. 返回决策记录列表（按时间顺序）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 决策记录列表
   * @throws P5NotesMemoryError 请求非法 / I/O 失败
   */
  async getDecisions(runId: string, projectRoot: string): Promise<ReadonlyArray<Readonly<P5DecisionRecord>>> {
    // 1. 解析全部段落
    const sections = await this.listSections(runId, projectRoot);

    // 2. 过滤含 "decision" 标签的段落
    const decisions: P5DecisionRecord[] = [];
    for (const section of sections) {
      if (section.tags.includes(P5_DECISION_TAG)) {
        decisions.push(
          Object.freeze({
            iterIndex: section.iterIndex,
            stage: section.stage,
            decision: section.body,
            timestamp: section.timestamp,
          })
        );
      }
    }

    return Object.freeze(decisions);
  }

  /**
   * 解析 notes.md 为段落列表
   *
   * 算法：
   * 1. 加载完整 markdown 内容
   * 2. 扫描所有 "## " 标题位置
   * 3. 按标题切分段落
   * 4. 解析每段的元数据注释行（iter / stage / tags）
   * 5. 返回段落列表
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns 段落列表（按文件顺序）
   * @throws P5NotesMemoryError 请求非法 / I/O 失败
   */
  async listSections(runId: string, projectRoot: string): Promise<ReadonlyArray<Readonly<P5NotesSection>>> {
    // 1. 校验入参
    this.validateRunIdAndProjectRoot(runId, projectRoot);

    // 2. 加载内容
    const content = await this.loadNotes(runId, projectRoot);
    if (!content.trim()) {
      return Object.freeze([]);
    }

    // 3. 扫描所有 "## " 标题位置
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
      return Object.freeze([]);
    }

    // 4. 按标题切分段落
    const sections: P5NotesSection[] = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i]!;
      const next = matches[i + 1];
      // 段起始 = 标题行起始
      const start = cur.start;
      // 段结束 = 下一个标题起始 或 文件结尾
      const end = next ? next.start : content.length;
      const chunk = content.slice(start, end);

      // 5. 解析元数据注释行
      const meta = parseMetaComment(chunk);
      let iterIndex: number;
      let stage: "plan" | "dev" | "verify" | "fix";
      let tags: string[];
      let body: string;
      let timestamp: string;

      if (meta) {
        iterIndex = meta.iterIndex;
        stage = meta.stage;
        tags = meta.tags;
        // body = 注释行之后到下一个 ## 之前
        const afterMeta = chunk.slice(meta.endOffset);
        body = afterMeta.replace(/^\n+/, "").replace(/\s+$/, "");
        // 时间戳从元数据注释行后第一行提取（如 "*2026-07-21T10:30:00.000Z*"）
        timestamp = extractTimestamp(body);
      } else {
        // 没有元数据 → 推断 iter_index 为列表位置 + 1，stage 默认 plan
        iterIndex = i + 1;
        stage = "plan";
        tags = [];
        // 去掉标题行
        const titleLine = `## ${cur.title}`;
        body = chunk.slice(titleLine.length).replace(/^\n+/, "").replace(/\s+$/, "");
        timestamp = "";
      }

      sections.push(
        Object.freeze({
          title: cur.title,
          body,
          timestamp,
          iterIndex,
          stage,
          tags: Object.freeze([...tags]),
        })
      );
    }

    return Object.freeze(sections);
  }

  /**
   * 写入最终总结段落（追加到末尾，标记 final 标签）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @param summary 总结内容
   * @throws P5NotesMemoryError 请求非法 / I/O 失败
   */
  async writeFinalSummary(runId: string, projectRoot: string, summary: string): Promise<void> {
    if (typeof summary !== "string" || summary.trim().length === 0) {
      throw new P5NotesMemoryError("invalid-request", "summary 必须为非空字符串", runId);
    }

    const section: P5NotesSection = {
      title: "Final Summary",
      body: summary.trim(),
      timestamp: new Date().toISOString(),
      iterIndex: 0,
      stage: "plan", // final summary 不属于任何具体阶段，使用 plan 占位
      tags: ["final"],
    };
    await this.appendNote(runId, projectRoot, section);
  }

  /**
   * 清空 notes.md（仅用于测试或显式重置）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   */
  async clear(runId: string, projectRoot: string): Promise<void> {
    this.validateRunIdAndProjectRoot(runId, projectRoot);
    const notesPath = this.resolveNotesPath(runId, projectRoot);
    if (fs.existsSync(notesPath)) {
      try {
        fs.unlinkSync(notesPath);
      } catch (err) {
        throw new P5NotesMemoryError(
          "io-failed",
          `删除 notes 文件失败：${notesPath} 错误：${(err as Error).message}`,
          runId
        );
      }
    }
    // 失效缓存
    const cacheKey = this.cacheKey(runId, projectRoot);
    this.cache.delete(cacheKey);
  }

  /**
   * 强制失效缓存（外部修改文件后调用）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   */
  invalidateCache(runId: string, projectRoot: string): void {
    const cacheKey = this.cacheKey(runId, projectRoot);
    this.cache.delete(cacheKey);
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 校验 runId 与 projectRoot 入参
   */
  private validateRunIdAndProjectRoot(runId: string, projectRoot: string): void {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new P5NotesMemoryError("invalid-request", "runId 必须为非空字符串");
    }
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
      throw new P5NotesMemoryError("invalid-request", `runId 仅允许字母/数字/连字符，实际值：${runId}`);
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new P5NotesMemoryError("invalid-request", "projectRoot 必须为非空字符串");
    }
  }

  /**
   * 解析 notes 文件绝对路径
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns notes 文件绝对路径
   */
  private resolveNotesPath(runId: string, projectRoot: string): string {
    const projectRootAbs = path.resolve(projectRoot);
    const notesDir = path.join(projectRootAbs, P5_DEFAULT_NOTES_DIR);
    return path.join(notesDir, runId + P5_NOTES_EXTENSION);
  }

  /**
   * 构造缓存键
   */
  private cacheKey(runId: string, projectRoot: string): string {
    return `${projectRoot}::${runId}`;
  }

  /**
   * 序列化单个段落为 markdown 字符串
   *
   * 格式：
   *   ## <title>
   *   <!-- iter=<N> stage=<stage> tags=t1,t2 -->
   *   *<timestamp>*
   *
   *   <body>
   *
   * @param section 段落对象
   * @returns markdown 字符串
   */
  private serializeSection(section: Readonly<P5NotesSection>): string {
    const ts = section.timestamp || new Date().toISOString();
    const tagsPart = section.tags.length > 0 ? ` tags=${section.tags.join(",")}` : "";
    const metaLine = `<!-- iter=${section.iterIndex} stage=${section.stage}${tagsPart} -->`;
    const body = section.body.replace(/\s+$/, "");
    // 段之间保留一个空行
    return `## ${section.title}\n${metaLine}\n*${ts}*\n\n${body}\n\n`;
  }

  /**
   * 原子写入（先 .tmp，fsync，rename）
   *
   * 算法：
   * 1. 确保父目录存在（mkdir -p）
   * 2. 检查是否需要 trim（超过 maxSizeBytes 时保留最近 N 段）
   * 3. 写 .tmp 文件
   * 4. fsync 确保数据落盘
   * 5. 原子 rename 覆盖原文件
   * 6. 更新缓存
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @param content 完整 markdown 内容
   */
  private async atomicWrite(runId: string, projectRoot: string, content: string): Promise<void> {
    const notesPath = this.resolveNotesPath(runId, projectRoot);

    // 1. 确保父目录存在
    const parentDir = path.dirname(notesPath);
    fs.mkdirSync(parentDir, { recursive: true });

    // 2. 检查是否需要 trim
    const trimmed = this.trimContent(content);

    // 3. 写 .tmp 文件
    const tmpPath = `${notesPath}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, "w");
    } catch (err) {
      throw new P5NotesMemoryError(
        "io-failed",
        `打开 .tmp 文件失败：${tmpPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    try {
      try {
        fs.writeSync(fd, trimmed, 0, "utf8");
        // 强制 fsync（确保数据落盘后再 rename）
        fs.fsyncSync(fd);
      } catch (err) {
        throw new P5NotesMemoryError(
          "io-failed",
          `写入 .tmp 文件失败：${tmpPath} 错误：${(err as Error).message}`,
          runId
        );
      }
    } finally {
      fs.closeSync(fd);
    }

    // 4. 原子 rename（跨平台）
    try {
      fs.renameSync(tmpPath, notesPath);
    } catch (err) {
      throw new P5NotesMemoryError(
        "io-failed",
        `rename .tmp 到 notes 文件失败：${tmpPath} → ${notesPath} 错误：${(err as Error).message}`,
        runId
      );
    }

    // 5. 更新缓存
    const cacheKey = this.cacheKey(runId, projectRoot);
    this.cache.set(cacheKey, trimmed);
  }

  /**
   * 检查并 trim（超过 maxSizeBytes 时保留最近 N 段）
   *
   * @param content 完整 markdown 内容
   * @returns trim 后的内容（若未超限则原样返回）
   */
  private trimContent(content: string): string {
    const encodedSize = Buffer.byteLength(content, "utf8");
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
      `<!-- iter=0 stage=plan tags=trimmed -->\n\n` +
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
// 4. 内部辅助函数
// ============================================================================

/**
 * 解析 chunk 中的元数据注释行
 *
 * @param chunk 段落字符串（含标题行）
 * @returns 解析结果，chunk 中无元数据返回 null
 */
interface ParsedMeta {
  iterIndex: number;
  stage: "plan" | "dev" | "verify" | "fix";
  tags: string[];
  /** chunk 中 meta 行结尾的偏移（用于切片 body） */
  endOffset: number;
}

function parseMetaComment(chunk: string): ParsedMeta | null {
  // 重置 lastIndex
  const re = new RegExp(META_COMMENT_RE.source, META_COMMENT_RE.flags);
  const m = re.exec(chunk);
  if (!m) return null;
  const iterIndex = parseInt(m[1]!, 10);
  const stageStr = m[2] || "plan";
  // 校验 stage 合法性
  const stage = (["plan", "dev", "verify", "fix"].includes(stageStr) ? stageStr : "plan") as
    | "plan"
    | "dev"
    | "verify"
    | "fix";
  const tagsStr = m[3] || "";
  const tags = tagsStr ? tagsStr.split(",").filter((t) => t.length > 0) : [];
  return {
    iterIndex,
    stage,
    tags,
    endOffset: m.index + m[0].length,
  };
}

/**
 * 从 body 中提取时间戳（格式：*ISO 8601*）
 *
 * @param body 段落 body
 * @returns 时间戳字符串（未找到返回空字符串）
 */
function extractTimestamp(body: string): string {
  // 匹配 *ISO 8601* 格式的时间戳
  const m = body.match(/^\*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\*/m);
  return m ? m[1]! : "";
}

// ============================================================================
// 5. 工厂函数与导出
// ============================================================================

/**
 * 创建默认 P5NotesMemory 实例
 *
 * @param logger 日志回调（可选）
 * @returns 默认 P5NotesMemory 实例
 */
export function createDefaultP5NotesMemory(logger?: P5NotesLogCallback): P5NotesMemory {
  return new P5NotesMemory(P5_DEFAULT_MAX_SIZE_KB, P5_DEFAULT_TRIM_KEEP_LAST_N, logger);
}

/**
 * 导出常量（供测试断言）
 */
export {
  P5_DEFAULT_NOTES_DIR,
  P5_NOTES_EXTENSION,
  P5_DEFAULT_MAX_SIZE_KB,
  P5_DEFAULT_TRIM_KEEP_LAST_N,
  P5_DECISION_TAG,
};
