/**
 * Roundtable 协议层：prompt 构建 + 结构化输出解析
 *
 * 全部是纯函数，不触碰 IO / 网络。这样做的理由：
 * 群聊最容易出问题的地方不是"编排逻辑"，而是"模型没按约定输出 JSON 时怎么办"。
 * 把解析单独抽出来，可以用十几行用例把各种畸形输出钉死，不必启动整个会议。
 *
 * @module team/roundtable/protocol
 */

import type { RoleDefinition } from "../types.js";
import type {
  RoundtableAssignment,
  RoundtableMessage,
  RoundtablePosture,
  RoundtableSpeech,
  RoundtableTaskUpdate,
} from "./types.js";

// ============================================================================
// 通用 JSON 提取
// ============================================================================

/**
 * 从模型输出里提取一个 JSON 对象
 *
 * 按优先级尝试三种形态（真实模型三种都会出现）：
 * 1. ```json 围栏
 * 2. ``` 无语言标注的围栏
 * 3. 裸对象：从第一个 `{` 开始扫描到与之配对的 `}`
 *
 * 扫描时跳过字符串字面量内的括号——否则 `{"content": "}"}` 会提前截断，
 * 这是最常见的"看起来解析成功、实际拿到残缺对象"的坑。
 *
 * @param raw 模型原始输出
 * @returns 解析出的对象；完全无法解析时为 null
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  // 1 & 2：围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    const parsed = tryParseObject(fence[1].trim());
    if (parsed) return parsed;
  }

  // 3：裸对象（平衡括号扫描）
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return tryParseObject(raw.slice(start, i + 1));
      }
    }
  }
  return null;
}

/** 安全 JSON.parse：非对象/解析失败一律 null */
function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读字符串字段（去空白，非字符串返回 fallback） */
function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** 读字符串数组字段（过滤非字符串与空串） */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item !== "");
}

// ============================================================================
// 发言解析
// ============================================================================

/** 合法立场值（运行时白名单；模型可能给出 "agree" / "反对" 等） */
const POSTURES: ReadonlySet<string> = new Set(["support", "refine", "object"]);

/**
 * 解析一次发言
 *
 * 降级规则（设计文档第五节）：
 * - 没有可解析 JSON → `posture: "refine"` + `unparsed: true`，content 用原文
 * - JSON 里的 posture 不在白名单 → 同上按 refine 处理
 * - 缺 content → 用 keyPoints 拼；keyPoints 也没有 → 用原文
 *
 * 为什么非法 posture 不按 support 兜底：把"没表态"当成"同意"，是假共识的起点。
 *
 * @param raw 模型原始输出
 * @param roleId 发言角色
 * @param roleName 发言角色名
 */
export function parseSpeech(raw: string, roleId: string, roleName: string): RoundtableSpeech {
  const obj = extractJsonObject(raw);
  if (!obj) {
    return {
      roleId,
      roleName,
      posture: "refine",
      blocking: false,
      keyPoints: [],
      questions: [],
      content: raw.trim(),
      unparsed: true,
    };
  }

  const rawPosture = readString(obj["posture"]).toLowerCase();
  const validPosture = POSTURES.has(rawPosture);
  const posture = (validPosture ? rawPosture : "refine") as RoundtablePosture;
  const keyPoints = readStringArray(obj["keyPoints"]);
  const content = readString(obj["content"]) || keyPoints.join("；") || raw.trim();

  return {
    roleId,
    roleName,
    posture,
    // blocking 只在 object 时有意义；其它立场一律 false，避免模型乱填导致误判
    blocking: posture === "object" && obj["blocking"] === true,
    ...(readString(obj["replyTo"]) !== "" ? { replyTo: readString(obj["replyTo"]) } : {}),
    keyPoints,
    questions: readStringArray(obj["questions"]),
    content,
    ...(validPosture ? {} : { unparsed: true }),
  };
}

/**
 * 解析角色对自己任务的再表达
 *
 * @param raw 模型原始输出
 * @returns 解析结果；完全无法解析时 null（调用方决定降级方式）
 */
