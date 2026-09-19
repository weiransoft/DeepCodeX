/**
 * multipart/form-data 流式解析器（docs/dev/web-ui.md §3.2 multipart.ts）。
 *
 * 使用 Node 原生流手写实现（不引入 busboy 等外部依赖）：
 * - 按 boundary 分段解析，支持多个 file part 与普通 field part；
 * - 文件边接收边落盘（FileHandle.write），内存占用与单 chunk/边界尾巴成正比，不整读缓存；
 * - 单文件超过 maxUploadBytes 立即中断（抛 MultipartError("PAYLOAD_TOO_LARGE")，映射 HTTP 413）；
 * - 请求体总量（含协议开销的全部字节）超过 maxTotalBytes 立即中断（同样 413），
 *   防止"多个小文件合计超限"绕过单文件上限，默认 maxTotalBytes = maxUploadBytes × 2；
 * - 文件名取 basename 防路径穿越，实际落盘名 = Date.now()-随机hex-安全化原名。
 *
 * 协议要点（RFC 7578 / RFC 2046）：
 * - 分隔符："--" + boundary；结束符："--" + boundary + "--"；
 * - part 内部：headers（CRLF 结束）+ CRLF + body + CRLF + 分隔符；
 * - body 边界扫描需保留可能是分隔符前缀的尾部字节，等待后续 chunk 补齐判断。
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

/** multipart 解析错误码（映射 HTTP 状态码） */
export type MultipartErrorCode =
  | "NOT_MULTIPART" // Content-Type 不是 multipart/form-data → 400
  | "INVALID_MULTIPART" // 协议格式非法/中断 → 400
  | "PAYLOAD_TOO_LARGE" // 单文件超限 → 413
  | "FIELD_TOO_LARGE"; // 普通 field 超限 → 413

/**
 * multipart 解析类型化错误。
 *
 * code 供上层映射 HTTP 状态码；message 为中文说明。
 */
export class MultipartError extends Error {
  readonly code: MultipartErrorCode;

  /**
   * @param code 错误码
   * @param message 中文错误说明
   */
  constructor(code: MultipartErrorCode, message: string) {
    super(message);
    this.name = "MultipartError";
    this.code = code;
  }
}

/** 单个上传文件解析结果 */
export type MultipartFile = {
  /** part 的 name 属性（表单字段名） */
  fieldName: string;
  /** 客户端原始文件名（仅 basename，已去控制字符） */
  originalName: string;
  /** 服务端实际落盘绝对路径（随机名，防冲突/防穿越） */
  savedPath: string;
  /** 文件字节数 */
  size: number;
  /** part 的 Content-Type（可选） */
  mimeType?: string;
};

/** multipart 解析完整结果 */
export type MultipartResult = {
  /** 普通 field part（name → 值；同名字段以最后一次为准） */
  fields: Record<string, string>;
  /** 文件 part 列表（按出现顺序） */
  files: MultipartFile[];
};

/** 解析选项 */
export type MultipartParseOptions = {
  /** 落盘根目录（聊天附件为 uploadDir；目录上传为 jail 内目标目录） */
  uploadDir: string;
  /** 单文件字节上限（超出即 413 中断） */
  maxUploadBytes: number;
  /**
   * 请求体总量字节上限（含 boundary/headers 等协议开销的全部接收字节，超出即 413 中断）。
   * 防止「多个不超过单文件上限的小文件合计超限」绕过总量约束；
   * 缺省时取 maxUploadBytes × 2。
   */
  maxTotalBytes?: number;
  /** 普通 field 值字节上限（默认 1MB） */
  fieldLimitBytes?: number;
};

/** body 边界匹配保留尾巴的最大长度："\r\n--boundary" 是文件名外的最长前缀候选 */
const CRLF = Buffer.from("\r\n");

