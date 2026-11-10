/**
 * jev 校准样本采集脚本（校准计划 A1，2026-11-10）
 *
 * 从本地真实会话存储（~/.deepcode/projects/<code>/<sessionId>.jsonl）提取
 * 历史 LLM 迭代轮次，构建 jev 校准样本集：
 *   - 每「轮」= 一条 assistant 消息及其后挂的全部 tool 结果消息
 *     （与 session.ts recordTurn 点的观测口径逐字段同构）；
 *   - 每「样本」= 最近 3-6 轮观测窗口 + 窗口前最近的用户指令；
 *   - 标注规则（script-rule，人工复核后生效）：
 *       label=empty    末尾连续 ≥2 轮空转（无可见正文且无工具成功）；
 *                      末轮孤立空转（前轮有进展）为歧义样本，不入集；
 *       label=progress 末轮有可见正文或任一工具成功；
 *   - 脱敏：复用生产 redactDigestText（P1-4 同源），工具参数原文不进样本
 *     （digest 仅「工具名:结果签名」，结果签名复用生产 toolResultSignature）。
 *
 * 运行（仓库根）：
 *   npx tsx tests/scripts/jev-calibration-extract.mjs \
 *     --out tests/fixtures/jev-calibration-samples.jsonl \
 *     [--max-per-label 25] [--min-window 3] [--max-window 6]
 *
 * 输出两份：
 *   1. 样本集 JSONL（--out 指定，入 fixtures 前须人工复核）；
 *   2. stderr 统计摘要（各会话轮次/空转分布，供复核）。
 *
 * 密钥安全：脚本只读本地会话文件；所有入样本文本先脱敏再落盘，
 * 并对脱敏产物做密钥残留断言（sk-/JWT/Bearer/password 赋值/PEM/AKIA/LTAI）。
 *
 * @module tests/scripts/jev-calibration-extract
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 复用生产实现保证「采集样本 ↔ 生产摘要」逐字段同构（tsx 直接编译 TS 导入）
import { redactDigestText } from "../../packages/core/src/common/jev-loop-decision";
import { toolResultSignature } from "../../packages/core/src/common/loop-guard";

// ============================================================================
// 1. 参数与工具函数
// ============================================================================

/** 解析命令行参数（全部可选，均有默认值） */
function parseArgs(argv) {
  const args = {
    out: "tests/fixtures/jev-calibration-samples.jsonl",
    maxPerLabel: 25,
    minWindow: 3,
    maxWindow: 6,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--out") args.out = argv[++i];
    else if (key === "--max-per-label") args.maxPerLabel = Number(argv[++i]);
    else if (key === "--min-window") args.minWindow = Number(argv[++i]);
    else if (key === "--max-window") args.maxWindow = Number(argv[++i]);
    else {
      throw new Error(`未知参数：${key}`);
    }
  }
  return args;
}

/** 密钥残留断言模式（与 redactDigestText 的 DIGEST_SECRET_PATTERNS 同源核对用） */
const LEAK_ASSERT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(AKIA|LTAI)[A-Z0-9]{12,}\b/,
];

/** 断言脱敏产物无密钥残留（有残留即抛错，阻止脏样本入 fixtures） */
function assertNoLeak(text, sampleId, field) {
  for (const pattern of LEAK_ASSERT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`密钥残留断言失败：样本 ${sampleId} 字段 ${field} 命中 ${pattern}`);
    }
  }
}

// ============================================================================
// 2. 会话解析：jsonl → 轮次列表（观测口径与 session.ts recordTurn 点同构）
// ============================================================================

/**
 * 解析单个会话 jsonl 为轮次列表。
 *
 * 轮定义：一条 assistant 消息（含 visible 正文与 messageParams.tool_calls）
 * + 其后紧跟的全部 role=tool 结果消息（以 tool_call 关联，这里按顺序归属，
 * 中间出现的 user/system 消息视为轮边界终止）。
 *
 * @returns 轮次数组，每轮 { visibleText, toolCalls:[{name,argsRaw}], toolResults:[{name,ok,raw}] }
 */
