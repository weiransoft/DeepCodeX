/**
 * 对象存储模式判定器（OssPatternChecker）—— EAG-P3 批次 12 收尾补全
 *
 * 负责红线：
 * - TCS-OSS-02：签名 URL 过期时间 > 24h（signedUrl 调用 expirySeconds 参数 > 86400）
 * - TCS-OSS-03：文件类型/大小未校验直接上传（put 调用前无校验逻辑）
 *
 * 历史背景：
 * 本 Checker 在批次 9 设计 §4.5.4 静态判定器清单中应实现但遗漏，
 * 导致 DEFAULT_STATIC_CHECKERS 注册表缺少 TCS-OSS-02/03 映射，
 * StrictEvaluator 对这两条红线返回 unknown 状态，
 * 触发 decideVerdict 的 unknownBlockerOrMajor > 0 → human_checkpoint。
 * 批次 12 C2 端到端测试发现此 BUG，本文件为真实修复（非 mock、非简化）。
 *
 * 判定算法：
 * 1. TCS-OSS-02：
 *    a. 扫描 signedUrl / getSignedUrl / presignedUrl / generateSignedUrl 方法调用
 *    b. 提取调用参数中的 expirySeconds / expiresInSeconds / ttl / expiresIn 字段值
 *    c. 或匹配 signedUrl(key, <number>) 形式的第二位置数字参数
 *    d. 若数值 > 86400（24 小时）→ 违规
 *    e. 未找到 signedUrl 调用 → passed（合规：未使用签名 URL 不算违规）
 *    f. 找到 signedUrl 调用但未显式提供过期时间 → passed（保守策略：使用默认值不视为违规）
 *
 * 2. TCS-OSS-03：
 *    a. 扫描 objectStorage / oss / s3 / minio 等 receiver 上的 put / upload / uploadFile 方法调用
 *    b. 在 put 调用前 15 行内查找 validateFileExtension / validateFileSize / validateMimeType / validateFileType 调用
 *    c. 或在 put 调用参数中查找 allowedExtensions / maxSizeBytes / mimeTypeWhitelist / maxSize 字段
 *    d. 若无任何校验 → 违规
 *    e. 未找到 put 调用 → passed（合规：未使用对象存储上传不算违规）
 *
 * 设计依据：
 * - EAG 方案 §5.8.1 对象存储规范（统一抽象 + 签名 URL + 上传校验）
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 * - EAG-P3 批次 12 设计 §4.3.2 场景 2 CODING Loop E2E（暴露 BUG 的场景）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 常量使用 Object.freeze 冻结
 * - 返回的 RedlineResult 通过 checker-utils.buildViolations / buildPass 构建（内部冻结）
 *
 * @module eag/coding/static-checkers/oss-pattern-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, buildPass, extractFilePathFromComment, lineOf } from "./checker-utils";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * 签名 URL 方法名清单（识别 signedUrl 调用）
 *
 * 匹配以下方法调用：
 * - objectStorage.signedUrl / oss.signedUrl / s3.signedUrl
 * - this.objectStorage.signedUrl / this.oss.signedUrl
 * - client.getSignedUrl / client.presignedUrl / client.generateSignedUrl
 * - generateSignedUrl / createPresignedUrl（无 receiver 的顶层函数调用）
 */
const SIGNED_URL_METHODS: ReadonlyArray<string> = Object.freeze([
  "signedUrl",
  "getSignedUrl",
  "presignedUrl",
  "generateSignedUrl",
  "createPresignedUrl",
  "signUrl",
]);

/**
 * 签名 URL 过期时间参数名清单（识别 signedUrl 调用中的 expirySeconds 设置）
 *
 * objectStorage.signedUrl(key, { expirySeconds: 300 }) 中的 expirySeconds 字段
 * client.getSignedUrl(key, { expiresIn: 3600 }) 中的 expiresIn 字段
 */
const EXPIRY_PARAM_NAMES: ReadonlyArray<string> = Object.freeze([
  "expirySeconds",
  "expiresInSeconds",
  "expiresIn",
  "expiry",
  "ttl",
  "ttlSeconds",
  "expire",
  "expireSeconds",
]);