export function parseTaskUpdate(raw: string): RoundtableTaskUpdate | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const restated = readString(obj["restated"]);
  if (restated === "") return null;
  const question = readString(obj["question"]);
  const needDiscussion = obj["needDiscussion"] === true || question !== "";
  return {
    restated,
    steps: readStringArray(obj["steps"]),
    acceptance: readString(obj["acceptance"]),
    needDiscussion,
    question,
  };
}

/**
 * 解析主持人起草的决议
 *
 * 只做结构校验与清洗，**不做共识判定**——判定在 `consensus.ts`，
 * 依据是各角色的立场而不是主持人的自我声明。
 *
 * @param raw 模型原始输出
 * @param allowedRoleIds 合法角色集合（用于丢弃幻觉出来的角色）
 */
export function parseDecision(
  raw: string,
  allowedRoleIds: ReadonlySet<string>
): {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  assignments: RoundtableAssignment[];
} | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const summary = readString(obj["summary"]);
  if (summary === "") return null;

  const rawAssignments = Array.isArray(obj["assignments"]) ? obj["assignments"] : [];
  const assignments: RoundtableAssignment[] = [];
  for (const item of rawAssignments) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const roleId = readString(record["roleId"]);
    // 模型会编出不存在的角色（尤其给了长候选集时）——只保留房间内的人
    if (!allowedRoleIds.has(roleId)) continue;
    const deliverable = readString(record["deliverable"]);
    if (deliverable === "") continue;
    assignments.push({
      roleId,
      roleName: roleId,
      scope: readString(record["scope"]) || "未声明（按交付物自行判断）",
      deliverable,
      acceptance: readString(record["acceptance"]) || "未声明",
      dependsOn: readStringArray(record["dependsOn"]).filter((id) => allowedRoleIds.has(id) && id !== roleId),
    });
  }

  return {
    summary,
    decisions: readStringArray(obj["decisions"]),
    openQuestions: readStringArray(obj["openQuestions"]),
    assignments,
  };
}

/**
 * 解析主持人「推进议程」的输出
 *
 * @param raw 模型原始输出
 * @returns 聚焦点 + 未决问题；无法解析时 null（调用方用立场统计兜底）
 */
export function parseFocus(raw: string): { focus: string; openQuestions: string[] } | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const focus = readString(obj["focus"]);
  if (focus === "") return null;
  return { focus, openQuestions: readStringArray(obj["openQuestions"]) };
}

/**
 * 解析一次修订（回流产出）
 *
 * @param raw 模型原始输出
 * @param allowedRoleIds 合法角色集合
 */
export function parseAmendment(
  raw: string,
  allowedRoleIds: ReadonlySet<string>
): { change: string; affectedRoles: string[] } | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;
  const change = readString(obj["change"]);
  if (change === "") return null;
  return {
    change,
    affectedRoles: readStringArray(obj["affectedRoles"]).filter((id) => allowedRoleIds.has(id)),
  };
}

/** 从执行报告文本里抽「还需要群里回答的问题」 */
export function parseExecutionQuestions(raw: string): string[] {
  const obj = extractJsonObject(raw);
  if (!obj) return [];
  return readStringArray(obj["questions"]);
}

// ============================================================================
// Transcript 格式化
// ============================================================================

/** 单条消息进入 prompt 的字符上限 */
const MESSAGE_CHAR_CAP = 1200;
/** 全部消息进入 prompt 的总字符上限 */
const TRANSCRIPT_CHAR_CAP = 12000;

/**
 * 把 transcript 压成 prompt 可用的文本
 *
 * 策略：**保留最新**。讨论的价值在最近几轮的交锋，而不是开场白。
 * 超长时从最早的发言开始丢，但始终保留 `kind: "opening"` 的消息（任务原文）。
 *
 * @param messages 房间消息
 * @param cap 总字符上限
 */
export function formatTranscript(messages: ReadonlyArray<RoundtableMessage>, cap = TRANSCRIPT_CHAR_CAP): string {
  const lines: string[] = [];
  let used = 0;
  // 倒序累积后反转，实现"保留最新"
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    const tag = m.posture ? `${m.posture}${m.blocking ? "/blocking" : ""}` : m.kind;
    const head = `[${m.id} r${m.round}] ${m.roleName}（${tag}）`;
    const body = m.content.length > MESSAGE_CHAR_CAP ? `${m.content.slice(0, MESSAGE_CHAR_CAP)}…（截断）` : m.content;
    const block = `${head}\n${body}`;
    if (used + block.length > cap && m.kind !== "opening") break;
    lines.push(block);
    used += block.length;
  }
  return lines.reverse().join("\n\n");
}