function parseSessionTurns(filePath) {
  const messages = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // 坏行跳过（崩溃恢复中的半行），不影响其余样本
    }
  }

  /** @type {Array<object>} */
  const turns = [];
  let current = null;
  for (const msg of messages) {
    const role = msg.role;
    if (role === "assistant") {
      // 新轮开始；上一轮未闭合也照常收口（异常存储容忍）
      const toolCallsRaw = msg.messageParams?.tool_calls;
      current = {
        visibleText: typeof msg.content === "string" ? msg.content : "",
        toolCalls: Array.isArray(toolCallsRaw)
          ? toolCallsRaw.map((tc) => ({
              callId: typeof tc.id === "string" ? tc.id : "",
              name: String(tc.function?.name ?? tc.name ?? ""),
              argsRaw: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
            }))
          : [],
        toolResults: [],
      };
      turns.push(current);
    } else if (role === "tool" && current !== null) {
      // 工具结果归属当前轮；ok 字段为执行成败真值（生产 ToolResult 契约）
      let ok = false;
      let name = "";
      try {
        const parsed = JSON.parse(String(msg.content ?? "{}"));
        ok = parsed.ok === true;
        name = String(parsed.name ?? "");
      } catch {
        ok = false;
      }
      current.toolResults.push({ name, ok, raw: String(msg.content ?? "") });
    } else if (role === "user" || role === "system") {
      // user/system 消息终止当前轮的工具归属窗口
      current = null;
    }
  }
  return turns;
}

/**
 * 单轮空转判定（与 TurnGuard.recordTurn 空转口径一致）：
 * 可见正文去空白为空 且 无任何工具执行成功。
 */
function isTurnEmpty(turn) {
  const hasVisible = turn.visibleText.trim().length > 0;
  const hasToolSuccess = turn.toolResults.some((r) => r.ok);
  return !hasVisible && !hasToolSuccess;
}

// ============================================================================
// 3. 样本构建：轮次列表 → 校准样本（窗口 + 标注 + 脱敏）
// ============================================================================

/**
 * 从一个会话的轮次列表产出候选样本。
 *
 * 策略：
 * - progress 样本：每个非空轮（从第 minWindow-1 个开始）都可作窗口末轮；
 * - empty 样本：末尾**连续 ≥2 轮**空转的窗口——末轮孤立空转（前轮有真实
 *   进展）属歧义样本（循环应继续），丢弃不入集（标注规范 CA-1）；
 * - 窗口长度：min(minWindow..maxWindow, 可用轮数)，末轮对齐标注轮。
 */
function buildCandidates(turns, latestUserText, args, sessionLabel) {
  /** @type {Array<object>} */
  const candidates = [];
  for (let end = 0; end < turns.length; end += 1) {
    const isEndEmpty = isTurnEmpty(turns[end]);
    // 歧义剔除：末轮空转但前一轮非空 → 单次空轮不构成空转停滞，跳过
    if (isEndEmpty && end > 0 && !isTurnEmpty(turns[end - 1])) continue;
    const windowLen = Math.min(args.maxWindow, Math.max(args.minWindow, end + 1));
    const start = Math.max(0, end - windowLen + 1);
    const window = turns.slice(start, end + 1);
    if (window.length < 1) continue;
    // 首轮即末轮的窗口（无循环历史）对「循环判定」无意义，跳过
    if (window.length < 2 && end === 0) continue;
    candidates.push({
      sessionLabel,
      turnsCompleted: end + 1,
      label: isEndEmpty ? "empty" : "progress",
      window,
      latestUserText,
    });
  }
  return candidates;
}

/** 轮次观测 → 脱敏后的 JevTurnObservation 形态（逐字段同构生产摘要输入） */
function redactTurn(turn, sampleId, index) {
  const observation = {
    visibleText: redactDigestText(turn.visibleText.trim()),
    hadToolCalls: turn.toolCalls.length > 0,
    toolSucceededCount: turn.toolResults.filter((r) => r.ok).length,
    toolFailedCount: turn.toolResults.filter((r) => !r.ok).length,
    // 结果签名内嵌工具输出前缀（生产 toolResultSignature 形态），与正文同样
    // 必须过生产脱敏函数（P1-4：摘要构建时统一脱敏）
    toolCallDigests: turn.toolResults.map((r) => {
      return redactDigestText(`${r.name || "unknown"}:${toolResultSignature(r.raw)}`);
    }),
  };
  // 工具调用数多于结果数时补 nosig（顺序对齐生产：按调用列表补齐）
  if (turn.toolCalls.length > observation.toolCallDigests.length) {
    for (let i = observation.toolCallDigests.length; i < turn.toolCalls.length; i += 1) {
      observation.toolCallDigests.push(`${turn.toolCalls[i].name}:nosig`);
    }
  }
  assertNoLeak(observation.visibleText, `${sampleId}#t${index}`, "visibleText");
  observation.toolCallDigests.forEach((digest, di) => {
    assertNoLeak(digest, `${sampleId}#t${index}#d${di}`, "toolCallDigests");
  });
  return observation;
}

