/**
 * jev 判定准确率校准评测脚本（校准计划 A2 / B1，2026-11-10）
 *
 * 用生产同构链路（JevLoopDecision.decideLoop：脱敏摘要 + 双问问题集 +
 * /v1/decision 真机调用）对 A1 样本集逐条判定，输出：
 *   - continue_loop 一致率与混淆矩阵（安全侧指标：progress 误杀数）；
 *   - is_empty_turn 一致率；
 *   - 置信度分布（直方图 + 分标签均值），供 B1 阈值扫描决策；
 *   - 按阈值 0.3-0.7 扫描 stop 动作的 precision/recall（B1 直接产出）。
 *
 * 运行（仓库根）：
 *   npx tsx tests/scripts/jev-accuracy-calibration.mjs \
 *     [--samples tests/fixtures/jev-calibration-samples.jsonl] [--json /tmp/jev-accuracy-report.json]
 *
 * 密钥：DEEPCODE_JEV_API_KEY 优先；否则读取 ~/.memsearch/config.toml（0600）。
 * 严禁把密钥写入任何输出文件。
 *
 * @module tests/scripts/jev-accuracy-calibration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 生产同构判定链路（脱敏/问题集/健康状态机全部复用，不另造实现）
import { JevLoopDecision, readChoiceAnswer } from "../../packages/core/src/common/jev-loop-decision";

/** 解析命令行参数 */
function parseArgs(argv) {
  const args = {
    samples: "tests/fixtures/jev-calibration-samples.jsonl",
    json: "/tmp/jev-accuracy-report.json",
    // A3 实验变体：baseline=生产 decideLoop 原样 / state=状态串增强（B1）/
    // instructions=问题文案增强（B2）/ combined=B1+B2。实验胜出者才合入生产。
    variant: "baseline",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--samples") args.samples = argv[++i];
    else if (argv[i] === "--json") args.json = argv[++i];
    else if (argv[i] === "--variant") args.variant = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!["baseline", "state", "instructions", "combined"].includes(args.variant)) {
    throw new Error(`未知变体：${args.variant}`);
  }
  return args;
}

/** 密钥解析：env 优先，其次 ~/.memsearch/config.toml（与真机验证脚本同规则） */
function resolveApiKey() {
  if (process.env.DEEPCODE_JEV_API_KEY) return process.env.DEEPCODE_JEV_API_KEY;
  const configPath = path.join(os.homedir(), ".memsearch", "config.toml");
  if (fs.existsSync(configPath)) {
    const match = fs.readFileSync(configPath, "utf8").match(/^api_key\s*=\s*"(.*)"/m);
    if (match) return match[1];
  }
  throw new Error("未找到 jev 网关密钥：请设置 DEEPCODE_JEV_API_KEY 或提供 ~/.memsearch/config.toml");
}

// ============================================================================
// A3 变体定义（实验用；胜出变体才合入生产 jev-loop-decision.ts）
// ============================================================================

/**
 * 从窗口观测计算空转计数：
 *   trailing = 末尾连续空转轮数（与 TurnGuard.consecutiveEmptyTurns 同口径）；
 *   inWindow = 窗口内空转轮总数。空转 = 无可见正文且无工具成功。
 */
function countEmptyTurns(turns) {
  const isEmpty = (t) => !String(t.visibleText ?? "").trim() && t.toolSucceededCount === 0;
  let trailing = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (isEmpty(turns[i])) trailing += 1;
    else break;
  }
  return { trailing, inWindow: turns.filter(isEmpty).length };
}

/** 变体问题集：baseline/state 用生产原文；instructions/combined 用 B2 增强文案 */
function buildVariantQuestions(variant) {
  if (variant === "baseline" || variant === "state") {
    return {
      continue_loop: {
        type: "choice",
        instructions: "判断当前任务执行循环是否应继续",
        criteria: { continue: "循环仍有进展或合理的尝试空间", stop: "循环空转（重复尝试、无产出），应暂停" },
      },
      is_empty_turn: {
        type: "choice",
        instructions: "判断最近一轮是否为空循环（无可见回复且无有效工具产出）",
        criteria: { yes: "本轮是空循环", no: "本轮有实质内容或工具产出" },
      },
    };
  }
  return {
    continue_loop: {
      type: "choice",
      instructions: "判断当前任务执行循环是否应继续。空转停滞 = 摘要末尾连续多轮无可见正文且无工具成功产出",
      criteria: {
        continue: "最近一轮有可见回复或工具成功产出，或存在明确的新尝试路径",
        stop: "摘要末尾连续多轮空转（无可见正文且无工具成功产出），或反复尝试同样操作且无产出",
      },
    },
    is_empty_turn: {
      type: "choice",
      instructions: "「本轮」指轮次摘要的最后一条消息。判断该轮是否为空循环",
      criteria: {
        yes: "最后一条消息显示无可见正文且无工具成功产出（或仅有失败的工具调用）",
        no: "最后一条消息有可见正文或有工具成功产出",
      },
    },
  };
}

