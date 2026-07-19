/**
 * 幂等性判定器（IdempotencyChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - E2：幂等性（写接口必须具备幂等性——幂等键参数或去重表）
 *
 * 判定算法：
 * 1. API 端点扫描：在 controller / handler 文件中查找 HTTP 写方法（POST/PUT/PATCH/DELETE），
 *    检查是否声明 `Client-Request-Id` / `Idempotency-Key` / `X-Idempotency-Key` 参数或请求头
 * 2. 事件处理器扫描：在 event-handler 文件中查找 `@EventHandler` / `handle(event)` 方法，
 *    检查是否使用去重表（`dedup` / `idempotency` / `processedEvents` / `SETNX` 模式）
 *
 * 设计依据：
 * - EAG 方案 §5.1.3 企业红线清单 E2
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/idempotency-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, extractFilePathFromComment } from "./checker-utils";

/**
 * 幂等键参数名清单（识别幂等性声明）
 *
 * 任一名称出现在 API 端点的参数列表或请求头中即视为已声明幂等键。
 */
const IDEMPOTENCY_KEY_NAMES: ReadonlyArray<string> = Object.freeze([
  "Idempotency-Key",
  "idempotency-key",
  "idempotencyKey",
  "Client-Request-Id",
  "client-request-id",
  "clientRequestId",
  "X-Idempotency-Key",
  "request-id",
  "requestId",
  "idempotentId",
]);

/**
 * 去重表模式正则清单（识别幂等去重保护）
 *
 * 任一模式出现在事件处理器中即视为已使用去重保护。
 */
const DEDUP_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bdedup[A-Z][A-Za-z]*/g, // dedupTable, dedupStore
  /\bidempotenc(?:y|ies)[A-Za-z]*/gi, // idempotencyKey, idempotencyStore
  /\bprocessed(?:Events|Messages|Requests)/g, // processedEvents 表
  /\bSETNX\b/g, // Redis SETNX 原子操作
  /\bsetIfAbsent\b/g, // Redis setIfAbsent（Spring 风格）
  /\bsetnx\b/gi, // Redis setnx 命令
  /\bON CONFLICT\s+DO\s+NOTHING/gi, // PostgreSQL 幂等插入
  /\bINSERT\s+IGNORE\b/gi, // MySQL 幂等插入
]);

/**
 * 判定方法签名中是否声明了幂等键参数
 *
 * 检查参数列表原文中是否包含任一幂等键名称。
 *
 * @param params 方法参数列表原文
 * @returns true 表示已声明幂等键
 */
function hasIdempotencyKeyInParams(params: string): boolean {
  return IDEMPOTENCY_KEY_NAMES.some((name) => params.includes(name));
}

/**
 * 判定文件内容中是否使用了去重表模式
 *
 * @param content 文件内容
 * @returns true 表示已使用去重保护
 */
function hasDedupPattern(content: string): boolean {
  return DEDUP_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(content);
  });
}

/**
 * 判定文件是否为 REST Controller / HTTP Handler
 *
 * 启发式：文件路径包含 controller / handler / route / endpoint 关键字。
 *
 * @param filePath 文件路径
 * @returns true 表示 HTTP 端点文件
 */
function isHttpEndpointFile(filePath: string): boolean {
  return /(^|\/)(controller|controllers|handler|handlers|routes?|endpoints?)\//.test(filePath);
}

/**
 * 判定文件是否为事件处理器
 *
 * 启发式：文件路径包含 event-handler / events / consumer / subscriber 关键字，
 * 或文件内容含 @EventHandler / @Consumer / @Subscriber 装饰器。
 *
 * @param filePath 文件路径
 * @param content 文件内容
 * @returns true 表示事件处理器文件
 */
function isEventHandlerFile(filePath: string, content: string): boolean {
  if (/(^|\/)(event-handler|event-handlers|events|consumers?|subscribers?)\//.test(filePath)) {
    return true;
  }
  return /@(EventHandler|Consumer|Subscriber|EventListener|RabbitListener|KafkaListener)\b/.test(content);
}

/**
 * 幂等性判定器
 *
 * 实现 StaticChecker 协议，负责 E2 红线的静态判定。
 */