/**
 * 从 Content-Type 头提取 boundary 参数。
 *
 * 支持 boundary="xxx"（带引号）与 boundary=xxx（裸 token）两种形式。
 *
 * @param contentType Content-Type 头原值
 * @returns boundary 字符串；非 multipart 或缺 boundary 返回 null
 */
export function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    return null;
  }
  const match = /boundary=(?:"([^"]+)"|([^;,]+))/i.exec(contentType);
  if (!match) {
    return null;
  }
  const boundary = (match[1] ?? match[2] ?? "").trim();
  return boundary === "" ? null : boundary;
}

/**
 * 安全化客户端文件名：取 basename（兼容 / 与 \ 分隔）并去除控制字符。
 *
 * 防路径穿越（CWE-22）：结果绝不含路径分隔符，"." / ".." / 空名兜底为 "file"。
 *
 * @param rawName 客户端提供的原始文件名
 * @returns 安全化后的文件名
 */
export function sanitizeFileName(rawName: string): string {
  // 统一按 "/" 分隔取末段（Windows 反斜杠先归一），实现等价 basename
  const base = rawName.replaceAll("\\", "/").split("/").pop() ?? "";
  // 去除控制字符与 DEL，防终端/文件系统异常
  const cleaned = base.replaceAll(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "file";
  }
  return cleaned;
}

/**
 * 生成服务端落盘文件名：Date.now()-随机hex-安全化原名。
 *
 * 随机段取 16 hex 字符，"wx" 独占创建标志兜底防冲突。
 *
 * @param originalName 客户端原始文件名
 * @returns 唯一化的落盘文件名（仅文件名，不含目录）
 */
export function buildSavedFileName(originalName: string): string {
  return `${Date.now()}-${randomBytes(8).toString("hex")}-${sanitizeFileName(originalName)}`;
}

/**
 * 解析 Content-Disposition 头中的 name / filename 参数。
 *
 * 支持 name="value" 与 name=value（裸 token）两种形式；filename 出现（即使空串）
 * 即标记该 part 为文件。
 *
 * @param disposition Content-Disposition 头原值
 * @returns { name, filename? }；无法解析 name 时返回 null
 */
function parseContentDisposition(disposition: string): { name: string; filename?: string } | null {
  if (!/^\s*form-data\b/i.test(disposition)) {
    return null;
  }
  const nameMatch = /\bname="((?:[^"\\]|\\.)*)"/i.exec(disposition) ?? /\bname=([^;\s]+)/i.exec(disposition);
  if (!nameMatch) {
    return null;
  }
  const name = (nameMatch[1] ?? "").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  // filename 存在性即决定 file part；用正则先判存在再取值
  const hasFilename = /\bfilename=/i.test(disposition);
  const filenameMatch =
    /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(disposition) ?? /\bfilename=([^;\s]+)/i.exec(disposition);
  const filename = hasFilename
    ? filenameMatch
      ? (filenameMatch[1] ?? "").replaceAll('\\"', '"').replaceAll("\\\\", "\\")
      : ""
    : undefined;
  return { name, filename };
}

/**
 * part 数据汇目标：文件写盘或字段累积。
 */
type PartSink =
  | {
      kind: "field";
      name: string;
      chunks: Buffer[];
      size: number;
      limitBytes: number;
    }
  | {
      kind: "file";
      fieldName: string;
      originalName: string;
      mimeType?: string;
      savedPath: string;
      handle: FileHandle;
      size: number;
      limitBytes: number;
    };

/**
 * multipart 状态机解析器。
 *
 * 状态流转：preamble（找首个 --boundary）→ boundaryAfter（boundary 之后的
 * 终结符判定：`--` 结束 / CRLF 进 headers）→ headers（CRLFCRLF 结束）→
 * body（扫描 \r\n--boundary）→ boundaryAfter（下一 part 或结束）… → done。
 *
 * boundaryAfter 独立成态的原因：boundary 消费后的终结符（"--" 或 CRLF）可能被
 * chunk 边界切开，必须以独立状态等待补齐，而不是回退到 preamble/body 重新搜索
 * （回退会把已消费 boundary 之后的字节误当作杂散字节丢弃或误当作 body 内容）。
 */
