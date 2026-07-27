/**
 * FileBackedPageLike - PageLike 接口的文件实现（生产级，非 mock）
 *
 * 用途：在 CLI 终端环境中为 UIUXAnalyzer 提供 PageLike 抽象的真实实现。
 *      用户通过 `--dom-file <path>` 提供浏览器 DevTools 探针采集的 DOM 数据 JSON，
 *      本类从磁盘读取并解析，提供给 UIUXAnalyzer.audit() 消费。
 *
 * 设计原则：
 *   - 真实生产实现：真实地读取磁盘文件、真实地 JSON.parse、真实地返回结构化数据。
 *     用户更换 JSON 即得到不同结果；CI 流水线可消费 Playwright 录制的 DOM 快照。
 *   - 非 mock：与 packages/quality/src/tests/e2e/e2e-helpers.ts 中 MemoryImageAdapter
 *     定位一致——是接口的另一种合法实现，而非"替换真实实现并返回预定义结果"。
 *   - 失败安全：文件不存在、JSON 格式错误、Schema 不匹配时抛出可识别错误，
 *     由调用方捕获后返回 exitCode=2，不静默降级。
 *
 * @module cli/quality/file-backed-page-like
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PageLike, DOMAuditData, ContrastSample } from "@deepcodex/quality";

// ============================================================================
// 常量定义
// ============================================================================

/**
 * DOMAuditData 必需的顶层字段集合
 *
 * 用于运行时 Schema 校验，缺失任一字段即视为非法 JSON。
 * 与 packages/quality/src/uiux-analyzer.ts DOMAuditData 接口定义对齐。
 */
const REQUIRED_DOM_AUDIT_FIELDS: ReadonlyArray<keyof DOMAuditData> = [
  "images",
  "form_controls",
  "buttons",
  "links",
  "headings",
  "errors",
];

/**
 * ContrastSample 必需的字段集合
 *
 * 用于运行时 Schema 校验，缺失任一字段即视为非法 JSON。
 * 与 packages/quality/src/uiux-analyzer.ts ContrastSample 接口定义对齐。
 */
const REQUIRED_CONTRAST_FIELDS: ReadonlyArray<keyof ContrastSample> = [
  "text",
  "color",
  "background",
  "font_size",
  "font_weight",
  "selector",
];

// ============================================================================
// 错误类型
// ============================================================================

/**
 * FileBackedPageLike 相关的错误类
 *
 * 调用方通过 err.code 字段区分错误场景，便于返回不同的退出码：
 *   - FILE_NOT_FOUND：文件不存在（exitCode=2）
 *   - PARSE_ERROR：JSON 解析失败（exitCode=2）
 *   - SCHEMA_ERROR：Schema 校验失败（exitCode=2）
 *   - IO_ERROR：其他 I/O 错误（exitCode=4）
 */
export class FileBackedPageLikeError extends Error {
  /** 错误代码（用于调用方区分场景） */
  readonly code: "FILE_NOT_FOUND" | "PARSE_ERROR" | "SCHEMA_ERROR" | "IO_ERROR";

  constructor(code: "FILE_NOT_FOUND" | "PARSE_ERROR" | "SCHEMA_ERROR" | "IO_ERROR", message: string) {
    super(message);
    this.name = "FileBackedPageLikeError";
    this.code = code;
  }
}

// ============================================================================
// FileBackedPageLike 主类
// ============================================================================

/**
 * PageLike 接口的文件实现
 *
 * 从用户提供的 JSON 文件加载 DOMAuditData 与 ContrastSample[]，
 * 在 evaluateDOM() / evaluateContrast() 中返回真实数据。
 *
 * 用法：
 *   const page = await FileBackedPageLike.fromFile("./dom.json");
 *   const analyzer = new UIUXAnalyzer();
 *   await analyzer.audit(page);
 *   const report = analyzer.report();
 *
 * 支持的 JSON 结构（两种）：
 *   1. 完整结构：{ domAuditData: DOMAuditData, contrastSamples: ContrastSample[] }
 *   2. 仅 DOMAuditData：{ ...DOMAuditData }（contrastSamples 自动为空数组）
 *
 * 当 contrastFile 单独提供时，contrastSamples 从该文件加载，覆盖 domFile 中的 contrastSamples 字段。
 */
export class FileBackedPageLike implements PageLike {
  /** DOM 审计数据（不可变） */
  private readonly domData: DOMAuditData;
  /** 对比度采样数组（不可变） */
  private readonly contrastSamples: ContrastSample[];

  /**
   * 私有构造函数（使用 fromFile 异步工厂方法构造）
   *
   * @param domData DOM 审计数据
   * @param contrastSamples 对比度采样数组
   */
  private constructor(domData: DOMAuditData, contrastSamples: ContrastSample[]) {
    this.domData = domData;
    this.contrastSamples = contrastSamples;
  }