// ============================================================================
// Prompt 构建
// ============================================================================

/** 群聊共同规则（每个角色发言时都注入） */
const ROOM_RULES = `## 群聊规则（Roundtable）

你正在参加一场多角色会议，目标是与其他角色对同一任务达成可执行的共识。

发言要求（必须遵守）：
1. 只输出**一个 JSON 对象**，不要输出 JSON 之外的解释文字。
2. 字段：
   - "posture": "support" | "refine" | "object"
     - support：你同意当前草案，可以照此执行
     - refine：方向认同，但有具体补充或修正意见
     - object：你反对，认为方案不可行
   - "blocking": true | false（仅当 posture=object 时可为 true，表示「不解决这个问题就不能开工」）
   - "replyTo": 上一轮具体某条消息的 id（形如 "m3"），表明你在回应谁
   - "keyPoints": 字符串数组，每条一句话，最多 4 条
   - "questions": 字符串数组，你还需要别人回答的问题（没有就空数组）
   - "content": 面向其他角色的发言正文，2-6 句
3. 不要重复别人已经说过且你认同的内容，直接说你的增量判断。
4. 有分歧就明说，不要为了和气而假意 support——假共识会在执行阶段付出更大代价。`;

/**
 * 构建角色发言的 system prompt
 *
 * 复用 `composeSystemPrompt` 的语义（角色 prompt + 任务上下文 + 项目根），
 * 但这里手写拼接而不调用它：群聊的"任务上下文"是会议目标 + 你的分工，
 * 不是 TaskRequirement，强行塞进 buildTask 会让 taskId 等字段失真。
 *
 * @param role 发言角色
 * @param projectRoot 项目根
 * @param selfAssignment 该角色的分工（讨论阶段为空）
 */
export function buildSpeechSystemPrompt(
  role: RoleDefinition,
  projectRoot: string,
  selfAssignment?: RoundtableAssignment
): string {
  const parts: string[] = [role.systemPromptPrefix];
  if (role.systemPromptSuffix) {
    parts.push(`\n## 角色后置约束\n\n${role.systemPromptSuffix}\n`);
  }
  parts.push(`\n## 你的身份\n\n你在本场会议的 roleId 是 \`${role.roleId}\`，名称「${role.name}」。\n`);
  if (selfAssignment) {
    parts.push(
      `\n## 你在共识中的分工\n` +
        `- 范围：${selfAssignment.scope}\n` +
        `- 交付物：${selfAssignment.deliverable}\n` +
        `- 验收：${selfAssignment.acceptance}\n` +
        (selfAssignment.dependsOn.length > 0 ? `- 依赖：${selfAssignment.dependsOn.join("、")}\n` : "")
    );
  }
  parts.push(`\n## 项目根目录\n\n\`${projectRoot}\`\n`);
  parts.push(`\n${ROOM_RULES}\n`);
  return parts.join("");
}

/**
 * 构建角色发言的 user prompt
 *
 * @param params.task 会议目标
 * @param params.transcript 已格式化的 transcript
 * @param params.round 当前轮次
 * @param params.focus 主持人给出的本轮聚焦点
 * @param params.selfAssignment 该角色的分工（若无）
 * @param params.selfUpdate 该角色上一轮的任务再表达（若有）
 */