/**
 * 签名 URL 最大允许过期时间（24 小时 = 86400 秒）
 *
 * 对齐 tcs-redlines.ts 中 TCS-OSS-02 红线定义：
 * "签名 URL 的过期时间必须 ≤24 小时（86400 秒），禁止设置 >24h 的过期时间"
 */
const MAX_SIGNED_URL_EXPIRY_SECONDS = 86400 as const;

/**
 * 对象存储 receiver 名清单（识别 objectStorage / oss / s3 / minio 调用）
 *
 * 不区分大小写匹配，覆盖常见命名：
 * - objectStorage / ObjectStorage
 * - oss / OSS
 * - s3 / S3
 * - minio / MinIO
 * - storage / Storage
 * - bucket / Bucket
 */
const OSS_RECEIVER_PATTERNS: ReadonlyArray<string> = Object.freeze([
  "objectstorage",
  "oss",
  "s3",
  "minio",
  "storage",
  "bucket",
  "cos", // 腾讯云 COS
  "obs", // 华为云 OBS
]);

/**
 * 上传方法名清单（识别 put / upload 调用）
 *
 * 匹配以下方法调用：
 * - objectStorage.put / oss.put / s3.put
 * - objectStorage.upload / oss.upload
 * - objectStorage.uploadFile / objectStorage.uploadStream
 * - client.putObject / client.uploadFile
 */
const UPLOAD_METHODS: ReadonlyArray<string> = Object.freeze([
  "put",
  "putObject",
  "upload",
  "uploadFile",
  "uploadStream",
  "uploadBuffer",
  "uploadBytes",
]);

/**
 * 文件校验方法名清单（识别 validateFileExtension / validateFileSize 调用）
 *
 * 上传前的校验逻辑——检查文件扩展名白名单与文件大小上限。
 * 在 put 调用前 15 行内出现这些方法调用即视为合规。
 */
const FILE_VALIDATION_METHODS: ReadonlyArray<string> = Object.freeze([
  "validateFileExtension",
  "validateFileSize",
  "validateMimeType",
  "validateFileType",
  "validateFile",
  "checkFileExtension",
  "checkFileSize",
  "checkMimeType",
  "verifyFileType",
  "verifyFileSize",
]);

/**
 * 文件校验参数名清单（识别 put 调用 options 参数中的校验字段）
 *
 * objectStorage.put(content, key, { allowedExtensions: ["jpg", "png"], maxSizeBytes: 10485760 })
 * 中的 allowedExtensions / maxSizeBytes 字段——通过 PutOptions 委托适配器校验。
 */
const FILE_VALIDATION_PARAM_NAMES: ReadonlyArray<string> = Object.freeze([
  "allowedExtensions",
  "maxSizeBytes",
  "maxSize",
  "mimeTypeWhitelist",
  "allowedMimeTypes",
  "maxFileSize",
  "fileSizeLimit",
]);

/**
 * 向上回溯查找校验调用的最大行数
 *
 * put 调用前 15 行内出现 validateFileExtension / validateFileSize 调用即视为合规。
 * 15 行覆盖常见业务代码模式：
 *   const ext = path.extname(filename);
 *   validateFileExtension(ext, ["jpg", "png"]);
 *   validateFileSize(fileSize, 10 * 1024 * 1024);
 *   await objectStorage.put(content, key);
 */
const LOOKBACK_LINES_FOR_VALIDATION = 15 as const;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判定 receiver 是否为对象存储对象
 *
 * 不区分大小写匹配 OSS_RECEIVER_PATTERNS 中的命名。
 * 覆盖 objectStorage / oss / s3 / minio / storage / bucket / cos / obs 等常见命名。
 *
 * @param receiver 方法调用的接收者（如 "objectStorage" / "this.objectStorage" / "s3"）
 * @returns true 表示对象存储对象
 */
