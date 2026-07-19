/**
 * 依赖漏洞判定器（DependencyScanner）—— EAG-P2 批次 9 S2
 *
 * 负责红线：
 * - TCS-SEC-01：高危依赖漏洞未修复即放行（npm audit 输出中 CVSS ≥ 7 即 violated）
 *
 * 判定算法：
 * 1. 扫描产出物中的 package.json 文件，提取 dependencies 中的依赖版本
 * 2. 扫描产出物中包含 npm audit 输出的文件（如 npm-audit.json / audit-report.txt），
 *    检测其中 CVSS 分数 ≥ 7 的高危漏洞
 * 3. 若无 npm audit 输出文件，检查 package.json 中是否含已知高危漏洞依赖版本
 *    （内置常见漏洞依赖版本清单：lodash / axios / express 等）
 *
 * 判定规则：
 * - npm audit 输出中含 CVSS ≥ 7 的漏洞 → 违反 TCS-SEC-01
 * - package.json 含已知高危漏洞依赖版本（如 lodash@4.17.20）→ 违反 TCS-SEC-01
 *
 * 设计依据：
 * - EAG 方案 §5.8.5 漏洞扫描与修复闭环
 * - EAG-P2 批次 9 设计 §4.5.4 静态判定器清单
 *
 * @module eag/coding/static-checkers/dependency-scanner
 */

import type { StaticChecker } from "../types";
import type { RedlineDefinition, RedlineResult } from "../../evaluator/types";
import { buildViolations, buildPass, extractFilePathFromComment, lineOf } from "./checker-utils";

/**
 * CVSS 高危阈值（≥ 此值视为高危漏洞）
 *
 * CVSS v3.x 评分标准：
 * - 0.0：无漏洞
 * - 0.1~3.9：低危
 * - 4.0~6.9：中危
 * - 7.0~8.9：高危
 * - 9.0~10.0：严重
 *
 * 本判定器以 7.0 为高危阈值（对齐 §5.8.5 漏洞扫描规范）。
 */
const CVSS_HIGH_THRESHOLD = 7.0;

/**
 * 已知高危漏洞依赖清单（内置最小集合）
 *
 * 此清单仅包含常见的、影响广泛的、有明确修复版本的高危漏洞依赖。
 * 实际生产场景应通过 npm audit 实时获取最新漏洞数据，本清单作为离线兜底。
 *
 * 每条记录：依赖名 + 漏洞版本范围 + CVE 编号 + 修复版本 + CVSS 分数 + 漏洞描述
 */
const KNOWN_VULNERABLE_DEPENDENCIES: ReadonlyArray<{
  readonly name: string;
  readonly vulnerableVersions: ReadonlyArray<string>;
  readonly cve: string;
  readonly fixedVersion: string;
  readonly cvss: number;
  readonly description: string;
}> = Object.freeze([
  {
    name: "lodash",
    vulnerableVersions: ["4.17.20", "4.17.19", "4.17.18", "4.17.17", "4.17.16", "4.17.15"],
    cve: "CVE-2021-23337",
    fixedVersion: "4.17.21",
    cvss: 7.2,
    description: "Command Injection in lodash（命令注入）",
  },
  {
    name: "axios",
    vulnerableVersions: ["0.21.0", "0.21.1", "0.20.0", "0.20.1", "0.19.0", "0.19.1", "0.19.2"],
    cve: "CVE-2021-3749",
    fixedVersion: "0.21.2",
    cvss: 7.5,
    description: "ReDoS in axios（正则拒绝服务）",
  },
  {
    name: "express",
    vulnerableVersions: ["4.17.1", "4.17.0", "4.16.4", "4.16.3", "4.16.2", "4.16.1", "4.16.0"],
    cve: "CVE-2022-24999",
    fixedVersion: "4.17.3",
    cvss: 7.5,
    description: "qs prototype poisoning via express（原型污染）",
  },
  {
    name: "minimist",
    vulnerableVersions: ["1.2.5", "1.2.4", "1.2.3", "1.2.2", "1.2.1", "1.2.0", "0.0.8"],
    cve: "CVE-2021-44906",
    fixedVersion: "1.2.6",
    cvss: 9.8,
    description: "Prototype Pollution in minimist（原型污染，严重）",
  },
  {
    name: "marked",
    vulnerableVersions: ["4.0.10", "4.0.9", "4.0.8", "4.0.7", "4.0.6", "4.0.5", "4.0.4"],
    cve: "CVE-2022-21681",
    fixedVersion: "4.0.12",
    cvss: 7.5,
    description: "ReDoS in marked（正则拒绝服务）",
  },
  {
    name: "node-forge",
    vulnerableVersions: ["1.3.0", "1.2.1", "1.2.0", "1.1.0", "1.0.0"],
    cve: "CVE-2022-24772",
    fixedVersion: "1.3.1",
    cvss: 7.5,
    description: "Forge URL parsing vulnerability（URL 解析漏洞）",
  },
]);