class MultipartParser {
  /** "preamble" | "boundaryAfter" | "headers" | "body" | "done" */
  private state: "preamble" | "boundaryAfter" | "headers" | "body" | "done" = "preamble";
  /** 待处理字节缓冲 */
  private buffer: Buffer = Buffer.alloc(0);
  /** 起始分隔符 "--boundary" */
  private readonly dashBoundary: Buffer;
  /** body 内部边界 "\r\n--boundary" */
  private readonly bodyDelimiter: Buffer;
  /** 当前 part 的头缓冲（headers 状态） */
  private headerBuf: Buffer = Buffer.alloc(0);
  /** 当前 part 的数据汇目标（body 状态） */
  private sink: PartSink | null = null;
  /** 解析产出 */
  private readonly result: MultipartResult = { fields: {}, files: [] };
  /** 已接收的请求体总字节数（含 boundary/headers 等协议开销，总量上限检查依据） */
  private totalBytes = 0;
  /** 请求体总量上限（构造时由 options 归一：缺省取 maxUploadBytes × 2） */
  private readonly totalLimitBytes: number;

  /**
   * @param boundary 从 Content-Type 提取的 boundary
   * @param options 解析选项（uploadDir/maxUploadBytes/maxTotalBytes/fieldLimitBytes）
   */
  constructor(
    boundary: string,
    private readonly options: MultipartParseOptions
  ) {
    this.dashBoundary = Buffer.from(`--${boundary}`);
    this.bodyDelimiter = Buffer.from(`\r\n--${boundary}`);
    // 总量上限归一：显式配置优先；缺省时按 maxUploadBytes × 2 兜底
    // （协议开销 + 多文件合计场景的经验系数，既宽松于单文件上限又不至于无界）
    this.totalLimitBytes = this.options.maxTotalBytes ?? this.options.maxUploadBytes * 2;
  }