function isOssReceiver(receiver: string): boolean {
  // 处理 this.xxx 形式：取点号后的部分
  const normalized = receiver.includes(".") ? (receiver.split(".").pop() ?? "") : receiver;
  const lower = normalized.toLowerCase();
  return OSS_RECEIVER_PATTERNS.includes(lower);
}

/**
 * 从字符串中解析数字字面量
 *
 * 支持十进制与科学计数法，忽略前后空白。
 * 对齐 tcs-redlines.ts 中 TCS-OSS-02 红线定义的过期时间数值解析。
 *
 * @param value 待解析的字符串
 * @returns 解析后的数字；无法解析返回 null
 */
function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // 匹配整数或浮点数（含科学计数法）
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

/**
 * 从 signedUrl 调用参数中提取过期时间数值
 *
 * 解析策略（按优先级）：
 * 1. 命名参数：expirySeconds: <number> / expiresIn: <number> / ttl: <number>
 * 2. 位置参数：signedUrl(key, <number>) 形式的第二位置数字参数
 *
 * @param callArgs 调用参数原文（含函数名与括号）
 * @returns 过期时间秒数；未找到返回 null
 */
function extractExpirySeconds(callArgs: string): number | null {
  // 策略 1：命名参数匹配
  for (const paramName of EXPIRY_PARAM_NAMES) {
    // 匹配 paramName: <number> 或 paramName: <variable>（仅匹配数字字面量）
    const paramRe = new RegExp(`\\b${paramName}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`);
    const match = callArgs.match(paramRe);
    if (match) {
      const num = parseNumber(match[1]);
      if (num !== null) return num;
    }
  }

  // 策略 2：位置参数匹配
  // 匹配 signedUrl(key, <number>) 形式：第一参数后跟数字字面量
  // 提取所有顶层参数（简化处理：按逗号切分，忽略嵌套括号与字符串）
  const args = extractTopLevelArgs(callArgs);
  if (args.length >= 2) {
    const secondArg = args[1].trim();
    const num = parseNumber(secondArg);
    if (num !== null) return num;
  }

  return null;
}

/**
 * 从函数调用原文中提取顶层参数列表
 *
 * 算法：
 * 1. 找到第一个左括号
 * 2. 从左括号后开始，按逗号切分（忽略嵌套括号、字符串字面量、模板字符串）
 * 3. 遇到匹配的右括号结束
 *
 * 简化处理：不解析注释中的逗号（注释中的逗号会被错误切分，
 * 但实际签名 URL 调用参数中很少包含注释）。
 *
 * @param callExpr 函数调用原文（含函数名与括号，如 "signedUrl(key, 3600)"）
 * @returns 顶层参数列表（去除空白）
 */
function extractTopLevelArgs(callExpr: string): string[] {
  const openIdx = callExpr.indexOf("(");
  if (openIdx < 0) return [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  const args: string[] = [];
  let current = "";
  for (let i = openIdx + 1; i < callExpr.length; i++) {
    const ch = callExpr[i];
    if (ch === "(" && !inSingle && !inDouble && !inTemplate) {
      depth++;
      current += ch;
    } else if (ch === ")" && !inSingle && !inDouble && !inTemplate) {
      if (depth === 0) {
        if (current.trim().length > 0 || args.length > 0) {
          args.push(current);
        }
        break;
      }
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0 && !inSingle && !inDouble && !inTemplate) {
      args.push(current);
      current = "";
    } else if (ch === "'" && !inDouble && !inTemplate) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && !inTemplate) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "`" && !inSingle && !inDouble) {
      inTemplate = !inTemplate;
      current += ch;
    } else {
      current += ch;
    }
  }
  return args.map((a) => a.trim());
}

/**
 * 从 put 调用参数中检测是否含校验字段
 *
 * 检测策略：
 * 遍历 FILE_VALIDATION_PARAM_NAMES 中的字段名，
 * 若任一字段在调用参数中出现（field: 形式）即视为已校验。
 *
 * @param callArgs put 调用参数原文
 * @returns true 表示 put 调用参数中含校验字段
 */