export class IdempotencyChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["E2"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 遍历所有 artifacts
   * 2. 对 HTTP 端点文件：扫描 @Post/@Put/@Patch/@Delete 装饰器所附着的方法，
   *    检查方法参数列表或方法体中是否声明幂等键
   * 3. 对事件处理器文件：检查文件内容是否使用去重表模式
   * 4. 收集违规点（写方法 / 事件处理器无幂等保护）
   *
   * @param artifacts 产出物列表
   * @param redline 当前红线定义
   * @returns 判定结果
   */
  check(
    artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
    redline: Readonly<RedlineDefinition>
  ): RedlineResult {
    const violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }> = [];

    for (const artifact of artifacts) {
      const filePath = extractFilePathFromComment(artifact.content) || artifact.path;
      const content = artifact.content;

      // 检查 HTTP 端点文件
      if (isHttpEndpointFile(filePath)) {
        this.checkHttpEndpoints(content, filePath, violations);
      }

      // 检查事件处理器文件
      if (isEventHandlerFile(filePath, content)) {
        if (!hasDedupPattern(content)) {
          // 事件处理器无去重保护
          violations.push({
            filePath,
            line: 1,
            description:
              "事件处理器未使用幂等去重保护——违反 E2 红线。重复消费消息时会产生重复写入，" +
              "应通过去重表（processedEvents）/ Redis SETNX / 数据库幂等插入保护",
            fixSuggestion:
              "1. 在事件处理器入口处检查幂等键是否已处理（去重表 / Redis SETNX）\n" +
              "2. 已处理则直接返回缓存结果，未处理则执行业务并记录键\n" +
              "3. 使用 INSERT IGNORE / ON CONFLICT DO NOTHING 实现数据库层幂等\n" +
              "4. 幂等键建议使用 event.id + event.occurredAt 的组合",
          });
        }
      }
    }

    return buildViolations(redline.id, violations);
  }

  /**
   * 检查 HTTP 端点文件的写方法幂等键
   *
   * @param content 文件内容
   * @param filePath 文件路径
   * @param violations 违规列表（输出参数，函数内 push）
   */
  private checkHttpEndpoints(
    content: string,
    filePath: string,
    violations: Array<{
      readonly filePath: string;
      readonly line: number;
      readonly description: string;
      readonly fixSuggestion: string;
    }>
  ): void {
    const lines = content.split(/\r?\n/);

    // 扫描写方法装饰器行
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过注释行
      if (/^\s*\/\//.test(line)) continue;
      if (/^\s*\*/.test(line)) continue;

      // 匹配写方法装饰器：@Post(...) / @Put(...) / @Patch(...) / @Delete(...)
      const decoratorMatch = line.match(/^\s*(@(?:Post|Put|Patch|Delete))\s*(\([^)]*\))?/);
      if (!decoratorMatch) continue;

      // 找到写方法装饰器后，向下查找方法签名（跳过其他装饰器行）
      let methodLineIdx = i + 1;
      while (methodLineIdx < lines.length) {
        const nextLine = lines[methodLineIdx];
        if (/^\s*\/\//.test(nextLine) || /^\s*\*/.test(nextLine)) {
          methodLineIdx++;
          continue;
        }
        // 跳过其他装饰器行
        if (/^\s*@/.test(nextLine)) {
          methodLineIdx++;
          continue;
        }
        break;
      }
      if (methodLineIdx >= lines.length) break;

      // 提取方法签名
      const methodLine = lines[methodLineIdx] ?? "";
      const methodMatch = methodLine.match(
        /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:async\s+)?([A-Za-z_][\w]*)\s*(\([^)]*\))/
      );
      if (!methodMatch) continue;

      const params = methodMatch[2];
      // 检查参数列表中是否声明幂等键
      if (hasIdempotencyKeyInParams(params)) {
        continue;
      }

      // 检查方法体或文件中是否使用幂等键（更宽松的检查）
      // 启发式：扫描从方法装饰器到下一个装饰器之间的代码段
      let methodBodyEnd = methodLineIdx + 1;
      while (methodBodyEnd < lines.length) {
        const nextLine = lines[methodBodyEnd];
        if (/^\s*@(?:Post|Put|Patch|Delete|Get)\b/.test(nextLine)) break;
        if (
          /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?[A-Za-z_][\w]*\s*\(/.test(nextLine) &&
          methodBodyEnd > methodLineIdx + 1
        ) {
          break;
        }
        methodBodyEnd++;
      }
      const methodBody = lines.slice(methodLineIdx, methodBodyEnd).join("\n");

      if (hasIdempotencyKeyInParams(methodBody) || hasDedupPattern(methodBody)) {
        continue;
      }

      // 找到违规
      violations.push({
        filePath,
        line: i + 1,
        description:
          `HTTP 写方法 ${decoratorMatch[1]} ${methodMatch[1]}${params} 未声明幂等键参数 ` +
          `（Idempotency-Key / Client-Request-Id）——违反 E2 红线。` +
          `网络重试时将产生重复写入（重复扣款/重复下单等）`,
        fixSuggestion:
          "1. 在方法参数列表添加 @Headers('Idempotency-Key') idempotencyKey: string\n" +
          "2. 在方法体入口处检查幂等键是否已处理（去重表 / Redis SETNX）\n" +
          "3. 已处理则返回缓存结果，未处理则执行业务并记录键\n" +
          "4. 对于状态机类操作，确保状态转换是单调的（A→B 不可逆）",
      });
    }
  }
}