  /**
   * 追加一段字节并推进状态机（可能同步完成多个 part 的处理）。
   *
   * @param chunk 新到的字节
   * @throws MultipartError 协议错误或超限
   */
  async push(chunk: Buffer): Promise<void> {
    // 总量上限检查必须在任何状态推进前执行：累计的是请求体全部原始字节
    // （含 boundary/headers 协议开销），一旦超限立即中断，后续字节不再消费
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.totalLimitBytes) {
      throw new MultipartError("PAYLOAD_TOO_LARGE", `请求体总量超过上限（${this.totalLimitBytes} 字节）`);
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // 循环推进直到缓冲不再触发状态迁移（等待更多数据）
    for (;;) {
      if (this.state === "preamble") {
        const index = this.buffer.indexOf(this.dashBoundary);
        if (index < 0) {
          // preamble 阶段的杂散字节（RFC 允许）直接丢弃，仅保留可能是分隔符前缀的尾巴
          const retain = Math.min(this.buffer.length, this.dashBoundary.length - 1);
          this.buffer = this.buffer.subarray(this.buffer.length - retain);
          return;
        }
        // 消费掉起始分隔符，进入 boundaryAfter 状态判断终结符
        // （终结符可能被 chunk 边界切开，独立状态可跨 push 等待补齐）
        this.buffer = this.buffer.subarray(index + this.dashBoundary.length);
        this.state = "boundaryAfter";
        continue;
      }

      if (this.state === "boundaryAfter") {
        // boundary 之后的终结符判定：仅检查前 2 字节，不足则等待下一个 chunk
        if (this.buffer.length < 2) {
          return;
        }
        const terminator = this.buffer.subarray(0, 2);
        if (terminator.toString("latin1") === "--") {
          // "--boundary--"：整个 multipart 结束
          this.buffer = this.buffer.subarray(2);
          this.state = "done";
          continue;
        }
        if (terminator.equals(CRLF)) {
          // "--boundary\r\n"：进入下一个 part 的头解析
          this.buffer = this.buffer.subarray(2);
          this.state = "headers";
          this.headerBuf = Buffer.alloc(0);
          continue;
        }
        throw new MultipartError("INVALID_MULTIPART", "multipart 格式非法：boundary 后缺少 CRLF 或结束符");
      }

      if (this.state === "headers") {
        // 头部搜索必须基于 headerBuf+buffer 的拼接视图：终结符 "\r\n\r\n" 本身
        // 可能被 chunk 边界切开（前半落在 headerBuf 尾部、后半落在 buffer 头部），
        // 只搜 buffer 会漏判终结符并把 body 首字节误收进 headerBuf
        const combined = Buffer.concat([this.headerBuf, this.buffer]);
        const end = combined.indexOf("\r\n\r\n");
        if (end < 0) {
          this.headerBuf = combined;
          // 头部超限保护（正常头远小于该值）：64KB
          if (this.headerBuf.length > 64 * 1024) {
            throw new MultipartError("INVALID_MULTIPART", "multipart 格式非法：part 头部过大");
          }
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.headerBuf = combined.subarray(0, end);
        this.buffer = combined.subarray(end + 4);
        this.openSinkFromHeaders();
        this.state = "body";
        continue;
      }

      if (this.state === "body") {
        const delimiterIndex = this.buffer.indexOf(this.bodyDelimiter);
        if (delimiterIndex >= 0) {
          // 找到 part 边界：写入 body 后消费分隔符，进入 boundaryAfter 判断终结符
          // （终结符可能被 chunk 边界切开，不能在这里内联判定，否则缓冲不足时
          //   回退到 body 分支会把残余的 "--\r\n" 误当 body 内容）
          await this.writeBody(this.buffer.subarray(0, delimiterIndex));
          this.buffer = this.buffer.subarray(delimiterIndex + this.bodyDelimiter.length);
          await this.closeSink();
          this.state = "boundaryAfter";
          continue;
        }
        // 未找到完整边界：保留可能是边界前缀的尾巴，其余写出
        const retain = this.matchingSuffixLength(this.buffer, this.bodyDelimiter);
        const flushLength = this.buffer.length - retain;
        if (flushLength > 0) {
          await this.writeBody(this.buffer.subarray(0, flushLength));
          this.buffer = this.buffer.subarray(flushLength);
        }
        return;
      }

      // done 状态：丢弃结尾杂散字节
      this.buffer = Buffer.alloc(0);
      return;
    }
  }

  /**
   * 流结束时收尾：校验状态机到达 done，关闭 field 汇目标。
   *
   * @throws MultipartError INVALID_MULTIPART 当流中断/格式不完整
   */
  async finish(): Promise<void> {
    if (this.state !== "done") {
      throw new MultipartError("INVALID_MULTIPART", "multipart 格式非法：数据流不完整");
    }
    // field part 在 closeSink 时已入 result，此处仅防御性兜底
    if (this.sink && this.sink.kind === "field") {
      this.finalizeField(this.sink);
      this.sink = null;
    }
  }

  /**
   * 取解析结果（finish 成功后调用）。
   *
   * @returns fields 与 files
   */
  getResult(): MultipartResult {
    return this.result;
  }

  /**
   * 计算缓冲尾部与边界前缀的最长匹配长度（用于安全保留尾巴）。
   *
   * @param buffer 当前缓冲
   * @param delimiter body 边界 "\r\n--boundary"
   * @returns 需保留的尾部长度（0 表示可全部写出）
   */
  private matchingSuffixLength(buffer: Buffer, delimiter: Buffer): number {
    const maxRetain = Math.min(buffer.length, delimiter.length - 1);
    for (let k = maxRetain; k > 0; k -= 1) {
      if (buffer.subarray(buffer.length - k).equals(delimiter.subarray(0, k))) {
        return k;
      }
    }
    return 0;
  }

  /**
   * 依据已收集的 part 头创建数据汇目标（file 落盘 / field 累积）。
   *
   * @throws MultipartError 头部缺 Content-Disposition / name，或文件创建失败
   */
  private openSinkFromHeaders(): void {
    const headerText = this.headerBuf.toString("utf8");
    const lines = headerText.split("\r\n");
    let disposition: string | null = null;
    let mimeType: string | undefined;
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0) {
        continue;
      }
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === "content-disposition") {
        disposition = value;
      } else if (key === "content-type") {
        mimeType = value;
      }
    }
    if (disposition === null) {
      throw new MultipartError("INVALID_MULTIPART", "multipart 格式非法：part 缺少 Content-Disposition 头");
    }
    const parsed = parseContentDisposition(disposition);
    if (!parsed || parsed.name === "") {
      throw new MultipartError("INVALID_MULTIPART", "multipart 格式非法：Content-Disposition 缺少 name 参数");
    }

    if (parsed.filename !== undefined) {
      // 文件 part：随机名落盘（basename 防穿越 + wx 独占创建防冲突）
      const savedName = buildSavedFileName(parsed.filename);
      const savedPath = path.join(this.options.uploadDir, savedName);
      mkdirSync(this.options.uploadDir, { recursive: true });
      try {
        const handlePromise = open(savedPath, "wx", 0o600);
        // open 是异步的，这里转为同步语义：缓存 promise，在写入前等待；
        // open 失败时包装为类型化错误（保持错误映射语义一致）
        const sink: PartSink = {
          kind: "file",
          fieldName: parsed.name,
          originalName: sanitizeFileName(parsed.filename),
          mimeType,
          savedPath,
          // 占位 handle，pendingFileOpen 完成后赋值
          handle: null as unknown as FileHandle,
          size: 0,
          limitBytes: this.options.maxUploadBytes,
        };
        this.sink = sink;
        this.pendingFileOpen = handlePromise
          .then(async (handle) => {
            if (sink.kind !== "file") {
              return;
            }
            sink.handle = handle;
            this.fileHandles.add(handle);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new MultipartError("INVALID_MULTIPART", `创建上传文件失败：${message}`);
          });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MultipartError("INVALID_MULTIPART", `创建上传文件失败：${message}`);
      }
    }

    // 普通 field part：内存累积（有上限）
    this.sink = {
      kind: "field",
      name: parsed.name,
      chunks: [],
      size: 0,
      limitBytes: this.options.fieldLimitBytes ?? 1024 * 1024,
    };
  }

  /** 等待中的文件句柄 open promise（保证写入顺序） */
  private pendingFileOpen: Promise<void> = Promise.resolve();
  /** 已打开未关闭的文件句柄集合（错误清理用） */
  private readonly fileHandles = new Set<FileHandle>();

  /**
   * 向当前 part 写入一段 body 字节（文件落盘 / 字段累积，并执行限额检查）。
   *
   * @param data body 片段
   * @throws MultipartError PAYLOAD_TOO_LARGE / FIELD_TOO_LARGE 超限时
   */
  private async writeBody(data: Buffer): Promise<void> {
    if (data.length === 0 || !this.sink) {
      return;
    }
    // 等待文件句柄就绪（open 完成前不会有 body 字节跨过 headers 状态）
    await this.pendingFileOpen;
    if (this.sink.kind === "file") {
      const nextSize = this.sink.size + data.length;
      if (nextSize > this.sink.limitBytes) {
        throw new MultipartError("PAYLOAD_TOO_LARGE", `上传文件超过大小上限（${this.sink.limitBytes} 字节）`);
      }
      await this.sink.handle.write(data);
      this.sink.size = nextSize;
      return;
    }
    const nextSize = this.sink.size + data.length;
    if (nextSize > this.sink.limitBytes) {
      throw new MultipartError("FIELD_TOO_LARGE", `表单字段超过大小上限（${this.sink.limitBytes} 字节）`);
    }
    this.sink.chunks.push(data);
    this.sink.size = nextSize;
  }

  /**
   * 关闭当前 part：文件写句柄并登记结果；字段拼接为字符串并登记结果。
   */
  private async closeSink(): Promise<void> {
    if (!this.sink) {
      return;
    }
    await this.pendingFileOpen;
    if (this.sink.kind === "file") {
      this.fileHandles.delete(this.sink.handle);
      await this.sink.handle.close();
      this.result.files.push({
        fieldName: this.sink.fieldName,
        originalName: this.sink.originalName,
        savedPath: this.sink.savedPath,
        size: this.sink.size,
        mimeType: this.sink.mimeType,
      });
    } else {
      this.finalizeField(this.sink);
    }
    this.sink = null;
  }

  /**
   * 将字段汇目标拼接为 UTF-8 字符串写入结果。
   *
   * @param sink 字段汇目标
   */
  private finalizeField(sink: Extract<PartSink, { kind: "field" }>): void {
    this.result.fields[sink.name] = Buffer.concat(sink.chunks).toString("utf8");
  }

  /**
   * 错误路径清理：关闭并尽力删除已创建的半成品文件。
   */
  async cleanup(): Promise<void> {
    try {
      await this.pendingFileOpen;
    } catch {
      // open 本身失败时无需清理句柄
    }
    for (const handle of this.fileHandles) {
      try {
        await handle.close();
      } catch {
        // 尽力而为
      }
    }
    this.fileHandles.clear();
    for (const file of this.result.files) {
      try {
        await unlink(file.savedPath);
      } catch {
        // 尽力而为
      }
    }
    // 尚未登记但已打开的文件：根据 sink 补删
    if (this.sink && this.sink.kind === "file") {
      try {
        await unlink(this.sink.savedPath);
      } catch {
        // 尽力而为
      }
    }
  }
}