function hasValidationInPutOptions(callArgs: string): boolean {
  for (const paramName of FILE_VALIDATION_PARAM_NAMES) {
    const paramRe = new RegExp(`\\b${paramName}\\s*:`);
    if (paramRe.test(callArgs)) {
      return true;
    }
  }
  return false;
}

/**
 * 在 put 调用前的代码行中查找校验方法调用
 *
 * 算法：
 * 1. 取 put 调用所在行号 line
 * 2. 向上回溯 LOOKBACK_LINES_FOR_VALIDATION 行（含当前行）
 * 3. 逐行扫描是否存在 FILE_VALIDATION_METHODS 中的方法调用
 * 4. 任一行匹配即视为已校验
 *
 * @param lines 完整代码行数组
 * @param putLine put 调用所在行号（1-based）
 * @returns true 表示 put 调用前存在校验调用
 */
function hasValidationBeforePut(lines: string[], putLine: number): boolean {
  const startLine = Math.max(0, putLine - LOOKBACK_LINES_FOR_VALIDATION);
  const endLine = putLine; // 含当前行
  for (let i = startLine; i < endLine; i++) {
    const line = lines[i] ?? "";
    // 跳过注释行
    if (/^\s*\/\//.test(line)) continue;
    if (/^\s*\*/.test(line)) continue;
    // 检测任一校验方法调用（含 this. 前缀与无前缀形式）
    for (const method of FILE_VALIDATION_METHODS) {
      const methodRe = new RegExp(`\\b${method}\\s*\\(`);
      if (methodRe.test(line)) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// OssPatternChecker 类
// ============================================================================

/**
 * 对象存储模式判定器
 *
 * 实现 StaticChecker 协议，负责 TCS-OSS-02 / TCS-OSS-03 红线的静态判定。
 *
 * 该 Checker 为无状态单例（无字段、无副作用），可安全共享。
 * 不可变优先：redlineIds 字段使用 Object.freeze 冻结。
 */
export class OssPatternChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表（运行期冻结） */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["TCS-OSS-02", "TCS-OSS-03"]);

  /**
   * 执行静态判定
   *
   * 算法（按 redline.id 路由）：
   * 1. TCS-OSS-02：扫描 signedUrl 调用，检查 expirySeconds 参数是否 > 86400
   * 2. TCS-OSS-03：扫描 put / upload 调用，检查调用前是否有文件校验逻辑
   *
   * 判定规则：
   * - 检测到违规模式 → status="violated"，附 violations 数组
   * - 未检测到违规模式 → status="passed"
   * - 未找到相关调用（无 signedUrl / put 调用）→ status="passed"（合规：未使用即不违规）
   *
   * @param artifacts 产出物列表（每个产出物含路径与内容）
   * @param redline 当前红线定义（评估器按 redlineIds 路由后传入）
   * @returns 判定结果（status="passed" / "violated"）
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    // 收集违规列表（不可变优先：使用 readonly 字段的对象数组）
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      // 提取文件路径：优先从首行注释提取，回退到 artifact.path
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const content = artifact.content;
      const lines = content.split(/\r?\n/);

      // 路由到对应红线的判定逻辑
      if (redline.id === "TCS-OSS-02") {
        this.checkSignedUrlExpiry(content, filePath, violations);
      } else if (redline.id === "TCS-OSS-03") {
        this.checkPutValidation(content, lines, filePath, violations);
      }
      // 其他 redline.id 不属于本 Checker 职责，不处理（由 StrictEvaluator 路由保证）
    }

    // 根据违规列表构建 RedlineResult
    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }

  /**
   * 检测 TCS-OSS-02：签名 URL 过期时间 > 24h
   *
   * 算法：
   * 1. 用正则扫描所有 SIGNED_URL_METHODS 中的方法调用
   * 2. 对每个调用提取参数原文（含括号）
   * 3. 调用 extractExpirySeconds 解析过期时间数值
   * 4. 若 > MAX_SIGNED_URL_EXPIRY_SECONDS（86400）→ 违规
   *
   * @param content 文件内容
   * @param filePath 文件路径
   * @param violations 违规列表（追加模式）
   */
  private checkSignedUrlExpiry(
    content: string,
    filePath: string,
    violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }>
  ): void {
    // 构造正则：匹配 receiver.method( 或 method( 形式
    // 分组 1：receiver（如 objectStorage / this.objectStorage / client，可能为空）
    // 分组 2：方法名（signedUrl / getSignedUrl 等）
    for (const method of SIGNED_URL_METHODS) {
      // 正则：可选 receiver + . + 方法名 + (
      // receiver 限制为 [a-zA-Z_\w.\[\]] 以匹配 this.objectStorage / this.props.storage 等
      const methodRe = new RegExp(`\\b([a-zA-Z_][\\w.\\[\\]]*)\\.${method}\\s*\\(|\\b${method}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = methodRe.exec(content)) !== null) {
        const callStart = m.index;
        const callLine = lineOf(content, callStart);

        // 提取调用参数原文（含函数名与括号）
        const openParenIdx = content.indexOf("(", callStart);
        if (openParenIdx < 0) continue;
        const closeParenIdx = this.findMatchingParen(content, openParenIdx);
        if (closeParenIdx < 0) continue;
        const callExpr = content.slice(callStart, closeParenIdx + 1);

        // 若有 receiver，检查是否为对象存储 receiver
        // 分组 1 为 receiver（含 this.xxx 形式），若为 undefined 表示无 receiver 的顶层函数调用
        const receiver = m[1];
        if (receiver !== undefined && !isOssReceiver(receiver)) {
          // receiver 不是对象存储对象（如 localStorage.signedUrl），跳过
          continue;
        }

        // 提取过期时间数值
        const expirySeconds = extractExpirySeconds(callExpr);
        if (expirySeconds === null) {
          // 未显式提供过期时间，保守策略：不视为违规（使用默认值）
          continue;
        }

        // 检查是否超过 24 小时
        if (expirySeconds > MAX_SIGNED_URL_EXPIRY_SECONDS) {
          violations.push({
            filePath,
            line: callLine,
            description:
              `签名 URL 调用 ${m[0].replace(/\s*\($/, "")}() 的过期时间 ${expirySeconds} 秒超过 24 小时（86400 秒）` +
              `——违反 TCS-OSS-02 红线。签名 URL 过期时间过长将导致 URL 泄漏后攻击者可长时间访问私有文件，` +
              `默认推荐 15 分钟（900 秒），最大允许 24 小时（86400 秒）`,
            fixSuggestion:
              "1. 将 expirySeconds 调整为 ≤ 86400（24 小时）\n" +
              "2. 推荐使用默认值 900（15 分钟）——敏感文件应使用更短的过期时间\n" +
              "3. 若业务确需长时间访问，改为后端代理下载（业务代码读对象存储后转发给客户端）\n" +
              "4. 监控签名 URL 的使用日志，发现异常访问立即吊销",
          });
        }
      }
    }
  }

  /**
   * 检测 TCS-OSS-03：文件类型/大小未校验直接上传
   *
   * 算法：
   * 1. 用正则扫描所有 UPLOAD_METHODS 中的方法调用（仅在 OSS receiver 上）
   * 2. 对每个调用：
   *    a. 在 put 调用前 LOOKBACK_LINES_FOR_VALIDATION 行内查找 FILE_VALIDATION_METHODS 调用
   *    b. 或在 put 调用参数中查找 FILE_VALIDATION_PARAM_NAMES 字段
   * 3. 若两者均无 → 违规
   *
   * @param content 文件内容
   * @param lines 文件内容按行切分
   * @param filePath 文件路径
   * @param violations 违规列表（追加模式）
   */
  private checkPutValidation(
    content: string,
    lines: string[],
    filePath: string,
    violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }>
  ): void {
    // 构造正则：匹配 receiver.method( 形式（要求必须有 receiver）
    // 分组 1：receiver（如 objectStorage / this.objectStorage / s3）
    // 分组 2：方法名（put / upload / uploadFile 等）
    for (const method of UPLOAD_METHODS) {
      // 正则：receiver + . + 方法名 + (
      // receiver 限制为 [a-zA-Z_\w.\[\]] 以匹配 this.objectStorage / this.props.storage 等
      const methodRe = new RegExp(`\\b([a-zA-Z_][\\w.\\[\\]]*)\\.${method}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = methodRe.exec(content)) !== null) {
        const receiver = m[1];
        const callStart = m.index;
        const callLine = lineOf(content, callStart);

        // 检查 receiver 是否为对象存储对象
        if (!isOssReceiver(receiver)) {
          // receiver 不是对象存储对象（如 this.props.put / state.upload），跳过
          continue;
        }

        // 提取调用参数原文（含括号）
        const openParenIdx = content.indexOf("(", callStart);
        if (openParenIdx < 0) continue;
        const closeParenIdx = this.findMatchingParen(content, openParenIdx);
        if (closeParenIdx < 0) continue;
        const callArgs = content.slice(openParenIdx, closeParenIdx + 1);

        // 检测 1：put 调用参数中是否含校验字段（allowedExtensions / maxSizeBytes 等）
        const hasValidationInOptions = hasValidationInPutOptions(callArgs);
        if (hasValidationInOptions) {
          // 已通过 PutOptions 委托适配器校验，合规
          continue;
        }

        // 检测 2：put 调用前 N 行内是否有校验方法调用
        // callLine 是 1-based，lines 数组是 0-based，故 callLine - 1 为 0-based 行号
        const hasValidationBefore = hasValidationBeforePut(lines, callLine);
        if (hasValidationBefore) {
          // 已在 put 调用前显式校验，合规
          continue;
        }

        // 两者均无 → 违规
        violations.push({
          filePath,
          line: callLine,
          description:
            `对象存储上传调用 ${receiver}.${method}() 前未检测到文件类型/大小校验逻辑` +
            `——违反 TCS-OSS-03 红线。未校验直接上传将导致：` +
            `(1) 恶意用户上传可执行文件（.exe / .sh）攻击其他用户；` +
            `(2) 上传超大文件耗尽存储空间与带宽；` +
            `(3) 上传伪装文件（扩展名 .jpg 但实际为 .exe）绕过类型限制`,
          fixSuggestion:
            "1. 在 put / upload 调用前添加显式校验逻辑：\n" +
            "   validateFileExtension(filename, ['jpg', 'png', 'pdf']) // 白名单校验\n" +
            "   validateFileSize(fileSize, 10 * 1024 * 1024) // 上限 10MB\n" +
            "2. 或通过 PutOptions 委托适配器校验：\n" +
            "   await objectStorage.put(content, key, {\n" +
            "     allowedExtensions: ['jpg', 'png'],\n" +
            "     maxSizeBytes: 10 * 1024 * 1024\n" +
            "   })\n" +
            "3. 添加单元测试覆盖校验逻辑（违规扩展名/超限大小应抛错）\n" +
            "4. 上传后再次校验文件签名（magic number）防止伪装文件",
        });
      }
    }
  }

  /**
   * 查找匹配的右括号位置
   *
   * 从左括号位置开始，匹配嵌套的括号对，返回对应的右括号位置。
   * 处理字符串字面量与模板字符串中的括号（简化处理：识别引号与反引号配对）。
   *
   * @param content 完整内容
   * @param openPos 左括号位置
   * @returns 右括号位置；未找到返回 -1
   */
  private findMatchingParen(content: string, openPos: number): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    for (let i = openPos; i < content.length; i++) {
      const ch = content[i];
      // 处理字符串字面量边界（简化处理：不解析转义字符）
      if (ch === "'" && !inDouble && !inTemplate) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && !inTemplate) {
        inDouble = !inDouble;
      } else if (ch === "`" && !inSingle && !inDouble) {
        inTemplate = !inTemplate;
      } else if (!inSingle && !inDouble && !inTemplate) {
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) return i;
        }
      }
    }
    return -1;
  }
}
