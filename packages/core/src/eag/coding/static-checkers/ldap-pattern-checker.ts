/**
 * LDAP 模式判定器（LdapPatternChecker）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - TCS-LDAP-01：直连 LDAP 实时查询无缓存（业务代码直连 ldapClient.* 而非通过 LdapSyncPort）
 * - TCS-LDAP-02：同步任务无幂等（LDAP 同步任务直接 createUser 而非 upsertUserByEntryUUID）
 *
 * 判定算法：
 * 1. TCS-LDAP-01：扫描业务代码（非 LdapSynchronizer 实现）中对 ldapClient.searchUsersByUsername /
 *    ldapClient.validateCredentials / ldapClient.searchAllUsers 等方法的直接调用
 *    - 若文件 import 了 LdapClient 并直接调用其方法（而非通过 LdapSyncPort）→ 违规
 * 2. TCS-LDAP-02：扫描 LDAP 同步任务文件（含 LdapSync / fullSync / ldapSync 关键字），
 *    检测其中调用 mirrorStore.createUser（无幂等）而非 upsertUserByEntryUUID（幂等）
 *
 * 判定规则：
 * - 业务代码直连 ldapClient.searchUsersByUsername / validateCredentials → 违反 TCS-LDAP-01
 * - LDAP 同步任务调用 mirrorStore.createUser 而非 upsertUserByEntryUUID → 违反 TCS-LDAP-02
 *
 * 设计依据：
 * - EAG 方案 §5.8.4 LDAP / SSO 接入规范（双通道同步 + 幂等保护）
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/ldap-pattern-checker
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { scanImports, buildViolations, buildPass, extractFilePathFromComment, lineOf } from "./checker-utils";

/**
 * LDAP 客户端直接调用方法清单（识别业务代码直连 LDAP 客户端）
 *
 * 以下方法是 LdapClient 的公开方法，业务代码不应直接调用，应通过 LdapSyncPort 包装：
 * - searchUsersByUsername：按用户名查询 LDAP 用户
 * - validateCredentials：验证用户名密码
 * - searchAllUsers：查询所有 LDAP 用户（仅同步任务可调用）
 * - searchByFilter：按过滤器查询
 * - authenticate：LDAP 认证
 */
const LDAP_CLIENT_DIRECT_METHODS: ReadonlyArray<string> = Object.freeze([
  "searchUsersByUsername",
  "validateCredentials",
  "searchAllUsers",
  "searchByFilter",
  "authenticate",
]);

/**
 * 无幂等的镜像写入方法名（识别 TCS-LDAP-02 违规）
 *
 * mirrorStore.createUser 是无幂等的写入方法，重复执行会创建重复账号。
 * 应改用 mirrorStore.upsertUserByEntryUUID 按 entryUUID 幂等写入。
 */
const NON_IDEMPOTENT_MIRROR_METHODS: ReadonlyArray<string> = Object.freeze(["createUser", "insertUser", "addUser"]);

/**
 * 幂等的镜像写入方法名（识别合规写法）
 *
 * mirrorStore.upsertUserByEntryUUID 按 entryUUID 幂等写入，存在则更新，不存在则创建。
 */
const IDEMPOTENT_MIRROR_METHODS: ReadonlyArray<string> = Object.freeze([
  "upsertUserByEntryUUID",
  "upsertUser",
  "upsertByEntryUUID",
]);

/**
 * LDAP 同步任务关键字（识别同步任务文件）
 *
 * 文件路径或类名包含这些关键字视为 LDAP 同步任务文件，需检查幂等性。
 */
const LDAP_SYNC_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  "LdapSync",
  "ldap-sync",
  "ldapSync",
  "FullSync",
  "fullSync",
  "LdapSynchronizer",
]);

/**
 * 判定文件路径是否为 LDAP 同步任务文件
 *
 * @param filePath 文件路径
 * @param content 文件内容（用于检查类名）
 * @returns true 表示 LDAP 同步任务文件
 */
function isLdapSyncFile(filePath: string, content: string): boolean {
  // 路径包含 ldap-sync 关键字
  if (LDAP_SYNC_KEYWORDS.some((kw) => filePath.includes(kw))) {
    return true;
  }
  // 类名包含 LdapSync / FullSync 等
  const classMatch = content.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/m);
  if (classMatch) {
    const className = classMatch[1];
    if (LDAP_SYNC_KEYWORDS.some((kw) => className.includes(kw))) {
      return true;
    }
  }
  // 方法名包含 fullSync / syncLdap 等
  if (/\b(?:fullSync|syncLdap|syncUsers|ldapSync)\s*\(/.test(content)) {
    return true;
  }
  return false;
}

/**
 * 判定文件是否为 LdapSynchronizer 实现文件（应排除 TCS-LDAP-01 检查）
 *
 * LdapSynchronizer 是允许直接调用 LdapClient 的唯一位置，业务代码不应直接调用。
 *
 * @param content 文件内容
 * @returns true 表示 LdapSynchronizer 实现文件
 */
