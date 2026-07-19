/**
 * 缓存模式判定器（CachePatternChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - TCS-CACHE-01：缓存无 TTL（cache.set 调用未提供 ttlSeconds 或 ≤ 0）
 * - TCS-CACHE-02：缓存与 DB 双写顺序错误（先删缓存后写 DB / 先写 DB 后删缓存等违反一致性模式）
 * - TCS-CACHE-03：缓存未防穿透（未缓存空值且未做布隆过滤器）
 *
 * 判定算法：
 * 1. 扫描 cache.set / cacheSet / redis.set / redisClient.set 等缓存写入调用
 * 2. TCS-CACHE-01：检查 set 调用的参数中是否包含 ttlSeconds / ttl / expire 等字段
 * 3. TCS-CACHE-02：扫描 cache.delete + repository.save / db.update 的双写顺序
 * 4. TCS-CACHE-03：扫描 cache.get 后的 null 检查逻辑——若未在 miss 后缓存空值 → 违规
 *
 * 判定规则：
 * - cache.set 调用未显式提供 TTL 参数 → 违反 TCS-CACHE-01
 * - 检测到 cache.delete 在 repository.save 之前 → 违反 TCS-CACHE-02
 * - cache.get 返回 null 后未调用 cache.set 缓存空值 → 违反 TCS-CACHE-03
 *
 * 设计依据：
 * - EAG 方案 §5.8.2 缓存规范（多级缓存 + 三防设计）
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/cache-pattern-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, buildPass, extractFilePathFromComment, lineOf } from "./checker-utils";

/**
 * 缓存写入方法名清单（识别 cache.set 调用）
 *
 * 匹配以下方法调用：
 * - cache.set / cache.setJSON / cache.setWithTtl
 * - cacheClient.set / redisClient.set / redis.set
 * - this.cache.set / this.cacheClient.set
 */
const CACHE_SET_METHODS: ReadonlyArray<string> = Object.freeze(["set", "setJSON", "setWithTtl", "setex", "setEx"]);

/**
 * 缓存删除方法名清单（识别 cache.delete 调用）
 */
const CACHE_DELETE_METHODS: ReadonlyArray<string> = Object.freeze(["delete", "del", "remove"]);

/**
 * TTL 参数名清单（识别 cache.set 调用中的 TTL 设置）
 *
 * cache.set(key, value, { ttlSeconds: 300 }) 中的 ttlSeconds 字段
 * cache.set(key, value, { ttl: 300 }) 中的 ttl 字段
 * cache.setex(key, ttl, value) 中的 setex 第二参数
 */
const TTL_PARAM_NAMES: ReadonlyArray<string> = Object.freeze([
  "ttlSeconds",
  "ttl",
  "expireSeconds",
  "expire",
  "ttlMs",
  "ttlMilliseconds",
]);

/**
 * 数据库写入方法名清单（识别 repository.save / db.update 调用）
 */
const DB_WRITE_METHODS: ReadonlyArray<string> = Object.freeze([
  "save",
  "update",
  "create",
  "delete",
  "remove",
  "insert",
  "upsert",
]);

/**
 * 判定 receiver 是否为缓存对象（cache / cacheClient / redisClient / redis）
 *
 * @param receiver 方法调用的接收者
 * @returns true 表示缓存对象
 */
function isCacheReceiver(receiver: string): boolean {
  const lower = receiver.toLowerCase();
  return (
    lower === "cache" || lower === "cacheclient" || lower === "redisclient" || lower === "redis" || lower === "client"
  );
}

/**
 * 判定 receiver 是否为数据库对象（repository / db / prisma / knex）
 *
 * @param receiver 方法调用的接收者
 * @returns true 表示数据库对象
 */
function isDbReceiver(receiver: string): boolean {
  const lower = receiver.toLowerCase();
  return lower === "repository" || lower === "repo" || lower === "db" || lower === "prisma" || lower === "knex";
}

/**
 * 缓存模式判定器
 *
 * 实现 StaticChecker 协议，负责 TCS-CACHE-01/02/03 红线的静态判定。
 */
