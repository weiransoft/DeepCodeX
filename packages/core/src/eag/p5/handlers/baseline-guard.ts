/**
 * EAG-P5 基线红灯守卫（2026-11-08 生产修复）。
 *
 * 真实事故（T-068 / verify 报 2 个与本任务无关的失败用例）：
 * run 起始就存在的失败用例（"scripts/build.js 通过 process.execPath 调用 ts-node"、
 * "提交物安全扫描：镜像清单引用的 Dockerfile 与生产 compose 禁用 root/latest/明文密钥"）
 * 与当前任务卡无关，却被 verify 如实报成失败 → EAG 把它们算成本任务失败 →
 * 两轮失败指纹完全一致 → 确定性失败熔断 abort，fix 阶段还整卡重跑。
 *
 * 本模块在 run 起始**真实执行一次**测试命令（与 verify 同款 spawnSync 参数与
 * parseShellCommand 白名单），把 stdout+stderr 交给 parseTestOutput +
 * extractFailedTestIds，得到"run 起始既有失败用例清单"。编排层据此把每轮 verify
 * 的失败拆成"基线失败 / 新增失败"，只对新增失败累计连续失败与确定性失败指纹。
 *
 * 诚实降级（核心红线，绝不把真失败说成通过）：
 * - 无法启动 / 超时 / 无测试计数 / 命令被白名单拒 / 提取不到失败用例标识 /
 *   运行起始测试全绿 / 开关关闭 → available=false 并写明 reason；
 * - available=false 时编排层**不排除任何失败**，verify 结果仍如实 failed，
 *   summary 不省略基线仍失败的事实，不把 testPassed 改成 true；
 * - available=true 仅当识别到了 ≥1 个明确的失败用例标识（有可信基线清单可比对），
 *   否则宁可不排除，也不臆造"这些都是基线红灯"。
 *
 * @module eag/p5/handlers/baseline-guard
 */

import { spawnSync } from "node:child_process";

// 复用 verify 同款命令解析（含 ALLOWED_TEST_PROGRAMS 白名单 + shell 元字符拒绝），
// 保证"基线探测"与"每轮 verify"对同一 testCommand 的解释完全一致，不产生口径漂移。
import { parseShellCommand } from "./verify-stage-handler";
import { extractFailedTestIds, parseTestOutput } from "./test-output-analysis";

/** 基线探测默认超时（毫秒），与任务卡的 60_000 默认值一致。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** spawnSync 输出上限，与 verify-stage-handler.executeTestCommand 保持一致。 */
const SPAWN_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * 基线探测结果。
 *
 * - ids       ：run 起始既有失败用例标识（available=true 时必非空）
 * - available ：是否存在一份可信的基线红灯清单可用于排除
 * - reason    ：探测结论 / 降级原因（人类可读，供报告与审计）
 */
export interface BaselineFailureSnapshot {
  ids: string[];
  available: boolean;
  reason: string;
}

/** 构造"诚实降级"结果：任何不可靠场景都不排除任何失败。 */
function degraded(reason: string): BaselineFailureSnapshot {
  return { ids: [], available: false, reason };
}

/**
 * 采集 run 起始基线失败用例（每个 run 只应调用一次，由编排层缓存）。
 *
 * 用与 verify 完全同款的方式真实执行一次测试命令：
 * - parseShellCommand 做白名单 + shell 注入校验（命令被拒即降级）；
 * - spawnSync(shell:false, cwd=projectRoot, timeout, encoding, maxBuffer, killSignal)；
 * - parseTestOutput 解析统计，extractFailedTestIds 提取失败用例标识。
 *
 * 开关：EAG_BASELINE_GUARD === "0" 时直接降级（available=false），不做任何排除。
 *
 * @param projectRoot 项目根目录（spawnSync 的 cwd）
 * @param testCommand 测试命令（与 verify 阶段同一个命令）
 * @param timeoutMs 探测超时（毫秒，默认 60_000）
 * @returns 基线探测结果（绝不抛异常，异常一律降级）
 */
export function collectBaselineFailures(
  projectRoot: string,
  testCommand: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): BaselineFailureSnapshot {
  // 开关默认开；仅精确值 "0" 关闭。关闭时诚实降级：不排除任何失败。
  if (process.env.EAG_BASELINE_GUARD === "0") {
    return degraded("EAG_BASELINE_GUARD=0 已关闭基线守卫（诚实降级：不排除任何失败）");
  }

  const effectiveTimeoutMs = Math.max(1000, timeoutMs);
  try {
    // parseShellCommand 内含 ALLOWED_TEST_PROGRAMS 白名单校验：程序不在白名单 /
    // 含非法 shell 操作符 / 命令替换 → 抛错 → 由 catch 降级。
    const parsed = parseShellCommand(testCommand);
    const result = spawnSync(parsed.program, parsed.args, {
      cwd: projectRoot,
      shell: false,
      timeout: effectiveTimeoutMs,
      encoding: "utf8",
      maxBuffer: SPAWN_MAX_BUFFER,
      killSignal: "SIGTERM",
    });

    if (result.error) {
      return degraded(`基线探测命令无法启动：${result.error.name}: ${result.error.message}`);
    }
    if (result.status === null && result.signal === "SIGTERM") {
      return degraded(`基线探测命令超时（>${effectiveTimeoutMs}ms）`);
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const combined = `${stdout}\n${stderr}`;

    const stats = parseTestOutput(stdout, stderr);
    if (stats.parser === "unknown" || stats.total === 0) {
      return degraded("基线探测输出无任何可解析的测试计数（parser=unknown）——无法建立可信基线清单");
    }
    if (stats.failed === 0) {
      return degraded("基线探测显示运行起始测试全绿，无基线红灯清单（不排除任何失败）");
    }

    const failed = extractFailedTestIds(combined);
    if (failed.ids.length === 0) {
      // 关键诚实性守卫：failed>0 却提取不到任何用例标识时，无法做集合比对，
      // 绝不能把真失败说成"纯基线失败"借以逃过熔断。
      return degraded("基线探测未提取到任何失败用例标识——无可信基线清单，不排除任何失败");
    }

    return {
      ids: [...failed.ids],
      available: true,
      reason: `基线探测成功：识别 ${failed.ids.length} 个 run 起始既有失败用例（parser=${stats.parser}）`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degraded(`基线探测异常/命令被拒：${message}（诚实降级：不排除任何失败）`);
  }
}