function isLdapSynchronizerImpl(content: string): boolean {
  // 类名包含 LdapSynchronizer / LdapSyncPort 实现关键字
  const classMatch = content.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/m);
  if (classMatch) {
    const className = classMatch[1];
    if (/LdapSynchronizer$/.test(className)) return true;
    if (/LdapSyncPortImpl$/.test(className)) return true;
  }
  // implements LdapSyncPort
  if (/implements\s+LdapSyncPort\b/.test(content)) {
    return true;
  }
  return false;
}

/**
 * LDAP 模式判定器
 *
 * 实现 StaticChecker 协议，负责 TCS-LDAP-01/02 红线的静态判定。
 */
export class LdapPatternChecker implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["TCS-LDAP-01", "TCS-LDAP-02"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. TCS-LDAP-01：扫描业务代码中对 ldapClient.* 方法的直接调用
   *    - 跳过 LdapSynchronizer 实现文件（允许其调用 LdapClient）
   * 2. TCS-LDAP-02：扫描 LDAP 同步任务文件，检测无幂等的镜像写入方法调用
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
      const isSyncImpl = isLdapSynchronizerImpl(content);

      // TCS-LDAP-01：业务代码直连 ldapClient 调用检测
      // 跳过 LdapSynchronizer 实现文件
      if (!isSyncImpl) {
        // 检查是否 import 了 LdapClient 类型
        const imports = scanImports(content);
        const importsLdapClient = imports.some(
          (imp) => imp.source.includes("ldap-adapter") || imp.clause.includes("LdapClient")
        );

        // 即使未显式 import，也检查方法调用（防御性检测）
        // 匹配 ldapClient.searchUsersByUsername( / ldapClient.validateCredentials( 等
        for (const method of LDAP_CLIENT_DIRECT_METHODS) {
          const callRe = new RegExp(`\\b([a-zA-Z_]\\w*)\\.${method}\\s*\\(`, "g");
          let m: RegExpExecArray | null;
          while ((m = callRe.exec(content)) !== null) {
            const receiver = m[1];
            // 仅检测典型的 ldap 客户端变量名
            const lower = receiver.toLowerCase();
            if (
              lower === "ldapclient" ||
              lower === "ldap" ||
              lower === "client" ||
              (importsLdapClient && lower.includes("ldap"))
            ) {
              violations.push({
                filePath,
                line: lineOf(content, m.index),
                description:
                  `业务代码直接调用 ${receiver}.${method}()——违反 TCS-LDAP-01 红线（直连 LDAP 实时查询无缓存）。` +
                  `业务代码应通过 LdapSyncPort 抽象访问，由 LdapSynchronizer 内部走本地镜像/增量缓存。` +
                  `直连 LDAP 会导致：1) 高并发登录场景 LDAP 服务器负载激增 2) LDAP 不可用时所有登录失败`,
                fixSuggestion:
                  "1. 在 IoC 容器中注入 LdapSyncPort 接口（而非 LdapClient）\n" +
                  "2. 业务代码通过 ldapSyncPort.authenticate(username, password) 走本地镜像/增量缓存\n" +
                  "3. 缓存命中则不查询 LDAP；缓存未命中才查询并更新镜像\n" +
                  "4. LdapSynchronizer 是允许直接调用 LdapClient 的唯一位置",
              });
            }
          }
        }
      }

      // TCS-LDAP-02：LDAP 同步任务幂等性检查
      if (isLdapSyncFile(filePath, content)) {
        // 检测无幂等的镜像写入方法（mirrorStore.createUser）
        for (const method of NON_IDEMPOTENT_MIRROR_METHODS) {
          const callRe = new RegExp(`\\b([a-zA-Z_]\\w*)\\.${method}\\s*\\(`, "g");
          let m: RegExpExecArray | null;
          while ((m = callRe.exec(content)) !== null) {
            const receiver = m[1];
            // 检测典型的镜像存储变量名
            const lower = receiver.toLowerCase();
            if (
              lower === "mirrorstore" ||
              lower === "usermirrorstore" ||
              lower === "store" ||
              lower.includes("mirror")
            ) {
              // 进一步检查：是否在同一文件中调用了幂等方法（若调用则视为合规）
              const hasIdempotentCall = IDEMPOTENT_MIRROR_METHODS.some((idMethod) => {
                const idRe = new RegExp(`\\b${receiver}\\.${idMethod}\\s*\\(`);
                return idRe.test(content);
              });
              if (hasIdempotentCall) continue;

              violations.push({
                filePath,
                line: lineOf(content, m.index),
                description:
                  `LDAP 同步任务调用 ${receiver}.${method}() 无幂等保护——违反 TCS-LDAP-02 红线（同步任务无幂等）。` +
                  `重复执行同步任务会产生重复账号——同一 LDAP 用户在本地库出现多条记录，` +
                  `登录时无法确定使用哪条记录，审计追溯困难`,
                fixSuggestion:
                  "1. 将 mirrorStore.createUser 改为 mirrorStore.upsertUserByEntryUUID\n" +
                  "2. upsert 按 entryUUID 幂等写入（存在则更新，不存在则创建）\n" +
                  "3. 全量同步时还检测并删除 LDAP 中已不存在的用户镜像\n" +
                  "4. 通过 ldapSyncPort.fullSync() 委托 LdapSynchronizer 处理幂等",
              });
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      return buildViolations(redline.id, violations);
    }
    return buildPass(redline.id);
  }
}