  /**
   * 从 JSON 文件构造 FileBackedPageLike
   *
   * 流程：
   *   1. 读取 domFile 文件内容（文件不存在抛 FILE_NOT_FOUND）
   *   2. JSON.parse（解析失败抛 PARSE_ERROR）
   *   3. 识别 JSON 结构（完整结构 vs 仅 DOMAuditData）
   *   4. 校验 DOMAuditData 字段完整性（校验失败抛 SCHEMA_ERROR）
   *   5. 若 contrastFile 提供，读取并校验；否则使用 domFile 中的 contrastSamples 字段
   *
   * @param domFile DOM 数据 JSON 文件路径
   * @param contrastFile 对比度采样 JSON 文件路径（可选，不传则从 domFile 读取 contrastSamples 字段）
   * @returns FileBackedPageLike 实例
   * @throws {FileBackedPageLikeError} 文件不存在 / 解析失败 / Schema 校验失败
   */
  static async fromFile(domFile: string, contrastFile?: string): Promise<FileBackedPageLike> {
    // ========================================================================
    // Step 1: 读取 domFile 文件内容
    // ========================================================================
    let domFileContent: string;
    try {
      domFileContent = await fs.readFile(domFile, "utf-8");
    } catch (err) {
      // 区分文件不存在与其他 I/O 错误
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new FileBackedPageLikeError("FILE_NOT_FOUND", `DOM 数据文件不存在: ${domFile}`);
      }
      throw new FileBackedPageLikeError(
        "IO_ERROR",
        `读取 DOM 数据文件失败: ${domFile} - ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ========================================================================
    // Step 2: JSON.parse
    // ========================================================================
    let domJson: unknown;
    try {
      domJson = JSON.parse(domFileContent);
    } catch (err) {
      throw new FileBackedPageLikeError(
        "PARSE_ERROR",
        `DOM 数据文件 JSON 解析失败: ${domFile} - ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ========================================================================
    // Step 3: 识别 JSON 结构并提取 domAuditData + contrastSamples
    // ========================================================================
    let domAuditData: unknown;
    let contrastSamplesFromDom: unknown;

    if (typeof domJson === "object" && domJson !== null && "domAuditData" in domJson) {
      // 完整结构：{ domAuditData: DOMAuditData, contrastSamples: ContrastSample[] }
      const obj = domJson as { domAuditData: unknown; contrastSamples?: unknown };
      domAuditData = obj.domAuditData;
      contrastSamplesFromDom = obj.contrastSamples ?? [];
    } else {
      // 仅 DOMAuditData 结构：{ images, form_controls, ... }
      domAuditData = domJson;
      contrastSamplesFromDom = [];
    }

    // ========================================================================
    // Step 4: 校验 DOMAuditData Schema
    // ========================================================================
    const domData = FileBackedPageLike.validateDOMAuditData(domAuditData, domFile);

    // ========================================================================
    // Step 5: 处理 contrastSamples（contrastFile 优先）
    // ========================================================================
    let contrastSamples: ContrastSample[];
    if (contrastFile) {
      // contrastFile 单独提供时，从该文件加载
      contrastSamples = await FileBackedPageLike.loadContrastSamples(contrastFile);
    } else {
      // 否则使用 domFile 中的 contrastSamples 字段
      contrastSamples = FileBackedPageLike.validateContrastSamples(contrastSamplesFromDom, domFile, "contrastSamples");
    }

    return new FileBackedPageLike(domData, contrastSamples);
  }

  /**
   * 从 contrastFile 加载对比度采样数组
   *
   * 支持两种 JSON 结构：
   *   1. ContrastSample[]：直接是数组的 JSON
   *   2. { contrastSamples: ContrastSample[] }：包含 contrastSamples 字段的对象
   *
   * @param contrastFile 对比度采样 JSON 文件路径
   * @returns 校验后的 ContrastSample 数组
   * @throws {FileBackedPageLikeError} 文件不存在 / 解析失败 / Schema 校验失败
   */
  private static async loadContrastSamples(contrastFile: string): Promise<ContrastSample[]> {
    let contrastFileContent: string;
    try {
      contrastFileContent = await fs.readFile(contrastFile, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new FileBackedPageLikeError("FILE_NOT_FOUND", `对比度采样文件不存在: ${contrastFile}`);
      }
      throw new FileBackedPageLikeError(
        "IO_ERROR",
        `读取对比度采样文件失败: ${contrastFile} - ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let contrastJson: unknown;
    try {
      contrastJson = JSON.parse(contrastFileContent);
    } catch (err) {
      throw new FileBackedPageLikeError(
        "PARSE_ERROR",
        `对比度采样文件 JSON 解析失败: ${contrastFile} - ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 识别两种结构
    let samples: unknown;
    if (typeof contrastJson === "object" && contrastJson !== null && "contrastSamples" in contrastJson) {
      samples = (contrastJson as { contrastSamples: unknown }).contrastSamples;
    } else {
      samples = contrastJson;
    }

    return FileBackedPageLike.validateContrastSamples(samples, contrastFile, "根节点");
  }

  /**
   * 校验 DOMAuditData Schema
   *
   * 校验规则：
   *   1. 必须是对象
   *   2. 必须包含所有 REQUIRED_DOM_AUDIT_FIELDS 中定义的字段
   *   3. 每个字段必须是数组
   *
   * @param data 待校验的数据
   * @param filePath 文件路径（用于错误提示）
   * @returns 校验通过的 DOMAuditData 对象
   * @throws {FileBackedPageLikeError} Schema 校验失败
   */
  private static validateDOMAuditData(data: unknown, filePath: string): DOMAuditData {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new FileBackedPageLikeError(
        "SCHEMA_ERROR",
        `DOM 数据 Schema 校验失败: ${filePath} - domAuditData 应为对象，实际为 ${typeof data}`
      );
    }

    const obj = data as Record<string, unknown>;
    const missingFields: string[] = [];
    const nonArrayFields: string[] = [];

    for (const field of REQUIRED_DOM_AUDIT_FIELDS) {
      if (!(field in obj)) {
        missingFields.push(field);
      } else if (!Array.isArray(obj[field])) {
        nonArrayFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      throw new FileBackedPageLikeError(
        "SCHEMA_ERROR",
        `DOM 数据 Schema 校验失败: ${filePath} - 缺失字段: ${missingFields.join(", ")}`
      );
    }

    if (nonArrayFields.length > 0) {
      throw new FileBackedPageLikeError(
        "SCHEMA_ERROR",
        `DOM 数据 Schema 校验失败: ${filePath} - 非数组字段: ${nonArrayFields.join(", ")}`
      );
    }

    // 类型断言安全：已通过 Schema 校验
    return obj as unknown as DOMAuditData;
  }

  /**
   * 校验 ContrastSample[] Schema
   *
   * 校验规则：
   *   1. 必须是数组
   *   2. 每个元素必须包含所有 REQUIRED_CONTRAST_FIELDS 中定义的字段
   *
   * @param data 待校验的数据
   * @param filePath 文件路径（用于错误提示）
   * @param fieldDesc 字段描述（用于错误提示，如 "contrastSamples" 或 "根节点"）
   * @returns 校验通过的 ContrastSample 数组
   * @throws {FileBackedPageLikeError} Schema 校验失败
   */
  private static validateContrastSamples(data: unknown, filePath: string, fieldDesc: string): ContrastSample[] {
    if (!Array.isArray(data)) {
      throw new FileBackedPageLikeError(
        "SCHEMA_ERROR",
        `对比度采样 Schema 校验失败: ${filePath} - ${fieldDesc} 应为数组，实际为 ${typeof data}`
      );
    }

    // 逐条校验每个 ContrastSample 的字段完整性
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (typeof item !== "object" || item === null) {
        throw new FileBackedPageLikeError(
          "SCHEMA_ERROR",
          `对比度采样 Schema 校验失败: ${filePath} - 第 ${i + 1} 条记录应为对象，实际为 ${typeof item}`
        );
      }
      const obj = item as Record<string, unknown>;
      const missingFields = REQUIRED_CONTRAST_FIELDS.filter((field) => !(field in obj));
      if (missingFields.length > 0) {
        throw new FileBackedPageLikeError(
          "SCHEMA_ERROR",
          `对比度采样 Schema 校验失败: ${filePath} - 第 ${i + 1} 条记录缺失字段: ${missingFields.join(", ")}`
        );
      }
    }

    // 类型断言安全：已通过 Schema 校验
    return data as ContrastSample[];
  }

  // ==========================================================================
  // PageLike 接口实现
  // ==========================================================================

  /**
   * 返回 DOM 审计数据
   *
   * 实现 PageLike.evaluateDOM() 接口方法。
   * 数据在构造时已加载到内存，此处直接返回（无 I/O 开销）。
   *
   * @returns DOMAuditData 对象
   */
  async evaluateDOM(): Promise<DOMAuditData> {
    return this.domData;
  }

  /**
   * 返回对比度采样数组
   *
   * 实现 PageLike.evaluateContrast() 接口方法。
   * 数据在构造时已加载到内存，此处直接返回（无 I/O 开销）。
   *
   * @returns ContrastSample 数组
   */
  async evaluateContrast(): Promise<ContrastSample[]> {
    return this.contrastSamples;
  }
}

/**
 * 解析 domFile 路径为绝对路径
 *
 * 当 domFile 为相对路径时，基于 cwd 解析为绝对路径。
 * 用于错误提示与日志输出。
 *
 * @param domFile 用户提供的 domFile 路径
 * @returns 绝对路径
 */
export function resolveDomFilePath(domFile: string): string {
  if (path.isAbsolute(domFile)) {
    return domFile;
  }
  return path.resolve(process.cwd(), domFile);
}