/**
 * 判定文件路径是否为 package.json
 *
 * @param filePath 文件路径
 * @returns true 表示 package.json 文件
 */
function isPackageJson(filePath: string): boolean {
  return filePath.endsWith("package.json") || filePath === "package.json";
}

/**
 * 判定文件路径是否为 npm audit 输出文件
 *
 * @param filePath 文件路径
 * @returns true 表示 npm audit 输出文件
 */
function isNpmAuditFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith("npm-audit.json") ||
    lower.endsWith("audit-report.json") ||
    lower.endsWith("audit.json") ||
    lower.endsWith("npm-audit.txt") ||
    lower.endsWith("audit-report.txt")
  );
}

/**
 * 从 npm audit 输出中提取 CVSS 分数
 *
 * npm audit --json 输出格式（v7+）：
 * {
 *   "vulnerabilities": {
 *     "lodash": {
 *       "severity": "high",
 *       "via": [{ "title": "...", "cvss": { "score": 7.2 } }]
 *     }
 *   }
 * }
 *
 * 也支持 v6 格式：
 * {
 *   "advisories": {
 *     "1001825": { "cvss": { "score": 7.2 }, "severity": "high" }
 *   }
 * }
 *
 * @param content npm audit 输出内容
 * @returns 检测到的高危漏洞列表（含包名 / CVSS / 描述）
 */
function extractHighSeverityVulnerabilities(
  content: string
): Array<{ readonly packageName: string; readonly cvss: number; readonly description: string }> {
  const result: Array<{ readonly packageName: string; readonly cvss: number; readonly description: string }> = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 非 JSON 格式，尝试正则提取
    // 匹配 npm audit 文本输出中的 high / critical 级别漏洞
    const severityRe = /┌───────────────┬[─┬┴┼┤├┌┐└┘]+\n│\s*(high|critical)\s+│\s+([^\n]+)\n/gi;
    let m: RegExpExecArray | null;
    while ((m = severityRe.exec(content)) !== null) {
      const severity = m[1].toLowerCase();
      const description = m[2].trim();
      if (severity === "high" || severity === "critical") {
        const cvss = severity === "critical" ? 9.0 : 7.5;
        result.push({
          packageName: description.split(/\s+/)[0] ?? "unknown",
          cvss,
          description,
        });
      }
    }
    return result;
  }

  if (typeof parsed !== "object" || parsed === null) return result;
  const root = parsed as Record<string, unknown>;

  // v7+ 格式：vulnerabilities 字段
  const vulnerabilities = root.vulnerabilities;
  if (typeof vulnerabilities === "object" && vulnerabilities !== null) {
    for (const [pkgName, info] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      if (typeof info !== "object" || info === null) continue;
      const infoObj = info as Record<string, unknown>;
      // 检查 severity 字段
      const severity = String(infoObj.severity ?? "").toLowerCase();
      if (severity === "high" || severity === "critical") {
        // 检查 via 数组中的 cvss.score
        const via = infoObj.via;
        let maxCvss = severity === "critical" ? 9.0 : 7.5;
        if (Array.isArray(via)) {
          for (const v of via) {
            if (typeof v === "object" && v !== null) {
              const vObj = v as Record<string, unknown>;
              const cvss = vObj.cvss;
              if (typeof cvss === "object" && cvss !== null) {
                const score = (cvss as Record<string, unknown>).score;
                if (typeof score === "number" && score > maxCvss) {
                  maxCvss = score;
                }
              }
            }
          }
        }
        result.push({
          packageName: pkgName,
          cvss: maxCvss,
          description: `${pkgName} 含 ${severity} 级漏洞（CVSS ${maxCvss.toFixed(1)}）`,
        });
      }
    }
  }

  // v6 格式：advisories 字段
  const advisories = root.advisories;
  if (typeof advisories === "object" && advisories !== null) {
    for (const [, info] of Object.entries(advisories as Record<string, unknown>)) {
      if (typeof info !== "object" || info === null) continue;
      const infoObj = info as Record<string, unknown>;
      const severity = String(infoObj.severity ?? "").toLowerCase();
      if (severity !== "high" && severity !== "critical") continue;
      const cvss = infoObj.cvss;
      let score = severity === "critical" ? 9.0 : 7.5;
      if (typeof cvss === "object" && cvss !== null) {
        const scoreValue = (cvss as Record<string, unknown>).score;
        if (typeof scoreValue === "number") score = scoreValue;
      }
      const moduleName = String(infoObj.module_name ?? "unknown");
      const title = String(infoObj.title ?? "");
      result.push({
        packageName: moduleName,
        cvss: score,
        description: `${moduleName}: ${title}（CVSS ${score.toFixed(1)}）`,
      });
    }
  }

  return result;
}

