/**
 * EAG 子命令 - 证据包 CLI（P2）
 *
 * 提供 `deepcode eag evidence-bundle` 命令行入口：
 * 聚合执行历史 + 三层规则资产 + 技能清单为统一证据包，输出到 stdout。
 *
 * 用法：
 * - deepcode eag evidence-bundle                          # normal 档，近 30 天，摘要输出
 * - deepcode eag evidence-bundle --days 7 --depth quick   # quick 档，近 7 天
 * - deepcode eag evidence-bundle --format json            # 机器模式：完整证据包 JSON
 * - deepcode eag evidence-bundle --project-root /path/x   # 指定工作区
 * - deepcode eag help                                     # 帮助
 *
 * 设计原则（对齐 Better Harness CLI 双契约）：
 * - human-first 默认输出（摘要）+ --format json 机器模式（stdout 保持 parser-safe，
 *   摘要之外的日志一律走 stderr）
 * - 输出先校验后输出：validateEvidenceBundle 不通过 → stderr 报错 + exitCode 1
 * - 错误隔离：命令失败返回 exitCode=1 + stderr 错误说明，不抛异常到调用方
 * - 中文输出
 *
 * 调用方：
 * - packages/cli/src/cli.tsx —— 非 TUI 模式（deepcode eag evidence-bundle）
 *
 * @module cli/eag/eag-cmd
 */

import { buildEvidenceBundle, validateEvidenceBundle, type EvidenceBundleDepth } from "@vegamo/deepcode-core";

// ============================================================================
// 类型定义
// ============================================================================

/** /eag 子命令类型 */
export type EagSubcommand = "evidence-bundle";

/** /eag 命令参数（由 CLI 层解析后构造） */
export interface EagCommandArgs {
  /** 子命令名称 */
  readonly subcommand: EagSubcommand;
  /** 项目根目录（默认 process.cwd()） */
  readonly projectRoot: string;
  /** 窗口天数（默认按 depth：quick=7 / normal=30） */
  readonly days?: number;
  /** 深度档位（默认 normal） */
  readonly depth?: EvidenceBundleDepth;
  /** 输出格式（默认 summary 摘要；json = 完整证据包） */
  readonly format?: "summary" | "json";
}

/** 命令执行结果 */
export interface EagCommandResult {
  /** 退出码：0=成功，1=失败 */
  readonly exitCode: number;
  /** 标准输出 */
  readonly stdout: string;
  /** 标准错误 */
  readonly stderr: string;
}

// ============================================================================
// 帮助
// ============================================================================

/** 输出 /eag 帮助文本 */
export function formatEagHelp(): string {
  return [
    "用法：deepcode eag <subcommand> [options]",
    "",
    "EAG 证据工具子命令：",
    "  evidence-bundle    构建统一证据包（执行历史 + 规则资产 + 技能清单）",
    "",
    "evidence-bundle 选项：",
    "  --project-root <dir>    项目根目录（默认当前目录）",
    "  --days <n>              回看天数（默认：quick=7，normal=30）",
    "  --depth <quick|normal>  证据深度档位（默认 normal）",
    "  --format <summary|json> 输出格式（默认 summary 摘要；json 为完整证据包）",
    "",
    "示例：",
    "  deepcode eag evidence-bundle",
    "  deepcode eag evidence-bundle --days 7 --depth quick",
    "  deepcode eag evidence-bundle --format json > bundle.json",
    "",
  ].join("\n");
}

// ============================================================================
// 执行
// ============================================================================

/**
 * 执行 /eag 子命令
 *
 * @param args 命令参数
 * @returns 执行结果（exitCode/stdout/stderr；stdout 已同时写入真实终端）
 */
export async function executeEagCommand(args: EagCommandArgs): Promise<EagCommandResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  if (args.subcommand !== "evidence-bundle") {
    stderr.push(`未知的 eag 子命令：${String(args.subcommand)}（可用：evidence-bundle / help）`);
    process.stderr.write(stderr.join("\n") + "\n");
    return { exitCode: 1, stdout: "", stderr: stderr.join("\n") };
  }

  const depth = args.depth ?? "normal";
  const until = Date.now();
  const days = args.days ?? (depth === "quick" ? 7 : 30);
  const since = until - days * 24 * 60 * 60 * 1000;

  let bundle;
  try {
    bundle = await buildEvidenceBundle({
      projectRoot: args.projectRoot,
      since,
      until,
      depth,
    });
  } catch (err) {
    const msg = `[eag] 证据包构建失败：${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(msg + "\n");
    return { exitCode: 1, stdout: "", stderr: msg };
  }

  // 先校验后输出（机器模式契约：校验失败绝不输出半成品 JSON）
  const validation = validateEvidenceBundle(bundle);
  if (!validation.ok) {
    const msg = `[eag] 证据包校验失败：\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`;
    process.stderr.write(msg + "\n");
    return { exitCode: 1, stdout: "", stderr: msg };
  }

  if (args.format === "json") {
    const json = JSON.stringify(bundle, null, 2);
    process.stdout.write(json + "\n");
    return { exitCode: 0, stdout: json, stderr: "" };
  }

  // ---- human-first 摘要 ----
  const ruleStats = { present: 0, wired: 0, exercised: 0, "outcome-supported": 0 } as Record<string, number>;
  for (const layer of [bundle.assets.rules.seed, bundle.assets.rules.global, bundle.assets.rules.project]) {
    for (const r of layer) {
      ruleStats[r.evidenceState] = (ruleStats[r.evidenceState] ?? 0) + 1;
    }
  }
  const topTools = Object.entries(bundle.summary.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, n]) => `${tool}×${n}`)
    .join("、");

  stdout.push(`# EAG 证据包（${depth} 档，${bundle.window.since} ~ ${bundle.window.until}）`);
  stdout.push(`- 工作区：${bundle.workspace}`);
  stdout.push(
    `- 执行记录：${bundle.summary.recordCount} 条（成功 ${bundle.summary.okCount} / 失败 ${bundle.summary.failCount}），会话 ${bundle.summary.sessionCount} 个`
  );
  if (topTools) stdout.push(`- 工具 Top5：${topTools}`);
  const totalRules = ruleStats.present + ruleStats.wired + ruleStats.exercised + ruleStats["outcome-supported"];
  stdout.push(
    `- 规则资产：${totalRules} 条（已配置 ${ruleStats.present} / 已接入 ${ruleStats.wired} / 已使用 ${ruleStats.exercised} / 已佐证 ${ruleStats["outcome-supported"]}）`
  );
  stdout.push(`- 技能清单：${bundle.assets.skills.count} 个（record-only）`);
  const sources = bundle.manifest.sources
    .map((s) => `${baseName(s.path)}${s.sha256 ? `(${s.sha256.slice(0, 12)}…)` : "(缺失)"}`)
    .join("、");
  stdout.push(`- 证据来源：${sources}`);
  stdout.push("");
  const summary = stdout.join("\n");
  process.stdout.write(summary + "\n");
  return { exitCode: 0, stdout: summary, stderr: "" };
}

/** 取路径最后一段（局部辅助，避免为摘要引入 node:path 依赖） */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