/** 变体状态串：baseline/instructions 用生产原文；state/combined 追加 B1 空转计数 */
function buildVariantState(variant, input) {
  const base = `mode=${input.mode}; turns=${input.turnsCompleted}`;
  if (variant === "baseline" || variant === "instructions") return base;
  const { trailing, inWindow } = countEmptyTurns(input.recentTurns);
  return `${base}; consecutive_empty=${trailing}; recent_empty=${inWindow}`;
}

/**
 * 从 answers 中读取 is_empty_turn 判定（评测专用：生产 readChoiceAnswer 复用）。
 * @returns {null | {choice: string, confidence: number}} 缺问时返回 null
 */
function readEmptyTurnAnswer(answers) {
  if (answers == null || typeof answers !== "object") return null;
  const raw = answers["is_empty_turn"];
  if (raw == null || raw.type !== "choice") return null;
  if (typeof raw.choice !== "string" || typeof raw.confidence !== "number") return null;
  return { choice: raw.choice, confidence: raw.confidence };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.DEEPCODE_JEV_API_KEY = resolveApiKey();
  // 评测不追求低延迟，放宽超时避免样本误伤（健康状态机降级会污染统计）
  process.env.DEEPCODE_JEV_TIMEOUT_MS = "5000";

  const samples = fs
    .readFileSync(args.samples, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  if (samples.length === 0) throw new Error(`样本集为空：${args.samples}`);

  const jev = JevLoopDecision.fromEnv();
  if (jev == null) throw new Error("JevLoopDecision.fromEnv() 返回 null（配置装配失败）");

  /** @type {Array<object>} 逐条判定记录 */
  const records = [];
  for (const sample of samples) {
    const input = {
      mode: sample.mode,
      turnsCompleted: sample.turnsCompleted,
      recentTurns: sample.turns,
      latestUserText: sample.latestUserText,
    };
    // baseline 走生产 decideLoop 原样；其余变体经生产 decideRaw 发送
    // 变体 state/questions（消息摘要恒用生产 buildDigestMessages，保证脱敏同构）
    let decision;
    if (args.variant === "baseline") {
      decision = await jev.decideLoop(input, sample.turnsCompleted);
    } else {
      const result = await jev.decideRaw("decision", {
        messages: jev.buildDigestMessages(input),
        state: buildVariantState(args.variant, input),
        questions: buildVariantQuestions(args.variant),
      });
      decision = { turnSeq: sample.turnsCompleted, result };
    }
    // JevTurnDecision 判别在 result.ok（decision 本身无 ok 字段）
    if (!decision.result.ok) {
      records.push({
        id: sample.id,
        label: sample.label,
        error: decision.result.status,
        detail: String(decision.result.reason ?? "").slice(0, 120),
      });
      continue;
    }
    const answers = decision.result.answers;
    const continueAns = readChoiceAnswer(answers, "continue_loop");
    const emptyAns = readEmptyTurnAnswer(answers);
    records.push({
      id: sample.id,
      label: sample.label,
      continueChoice: continueAns?.choice ?? "missing",
      continueConfidence: continueAns?.confidence ?? null,
      emptyChoice: emptyAns?.choice ?? "missing",
      emptyConfidence: emptyAns?.confidence ?? null,
    });
  }

  // ==========================================================================
  // 指标计算
  // ==========================================================================
  const valid = records.filter((r) => r.error == null && r.continueChoice !== "missing");
  const errors = records.filter((r) => r.error != null);

  // continue_loop 混淆矩阵（label=empty 期望 stop；label=progress 期望 continue）
  let tp = 0,
    tn = 0,
    fp = 0,
    fn = 0; // tp=empty判stop tn=progress判continue fp=progress误杀 fn=empty漏拦
  for (const r of valid) {
    if (r.label === "empty" && r.continueChoice === "stop") tp += 1;
    else if (r.label === "empty") fn += 1;
    else if (r.continueChoice === "stop") fp += 1;
    else tn += 1;
  }
  const accuracy = valid.length > 0 ? (tp + tn) / valid.length : 0;

  // is_empty_turn 一致率（empty 期望 yes；progress 期望 no）
  const emptyValid = valid.filter((r) => r.emptyChoice !== "missing");
  const emptyHit = emptyValid.filter((r) =>
    r.label === "empty" ? r.emptyChoice === "yes" : r.emptyChoice === "no"
  ).length;

  // 置信度分布（直方图按 0.1 分箱）+ 分标签均值
  const histogram = {};
  for (const r of valid) {
    const bucket = r.continueConfidence == null ? "missing" : Math.floor(r.continueConfidence * 10) / 10;
    histogram[String(bucket)] = (histogram[String(bucket)] ?? 0) + 1;
  }
  const meanConf = (list) =>
    list.filter((r) => r.continueConfidence != null).reduce((acc, r) => acc + r.continueConfidence, 0) /
    Math.max(1, list.filter((r) => r.continueConfidence != null).length);

  // B1 阈值扫描：stop 动作在 conf≥t 时触发（生产判据同构：choice=stop && conf>=t）
  const thresholdScan = [];
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    let stopHit = 0,
      stopMiss = 0,
      stopFalse = 0;
    for (const r of valid) {
      const triggers = r.continueChoice === "stop" && r.continueConfidence != null && r.continueConfidence >= t;
      // 阈值扫描计数：empty 样本区分「命中 stop（tp）」与「漏判 stop（fn）」；progress 样本误触发 stop 记 fp
      if (r.label === "empty") {
        if (triggers) {
          stopHit += 1;
        } else {
          stopMiss += 1;
        }
      } else if (triggers) {
        stopFalse += 1;
      }
    }
    const trueEmpty = valid.filter((r) => r.label === "empty").length;
    thresholdScan.push({
      threshold: t,
      stopPrecision: stopHit + stopFalse > 0 ? stopHit / (stopHit + stopFalse) : null,
      stopRecall: trueEmpty > 0 ? stopHit / trueEmpty : null,
      progressFalseKill: stopFalse,
    });
  }

  // ==========================================================================
  // 输出
  // ==========================================================================
  console.log("==================================================================");
  console.log(
    `jev 准确率校准评测 [变体=${args.variant}]：样本 ${samples.length}（有效 ${valid.length}，错误 ${errors.length}）`
  );
  console.log("==================================================================");
  console.log(`[continue_loop] 一致率：${(accuracy * 100).toFixed(1)}%  (tp=${tp} tn=${tn} fp=${fp} fn=${fn})`);
  console.log(`  安全侧指标：progress 误杀 = ${fp}（目标 0）`);
  console.log(
    `[is_empty_turn] 一致率：${emptyValid.length > 0 ? ((emptyHit / emptyValid.length) * 100).toFixed(1) : "N/A"}%  (${emptyHit}/${emptyValid.length})`
  );
  console.log(
    `[置信度] 均值 empty=${meanConf(valid.filter((r) => r.label === "empty")).toFixed(2)} progress=${meanConf(valid.filter((r) => r.label === "progress")).toFixed(2)}`
  );
  console.log(`[置信度] 直方图：${JSON.stringify(histogram)}`);
  console.log("[阈值扫描]（stop 动作：choice=stop 且 conf≥t）");
  for (const s of thresholdScan) {
    console.log(
      `  t=${s.threshold}  precision=${s.stopPrecision == null ? "N/A" : (s.stopPrecision * 100).toFixed(0) + "%"}  recall=${s.stopRecall == null ? "N/A" : (s.stopRecall * 100).toFixed(0) + "%"}  progress误杀=${s.progressFalseKill}`
    );
  }
  if (errors.length > 0) {
    const byCategory = {};
    for (const e of errors) byCategory[e.error] = (byCategory[e.error] ?? 0) + 1;
    console.log(`[错误分布] ${JSON.stringify(byCategory)}`);
    for (const e of errors.slice(0, 5)) console.log(`  ${e.id}: ${e.error} ${e.detail ?? ""}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    variant: args.variant,
    samplesFile: args.samples,
    total: samples.length,
    valid: valid.length,
    errors: errors.length,
    continueLoop: { accuracy, tp, tn, fp, fn },
    emptyTurn: {
      agreement: emptyValid.length > 0 ? emptyHit / emptyValid.length : null,
      hit: emptyHit,
      total: emptyValid.length,
    },
    confidence: {
      histogram,
      meanEmpty: meanConf(valid.filter((r) => r.label === "empty")),
      meanProgress: meanConf(valid.filter((r) => r.label === "progress")),
    },
    thresholdScan,
    records,
  };
  fs.writeFileSync(args.json, JSON.stringify(report, null, 2), "utf8");
  console.log(`[明细] 已写入 ${args.json}`);

  // 验收口径输出（CA-1：≥80% 且 fp=0）
  const pass = accuracy >= 0.8 && fp === 0;
  console.log(
    `[验收] CA-1（一致率≥80% 且 progress 零误杀）：${pass ? "PASS" : "FAIL"} → ${pass ? "阶段 A 收口" : "转 A3 指令增强"}`
  );
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