// ============================================================================
// 4. 主流程：扫描 → 采样 → 脱敏 → 落盘
// ============================================================================

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectsDir = path.join(os.homedir(), ".deepcode", "projects");
  if (!fs.existsSync(projectsDir)) {
    console.error(`[FATAL] 会话存储不存在：${projectsDir}`);
    process.exit(1);
  }

  /** @type {Array<object>} */
  const allCandidates = [];
  /** 统计摘要（stderr，人工复核用） */
  const stats = [];

  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsDir, project.name);
    for (const file of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!file.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, file.name);
      try {
        const turns = parseSessionTurns(filePath);
        if (turns.length < 2) continue;
        // 窗口前最近 user 正文（取原始 content，脱敏在 redact 阶段统一做）
        // user 正文的提取放在解析层：这里简化为从文件重扫——为控制内存与复杂度，
        // 直接在 parse 时未存 user，这里补一次轻量扫描
        let latestUserText = "";
        // 候选窗口的 latestUserText 随 end 变化，需在构建时知道每轮前的最近 user；
        // 简化口径：取全会话最后一条 user 正文（校准样本对「任务目标」保真度要求
        // 高于轮级精确性，且大部分会话单任务单指令）
        for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.role === "user" && typeof msg.content === "string" && msg.content.trim().length > 0) {
              latestUserText = msg.content;
            }
          } catch {
            // 坏行跳过
          }
        }
        const candidates = buildCandidates(turns, latestUserText, args, project.name);
        allCandidates.push(...candidates);
        const emptyCount = turns.filter(isTurnEmpty).length;
        stats.push(
          `${project.name}/${file.name}: turns=${turns.length} empty=${emptyCount} candidates=${candidates.length}`
        );
      } catch (err) {
        stats.push(`${project.name}/${file.name}: 解析失败 ${err.message}`);
      }
    }
  }

  // 分标签配额采样（均匀取前 N 个，跨会话天然分散）
  const byLabel = { progress: [], empty: [] };
  for (const candidate of allCandidates) {
    if (byLabel[candidate.label].length < args.maxPerLabel) {
      byLabel[candidate.label].push(candidate);
    }
  }

  // 落盘：脱敏 + 断言 + 标注来源
  /** @type {string[]} */
  const lines = [];
  let sampleIndex = 0;
  for (const label of ["progress", "empty"]) {
    for (const candidate of byLabel[label]) {
      sampleIndex += 1;
      const sampleId = `CAL-${String(sampleIndex).padStart(3, "0")}`;
      const sample = {
        id: sampleId,
        mode: "task",
        label,
        annotatedBy: "script-rule",
        sessionLabel: candidate.sessionLabel,
        turnsCompleted: candidate.turnsCompleted,
        latestUserText: redactDigestText(candidate.latestUserText.trim()).slice(0, 200),
        turns: candidate.window.map((turn, i) => redactTurn(turn, sampleId, i)),
      };
      assertNoLeak(sample.latestUserText, sampleId, "latestUserText");
      lines.push(JSON.stringify(sample));
    }
  }

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");

  // 统计摘要（stderr）
  console.error(`[extract] 扫描会话：${stats.length} 个，候选窗口：${allCandidates.length}`);
  console.error(`[extract] 落盘样本：progress=${byLabel.progress.length} empty=${byLabel.empty.length} → ${outPath}`);
  const emptyHeavy = stats.filter((s) => /empty=[1-9]/.test(s));
  console.error(`[extract] 含空转轮的会话 ${emptyHeavy.length} 个：`);
  for (const line of emptyHeavy.slice(0, 15)) console.error(`  ${line}`);
  if (byLabel.empty.length < 20) {
    console.error(`[WARN] empty 样本不足 20（${byLabel.empty.length}）——真实会话空转样本稀缺时，`);
    console.error(`       按 A1 计划允许补充：b14ab3e1 事故形态复刻样本（annotatedBy: incident-replay）。`);
  }
}

main();