export function buildSpeechUserPrompt(params: {
  task: string;
  transcript: string;
  round: number;
  focus: string;
  selfAssignment?: RoundtableAssignment;
  selfUpdate?: RoundtableTaskUpdate;
}): string {
  const sections: string[] = [];
  sections.push(`# 会议目标\n\n${params.task}`);
  if (params.round === 1) {
    sections.push(`# 当前进度\n\n这是第 1 轮讨论。请先独立给出你的判断，不要假设别人已经同意你。`);
  } else {
    sections.push(
      `# 当前进度\n\n这是第 ${params.round} 轮讨论。上一轮的争议点与议程如下：\n${params.focus}\n\n` +
        `请针对这些点表态，并用 replyTo 指明你在回应哪条消息。`
    );
  }
  if (params.transcript.trim() !== "") {
    sections.push(`# 讨论记录（由早到晚）\n\n${params.transcript}`);
  }
  if (params.selfAssignment) {
    sections.push(
      `# 你的分工（供你判断本文档是否覆盖了你的工作）\n\n` +
        `- 范围：${params.selfAssignment.scope}\n` +
        `- 交付物：${params.selfAssignment.deliverable}\n` +
        `- 验收：${params.selfAssignment.acceptance}\n`
    );
  }
  if (params.selfUpdate) {
    sections.push(`# 你此前对任务的理解\n\n${params.selfUpdate.restated}`);
  }
  sections.push(`现在输出你的 JSON 发言。`);
  return sections.join("\n\n");
}

/** 构建主持人「推进议程」的 user prompt */
export function buildModeratorFocusPrompt(params: {
  task: string;
  transcript: string;
  round: number;
  verdictSummary: string;
}): string {
  return [
    `# 会议目标\n\n${params.task}`,
    `# 第 ${params.round} 轮结束后的立场统计\n\n${params.verdictSummary}`,
    `# 讨论记录\n\n${params.transcript}`,
    `你是主持人。请只做两件事：\n` +
      `1. 归纳本轮尚未解决的分歧（具体到"谁在什么点上不同意"）；\n` +
      `2. 给出下一轮的聚焦问题（不超过 3 条，每条一句话，必须可被回答）。\n\n` +
      `输出一个 JSON 对象：{"focus": "下一轮聚焦点（可多行）", "openQuestions": ["..."]}\n` +
      `不要输出 JSON 之外的文字，也不要替其他角色表态。`,
  ].join("\n\n");
}

/** 构建主持人「起草决议 + 分工」的 user prompt */
export function buildModeratorDecisionPrompt(params: {
  task: string;
  transcript: string;
  participantIds: string[];
}): string {
  return [
    `# 会议目标\n\n${params.task}`,
    `# 讨论记录\n\n${params.transcript}`,
    `# 参与者 roleId\n\n${params.participantIds.join("、")}`,
    `讨论已经收敛。请起草最终决议与任务分工。\n\n` +
      `输出一个 JSON 对象：\n` +
      `{\n` +
      `  "summary": "共识正文，3-6 行，说明最终采用什么方案、关键取舍是什么",\n` +
      `  "decisions": ["逐条决议，每条一个可验证的事实或约束"],\n` +
      `  "openQuestions": ["仍未决、需要人类拍板的问题，没有就空数组"],\n` +
      `  "assignments": [\n` +
      `    {\n` +
      `      "roleId": "必须是上面参与者之一",\n` +
      `      "scope": "执行边界：允许改动的文件/模块/目录",\n` +
      `      "deliverable": "交付物",\n` +
      `      "acceptance": "验收标准（该角色如何自证完成）",\n` +
      `      "dependsOn": ["依赖的 roleId，无则空数组"]\n` +
      `    }\n` +
      `  ]\n` +
      `}\n\n` +
      `约束：\n` +
      `- 每个参与者最多一条分工，不要给不在列表里的角色派活；\n` +
      `- scope 必须具体到路径或模块，不要写"相关代码"这类空话；\n` +
      `- 分工之间如果存在先后依赖，用 dependsOn 表达。\n` +
      `不要输出 JSON 之外的文字。`,
  ].join("\n\n");
}