/**
 * 依赖漏洞判定器
 *
 * 实现 StaticChecker 协议，负责 TCS-SEC-01 红线的静态判定。
 */
export class DependencyScanner implements StaticChecker {
  /** 该 Checker 负责的红线 ID 列表 */
  readonly redlineIds: ReadonlyArray<string> = Object.freeze(["TCS-SEC-01"]);

  /**
   * 执行静态判定
   *
   * 算法：
   * 1. 优先扫描 npm audit 输出文件（npm-audit.json / audit-report.txt）
   *    - 提取 CVSS ≥ 7 的高危漏洞
   * 2. 兜底扫描 package.json 中的依赖版本
   *    - 比对 KNOWN_VULNERABLE_DEPENDENCIES 清单
   * 3. 若发现高危漏洞 → 违规
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

    // 第一遍：扫描 npm audit 输出文件
    let hasAuditFile = false;
    for (const artifact of artifacts) {
      if (!isNpmAuditFile(artifact.path)) continue;
      hasAuditFile = true;
      const filePath = artifact.path;
      const vulns = extractHighSeverityVulnerabilities(artifact.content);
      for (const v of vulns) {
        if (v.cvss >= CVSS_HIGH_THRESHOLD) {
          violations.push({
            filePath,
            line: 1,
            description:
              `npm audit 检测到高危漏洞：${v.description}——违反 TCS-SEC-01 红线（高危依赖漏洞未修复即放行）。` +
              `CVSS 评分 ${v.cvss.toFixed(1)}（≥ ${CVSS_HIGH_THRESHOLD}），CI 流水线应阻塞发布`,
            fixSuggestion:
              "1. 运行 npm audit fix 自动修复可修复的漏洞\n" +
              "2. 手动升级高危依赖到修复版本（如 npm install lodash@latest）\n" +
              "3. 若无法立即升级，通过 npm overrides 强制使用修复版本\n" +
              "4. 在 CI 流水线添加 npm audit 阻塞门禁（CVSS ≥ 7 即失败）\n" +
              "5. 定期运行 npm audit（如每周）跟踪新漏洞",
          });
        }
      }
    }

    // 第二遍：兜底扫描 package.json（若没有 npm audit 输出，则检查已知漏洞依赖）
    if (!hasAuditFile) {
      for (const artifact of artifacts) {
        if (!isPackageJson(artifact.path) && !extractFilePathFromComment(artifact.content).endsWith("package.json")) {
          continue;
        }
        const filePath = isPackageJson(artifact.path) ? artifact.path : extractFilePathFromComment(artifact.content);
        // 解析 package.json 提取 dependencies
        let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        try {
          pkg = JSON.parse(artifact.content);
        } catch {
          continue;
        }
        const allDeps: Record<string, string> = {
          ...(pkg.dependencies ?? {}),
          ...(pkg.devDependencies ?? {}),
        };
        for (const [depName, depVersion] of Object.entries(allDeps)) {
          // 去除版本前缀（^ / ~ / >= 等）
          const cleanVersion = depVersion.replace(/^[^0-9]+/, "").trim();
          // 比对已知漏洞清单
          for (const known of KNOWN_VULNERABLE_DEPENDENCIES) {
            if (known.name !== depName) continue;
            if (!known.vulnerableVersions.includes(cleanVersion)) continue;
            // 检查 CVSS 是否达到高危阈值
            if (known.cvss < CVSS_HIGH_THRESHOLD) continue;
            // 计算行号（查找 dependencies 中该依赖的行）
            const depLineRe = new RegExp(`"${depName}"\\s*:\\s*"${depVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
            const m = artifact.content.match(depLineRe);
            const line = m ? lineOf(artifact.content, m.index ?? 0) : 1;
            violations.push({
              filePath,
              line,
              description:
                `依赖 ${depName}@${cleanVersion} 含已知高危漏洞 ${known.cve}（${known.description}，CVSS ${known.cvss.toFixed(1)}）` +
                `——违反 TCS-SEC-01 红线（高危依赖漏洞未修复即放行）`,
              fixSuggestion:
                `1. 升级 ${depName} 到修复版本 ${known.fixedVersion}（npm install ${depName}@${known.fixedVersion}）\n` +
                `2. 验证升级后业务功能正常（运行单元测试与集成测试）\n` +
                "3. 在 CI 流水线添加 npm audit 阻塞门禁\n" +
                "4. 接入 Dependabot / Snyk 自动跟踪依赖漏洞",
            });
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