export class CachePatternChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["TCS-CACHE-01", "TCS-CACHE-02", "TCS-CACHE-03"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. TCS-CACHE-01：扫描 cache.set 调用，检查参数中是否包含 TTL 设置
   * 2. TCS-CACHE-02：扫描 cache.delete + db.write 调用，检查双写顺序
   * 3. TCS-CACHE-03：扫描 cache.get 后的 null 检查，检查是否缓存空值
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
      const lines = content.split(/\r?\n/);

      // TCS-CACHE-01：扫描 cache.set 调用是否提供 TTL
      // 匹配 cache.set( 或 redis.set( 形式，跨多行检查调用参数
      const cacheSetRe = /\b([a-zA-Z_][\w]*)\.([a-zA-Z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = cacheSetRe.exec(content)) !== null) {
        const receiver = m[1];
        const method = m[2];
        const callStart = m.index;

        // 检测 cache.set 调用
        if (isCacheReceiver(receiver) && CACHE_SET_METHODS.includes(method)) {
          // 提取调用参数（从 callStart 开始匹配括号配对）
          const callEnd = this.findMatchingParen(content, callStart + receiver.length + 1 + method.length);
          if (callEnd < 0) continue;
          const callArgs = content.slice(callStart, callEnd + 1);
          const callLine = lineOf(content, callStart);

          // 检查参数中是否包含 TTL 设置
          const hasTtl = TTL_PARAM_NAMES.some((param) => {
            // 匹配 paramName: 数值 或 paramName: 变量 的形式
            const ttlRe = new RegExp(`\\b${param}\\s*:`);
            return ttlRe.test(callArgs);
          });
          // setex(key, ttl, value) 形式：第二参数为 TTL（不要求显式字段名）
          const isSetex = method === "setex" || method === "setEx";
          if (isSetex && /\(\s*[^,]+,\s*[^,]+,/.test(callArgs)) {
            continue; // setex 形式天然含 TTL
          }

          if (!hasTtl && !isSetex) {
            violations.push({
              filePath,
              line: callLine,
              description:
                `缓存写入调用 ${receiver}.${method}() 未显式提供 TTL 参数——违反 TCS-CACHE-01 红线。` +
                `所有缓存 key 必须显式 TTL，否则 Redis 内存无限增长最终 OOM，` +
                `且数据更新后缓存不会自动失效，长期与 DB 不一致`,
              fixSuggestion:
                "1. 在 cache.set() 调用的 options 参数中显式提供 ttlSeconds（如 { ttlSeconds: 300 }）\n" +
                "2. 选择合理的 TTL（5 分钟~1 小时，根据数据更新频率）\n" +
                "3. 对确实不过期的 key，显式声明 ttlExempt=true 加入豁免清单\n" +
                "4. 监控 Redis 内存使用与 key 过期分布",
            });
          }
        }

        // TCS-CACHE-02：扫描 cache.delete + db.write 双写顺序
        // 仅在同一文件中检测：cache.delete 在 db.write 之前出现 → 违规
        if (isCacheReceiver(receiver) && CACHE_DELETE_METHODS.includes(method)) {
          const deleteLine = lineOf(content, callStart);
          // 计算 cache.delete 调用结束位置（左括号位置 + receiver.length + 1 + method.length = 左括号位置）
          const deleteCallEnd = this.findMatchingParen(content, callStart + receiver.length + 1 + method.length);
          // 从 cache.delete 调用之后开始扫描 db.write 调用
          const restStart = deleteCallEnd > 0 ? deleteCallEnd : callStart;
          const restContent = content.slice(restStart);
          const dbWriteRe = new RegExp(`\\b([a-zA-Z_][\\w]*)\\.(${DB_WRITE_METHODS.join("|")})\\s*\\(`);
          const dbMatch = restContent.match(dbWriteRe);
          if (dbMatch && isDbReceiver(dbMatch[1])) {
            violations.push({
              filePath,
              line: deleteLine,
              description:
                `检测到 cache.delete 在 db.write 之前执行——违反 TCS-CACHE-02 红线（缓存与 DB 双写顺序）。` +
                `先删缓存后写 DB 会导致：在写入 DB 完成前，其他请求读到 DB 旧值并回填缓存，` +
                `造成缓存与 DB 长期不一致`,
              fixSuggestion:
                "1. 调整双写顺序：先写 DB 后删缓存（Cache-Aside 模式）\n" +
                "2. 或采用延迟双删：先删缓存 → 写 DB → 延迟 500ms 再删缓存\n" +
                "3. 或采用 Write-Through 模式：通过缓存层透明写 DB\n" +
                "4. 高并发场景考虑订阅 DB binlog（如 Canal）异步删缓存",
            });
          }
        }
      }

      // TCS-CACHE-03：扫描 cache.get 后的 null 检查，检查是否缓存空值（防穿透）
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*\/\//.test(line)) continue;
        if (/^\s*\*/.test(line)) continue;

        // 检测 cache.get 调用
        const getMatch = line.match(/\b([a-zA-Z_]\w*)\.(get|getJSON)\s*\(/);
        if (!getMatch || !isCacheReceiver(getMatch[1])) continue;

        // 向后扫描 20 行，检查是否存在 null 检查 + 未缓存空值
        const lookAhead = lines.slice(i + 1, Math.min(i + 20, lines.length)).join("\n");
        const hasNullCheck = /\bnull\b/.test(lookAhead) || /===\s*undefined/.test(lookAhead);
        if (!hasNullCheck) continue;

        // 检查在 null 检查分支中是否调用 cache.set 缓存空值
        // 启发式：null 检查后的代码块中是否有 cache.set 调用
        const cacheSetInBranch = /\bcache\.set\s*\(|\bredisClient\.set\s*\(/.test(lookAhead);
        if (!cacheSetInBranch) {
          violations.push({
            filePath,
            line: i + 1,
            description:
              `cache.get 后的 null 检查分支未缓存空值——违反 TCS-CACHE-03 红线（缓存防穿透）。` +
              `未缓存空值将导致恶意请求穿透缓存打到 DB，引发缓存穿透问题（DB 负载激增）`,
            fixSuggestion:
              "1. 在 cache.get 返回 null 后，检查 DB 是否存在记录\n" +
              "2. 若 DB 无记录，缓存空值（如 cache.set(key, NULL_SENTINEL, { ttlSeconds: 60 })）\n" +
              "3. 空值 TTL 应较短（如 60 秒）避免新数据写入后缓存不更新\n" +
              "4. 或引入布隆过滤器（Bloom Filter）在缓存层前拦截不存在的 key",
          });
        }
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }

  /**
   * 查找匹配的右括号位置
   *
   * 从左括号位置开始，匹配嵌套的括号对，返回对应的右括号位置。
   * 处理字符串字面量与注释中的括号（简化处理，不解析字符串内括号）。
   *
   * @param content 完整内容
   * @param openPos 左括号位置
   * @returns 右括号位置；未找到返回 -1
   */
  private findMatchingParen(content: string, openPos: number): number {
    let depth = 0;
    for (let i = openPos; i < content.length; i++) {
      const ch = content[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}