/** 构建「角色再表达自己任务」的 user prompt */
export function buildTaskUpdatePrompt(params: {
  task: string;
  decisionSummary: string;
  assignment: RoundtableAssignment;
  allAssignments: ReadonlyArray<RoundtableAssignment>;
}): string {
  const peers = params.allAssignments
    .filter((item) => item.roleId !== params.assignment.roleId)
    .map((item) => `- ${item.roleId}: ${item.deliverable}（范围：${item.scope}）`)
    .join("\n");
  return [
    `# 会议目标\n\n${params.task}`,
    `# 已达成共识\n\n${params.decisionSummary}`,
    `# 派给你的任务\n\n` +
      `- 范围：${params.assignment.scope}\n` +
      `- 交付物：${params.assignment.deliverable}\n` +
      `- 验收：${params.assignment.acceptance}\n` +
      (params.assignment.dependsOn.length > 0 ? `- 依赖：${params.assignment.dependsOn.join("、")}\n` : ""),
    peers !== "" ? `# 其他人的任务（供你判断边界重叠）\n\n${peers}` : `# 其他人的任务\n\n（无）`,
    `请用你自己的话复述这项任务，并给出执行步骤。如果发现共识有漏洞、边界不清或与他人冲突，` +
      `把 needDiscussion 设为 true 并在 question 里写清要群里回答什么。\n\n` +
      `输出一个 JSON 对象：\n` +
      `{"restated": "我理解我的任务是……", "steps": ["步骤1", "步骤2"], "acceptance": "我如何自证完成", ` +
      `"needDiscussion": false, "question": ""}\n` +
      `不要输出 JSON 之外的文字。`,
  ].join("\n\n");
}

/**
 * 构建交给 `executeDispatch` 的执行描述
 *
 * 执行阶段走 dispatch 而不是这里的 callLlmOnce，是为了拿到工具能力与审批/护栏；
 * 但 dispatch 的 user prompt 是"任务描述"，所以要把共识 + 分工 + 任务再表达压进去。
 */
export function buildExecutionDescription(params: {
  task: string;
  decisionSummary: string;
  decisions: string[];
  assignment: RoundtableAssignment;
  selfUpdate: RoundtableTaskUpdate;
  amendments: ReadonlyArray<{ question: string; change: string }>;
}): string {
  const parts: string[] = [];
  parts.push(`## 会议共识\n\n${params.decisionSummary}`);
  if (params.decisions.length > 0) {
    parts.push(`### 决议条目\n\n${params.decisions.map((d) => `- ${d}`).join("\n")}`);
  }
  parts.push(
    `### 你的分工\n\n- 范围：${params.assignment.scope}\n- 交付物：${params.assignment.deliverable}\n` +
      `- 验收：${params.assignment.acceptance}`
  );
  parts.push(
    `### 你对任务的理解\n\n${params.selfUpdate.restated}\n\n执行步骤：\n` +
      params.selfUpdate.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
  );
  if (params.amendments.length > 0) {
    parts.push(
      `### 群聊后续修订（以此为准）\n\n` +
        params.amendments.map((a) => `- 问题：${a.question}\n  修订：${a.change}`).join("\n")
    );
  }
  parts.push(
    `## 执行要求\n\n` +
      `1. 只在上面「范围」内改动，越界改动视为失败；\n` +
      `2. 完成后必须输出一个 JSON 对象作为结尾：\n` +
      `   {"summary": "做了什么、结果如何", "filesTouched": ["路径"], "questions": ["还需要群里回答的问题"]}\n` +
      `3. 如果有无法自行决定的问题，不要猜——把问题写进 questions，其余部分照常完成。`
  );
  parts.push(`## 原始会议目标\n\n${params.task}`);
  return parts.join("\n\n");
}

/** 构建回流（amendment）的 user prompt */
export function buildAmendmentPrompt(params: {
  task: string;
  decisionSummary: string;
  question: string;
  askerRoleId: string;
  executionSummary: string;
  participantIds: string[];
}): string {
  return [
    `# 会议目标\n\n${params.task}`,
    `# 已达成的共识\n\n${params.decisionSummary}`,
    `# 执行阶段出现的问题\n\n提问角色：${params.askerRoleId}\n执行摘要：${params.executionSummary}\n问题：${params.question}`,
    `# 参与者 roleId\n\n${params.participantIds.join("、")}`,
    `你是主持人，需要就这个问题给出**对共识的修订**，让受影响角色可以继续执行。\n\n` +
      `输出一个 JSON 对象：\n` +
      `{"change": "对共识的具体修订（可执行，不要写'再讨论'）", "affectedRoles": ["需要按修订重跑的角色 roleId"]}\n` +
      `要求：\n` +
      `- change 必须给出明确取舍，不要含糊表述；\n` +
      `- 如果这个问题必须人类决定，change 写清"需要人类决定：…"，affectedRoles 留空。\n` +
      `不要输出 JSON 之外的文字。`,
  ].join("\n\n");
}