/**
 * 解析 multipart/form-data 请求（流式，边收边落盘）。
 *
 * @param req Node 请求对象（POST，Content-Type: multipart/form-data）
 * @param options 解析选项（uploadDir/maxUploadBytes/maxTotalBytes/fieldLimitBytes）
 * @returns fields 与 files（files 已落盘，含 savedPath/size）
 * @throws MultipartError NOT_MULTIPART（400）/ INVALID_MULTIPART（400）/
 *         PAYLOAD_TOO_LARGE（单文件或请求体总量超限，413）或 FIELD_TOO_LARGE（413）；
 *         失败时半成品文件已清理
 */
export async function parseMultipartRequest(
  req: IncomingMessage,
  options: MultipartParseOptions
): Promise<MultipartResult> {
  const boundary = extractBoundary(req.headers["content-type"]);
  if (!boundary) {
    throw new MultipartError("NOT_MULTIPART", "Content-Type 必须为 multipart/form-data 且携带 boundary");
  }
  const parser = new MultipartParser(boundary, options);
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      await parser.push(buffer);
    }
    await parser.finish();
    return parser.getResult();
  } catch (error) {
    // 失败路径：销毁连接 + 清理半成品文件，再向外抛出（保持原错误类型）
    req.destroy();
    await parser.cleanup();
    throw error;
  }
}

/**
 * 计算 multipart 起始分隔符字节（测试辅助：保证测试与实现使用同一协议常量）。
 *
 * @param boundary boundary 字符串
 * @returns "--boundary" 的 Buffer 形式
 */
export function dashBoundaryOf(boundary: string): Buffer {
  return Buffer.from(`--${boundary}`);
}

/**
 * 计算 multipart body 内部边界字节（测试辅助）。
 *
 * @param boundary boundary 字符串
 * @returns "\r\n--boundary" 的 Buffer 形式
 */
export function bodyDelimiterOf(boundary: string): Buffer {
  return Buffer.from(`\r\n--${boundary}`);
}
