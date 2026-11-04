/**
 * 自定义 Agent 创建端点（POST /api/agents）：
 *
 * 落盘复用 core SedimentationWriter（五条安全门槛：白名单字段 / kebab-case /
 * 路径牢笼 / 同名拒写 / io 降级），scope=user 落**用户级技能资产根**
 * `<skillsHome>/.deepcode/skills/<name>/SKILL.md`（frontmatter type: agent + role）。
 * 落盘后引擎 SkillManager 扫描链与 @ 提及补全、设置页「智能体」列表、
 * system prompt agent 索引自动可见（同一数据源，零额外注册）。
 *
 * 落盘根由 `skillsHomeForUser()` 解析（2026-11-04），与 GET /api/capabilities
 * 的扫描根**同源**：未显式配置时随 per-user 引擎根隔离（团队服务器），
 * 显式配置时直读直写该路径（桌面壳：本机单用户，与 CLI 同一份技能）。
 *
 * 只做创建：修订/删除后续迭代（同名拒写返回 duplicate-name 结构化原因）。
 */

import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SedimentationWriter,
  createOpenAIClient,
  getUserSettingsPath,
  syncPresetAgents,
  PRESET_AGENT_COUNT,
} from "@vegamo/deepcode-core";
import { readJsonBody, sendJson } from "../http-utils";
import { skillsHomeForUser, type SkillsHomeSettings } from "../engine-home";
import type { AuthContext } from "../user-identity";

/** POST /api/agents 请求体 */
type CreateAgentInput = {
  name?: unknown;
  description?: unknown;
  role?: unknown;
  content?: unknown;
};

/** POST /api/agents/draft 请求体 */
type DraftAgentInput = {
  prompt?: unknown;
};

/** AI 生成草稿的 LLM 调用超时（毫秒） */
const AGENT_DRAFT_TIMEOUT_MS = 120_000;

/** 用户一句话输入长度上限（防止把表单当文档上传） */
const AGENT_DRAFT_PROMPT_MAX = 2000;

/** kebab-case 口径（与 SedimentationWriter / AgentRegistry 一致） */
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 从 LLM 回复文本中解析智能体草稿（WorkBuddy 创建专家同构的输出约定）：
 *
 * 容错策略：剥离 markdown 代码围栏 → 截取首个 `{` 到最后一个 `}` → JSON.parse →
 * 字段逐个校验归一（name 自动 kebab 化，非法字符剔除；字段缺失时给出可读错误）。
 * 任何一步失败都返回 null，由调用方统一映射 502。
 *
 * @param raw LLM 原始回复文本
 * @returns 归一后的草稿；无法解析时 null
 */
export function parseAgentDraftJson(raw: string): {
  name: string;
  description: string;
  role: string;
  content: string;
} | null {
  let text = raw.trim();
  // 剥离 ```json ... ``` / ``` ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence !== null) text = fence[1].trim();
  // 截取 JSON 对象主体（模型偶尔会在前后加说明文字）
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  // name 归一：小写、空白折叠为连字符、剔除非法字符、折叠重复连字符、去首尾连字符
  const rawName = str(obj.name)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const name = rawName.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  const description = str(obj.description);
  const role = str(obj.role);
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (name === "" || !KEBAB_CASE_PATTERN.test(name) || description === "" || role === "") return null;
  return { name, description, role, content };
}

/**
 * 处理 POST /api/agents（已认证）。
 *
 * 校验：name/description 必填字符串（role/content 可选字符串，缺省空串——
 * kind=agent 时 role 必填由 Writer 门槛兜底，返回结构化中文原因）。
 * Writer 任何失败（含 io）都不抛出：统一 4xx + WriteResult 形体返回。
 *
 * 落盘根（2026-11-04）：`skillsHomeForUser()` 解析出的**技能资产根**——
 * 与 GET /api/capabilities 的扫描根同源。此前写死 `os.homedir()`、读侧却按
 * per-user 引擎根扫描，两端错位 → 桌面版「新建的智能体」落在一个目录、列表扫
 * 另一个目录，用户永远看不到自己刚建的东西（并与 CLI 抢同一份文件名）。
 */
export async function handleCreateAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: SkillsHomeSettings
): Promise<void> {
  const body = await readJsonBody<CreateAgentInput>(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (name === "" || description === "") {
    sendJson(res, 400, {
      ok: false,
      reason: "invalid-frontmatter",
      message: "创建智能体失败：name 与 description 必填且不能为空",
    });
    return;
  }

  // Writer 无状态，用现用现建；scope=user 的落盘根由 homeRoot 注入
  // （缺省 os.homedir()；projectRoot 仅 scope=project 才参与根解析）
  const writer = new SedimentationWriter({
    projectRoot: os.homedir(),
    homeRoot: skillsHomeForUser(settings, ctx.userId),
  });
  const result = await writer.write({ kind: "agent", name, description, role, content }, "user");
  if (!result.ok) {
    // 失败形态带结构化 reason：duplicate-name → 409，其余 → 400
    sendJson(res, result.reason === "duplicate-name" ? 409 : 400, result);
    return;
  }
  sendJson(res, 201, result);
}

/** POST /api/agents/default 请求体 */
type SetDefaultAgentInput = {
  /** 智能体名称；空串 = 清除默认（新会话不再自动激活任何角色） */
  name?: unknown;
};

/**
 * 处理 POST /api/agents/default（已认证）：设置 / 清除默认智能体。
 *
 * 落盘位置：用户级 `~/.deepcode/settings.json` 的 `agents.default`——core
 * `resolveCurrentSettings()` 每轮重新解析，因此**改完下一轮即生效，无需重启引擎**。
 *
 * 写入方式为「读 → 改 → 写」，保留文件中其余字段（模型 / MCP / web 配置等），
 * 避免把桌面壳写入的配置覆盖掉（settings.json 是多写入方共享文件）。
 *
 * @param req 请求对象（`{ name: string }`）
 * @param res 响应对象
 * @param _ctx 认证上下文
 */
export async function handleSetDefaultAgent(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthContext
): Promise<void> {
  const body = await readJsonBody<SetDefaultAgentInput>(req);
  const raw = typeof body.name === "string" ? body.name.trim() : "";
  if (raw !== "" && !KEBAB_CASE_PATTERN.test(raw)) {
    sendJson(res, 400, {
      ok: false,
      reason: "invalid-name",
      message: "智能体名称必须为 kebab-case（小写字母/数字/连字符）",
    });
    return;
  }

  const settingsPath = getUserSettingsPath();
  let root: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch (error) {
    // 文件不存在 = 首次设置（正常）；解析失败则拒绝写入，避免覆盖用户手写配置
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      sendJson(res, 409, {
        ok: false,
        reason: "settings-unreadable",
        message: `settings.json 无法解析，已放弃写入以免覆盖现有配置：${settingsPath}`,
      });
      return;
    }
  }

  const existingAgents =
    root["agents"] !== null && typeof root["agents"] === "object" && !Array.isArray(root["agents"])
      ? (root["agents"] as Record<string, unknown>)
      : {};
  if (raw === "") {
    delete existingAgents["default"];
  } else {
    existingAgents["default"] = raw;
  }
  if (Object.keys(existingAgents).length === 0) {
    delete root["agents"];
  } else {
    root["agents"] = existingAgents;
  }

  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      reason: "write-failed",
      message: `写入 settings.json 失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  sendJson(res, 200, { ok: true, defaultAgent: raw === "" ? null : raw });
}

/** 预置智能体导入端点（POST /api/agents/presets，2026-11-02）：
 *
 * core 里原本有两套完整角色资产（5 核心角色 + 30 领域专家）却从未落成文件，
 * 而 Agent 的唯一真相来源是文件扫描——于是「代码里有 35 个智能体，界面里一个
 * 也看不到」。本端点把 `listPresetAgents()` 物化为
 * `~/.deepcode/skills/<name>/SKILL.md`（type: agent），与用户自建智能体同构，
 * 因此落盘后自动出现在能力发现、@ 提及、agent 工具与设置页列表中。
 *
 * 安全边界：默认 `onlyMissing`（不覆盖用户改过的同名文件）；`overwrite: true`
 * 才重写。写入是幂等的，重复调用不会产生副本。
 */

/** POST /api/agents/presets 请求体 */
type ImportPresetsInput = {
  /** true = 覆盖已存在的同名预置文件（默认 false，保留用户修改） */
  overwrite?: unknown;
};

/**
 * 处理 POST /api/agents/presets（已认证）：导入 / 修复预置智能体。
 *
 * 落盘根（2026-11-04）：与 GET /api/capabilities 扫描根同源的**技能资产根**
 * （`skillsHomeForUser()` → `<skillsHome>/.deepcode/skills`）。此前写死
 * `~/.deepcode/skills`、读侧按 per-user 引擎根扫描 → 桌面版导入的 35 个预置
 * 智能体在列表里一个都看不到（"代码里有 35 个智能体，界面里一个也看不到"）。
 *
 * @param req 请求对象（可带 `{ overwrite: boolean }`）
 * @param res 响应对象
 * @param ctx 认证上下文
 * @param settings 归一后的 Web 配置（解析技能资产根）
 */
export async function handleImportPresetAgents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthContext,
  settings: SkillsHomeSettings
): Promise<void> {
  const body = await readJsonBody<ImportPresetsInput>(req).catch(() => ({}) as ImportPresetsInput);
  const overwrite = body.overwrite === true;
  const root = path.join(skillsHomeForUser(settings, ctx.userId), ".deepcode", "skills");
  const result = syncPresetAgents(root, { overwrite });
  // failed 非空时用 207（部分成功）：前端据 written/failed 如实提示，不谎报全成功
  sendJson(res, result.failed.length > 0 ? 207 : 200, {
    ok: result.failed.length === 0,
    total: PRESET_AGENT_COUNT,
    written: result.written.length,
    skipped: result.skipped.length,
    failed: result.failed,
  });
}

/**
 * AI 生成草稿的 system prompt——参考 WorkBuddy 创建专家的方式：
 * 用户只给一句话意图，由 LLM 反推完整的专家定义（名称 / 触发描述 / 角色身份 /
 * 行为规范四件套），输出严格 JSON。四件套与 SKILL.md frontmatter 字段一一对应，
 * 用户在表单里确认/修改后才落盘（human-in-the-loop，草稿端点绝不写盘）。
 */
const AGENT_DRAFT_SYSTEM_PROMPT = `你是资深 AI 智能体（Agent）设计师。用户会用一句话描述想要的智能体，你负责把它扩展为一份完整、专业、可直接使用的智能体定义。

要求：
1. name：kebab-case 英文标识（小写字母/数字/连字符，如 code-reviewer、data-analyst），简洁达意，不超过 40 字符。
2. description：一句中文描述智能体的职责与适用场景（30-80 字），会展示在智能体列表并用于 @ 提及匹配，写清楚"负责什么、擅长什么"。
3. role：角色身份短语（如"资深代码评审工程师"），激活时作为角色约束注入对话。
4. content：行为规范正文（markdown 列表，5-10 条），涵盖：核心职责与工作方式、执行流程（先做什么后做什么）、输出格式要求、边界与约束（不确定时如何处理、禁止事项）。具体、可执行、无空话。

只输出一个 JSON 对象，不要输出任何其他文字：
{"name":"...","description":"...","role":"...","content":"..."}`;

/**
 * 处理 POST /api/agents/draft（已认证）：一句话 → LLM 生成智能体草稿。
 *
 * 参考 WorkBuddy 创建专家的方式：用户一句话意图 → LLM 产出四件套草稿 →
 * 前端填入表单供用户审阅修改 → 用户点创建才走 POST /api/agents 落盘。
 * 本端点只生成草稿，绝不写盘。
 *
 * 错误映射：400 invalid-prompt（空/超长）；503 llm-not-configured（引擎进程
 * 没有 API Key，即 DEEPCODE_API_KEY 未注入）；502 llm-bad-response（调用失败
 * 或回复无法解析为合法草稿）。
 */
export async function handleCreateAgentDraft(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthContext
): Promise<void> {
  const body = await readJsonBody<DraftAgentInput>(req);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt === "" || prompt.length > AGENT_DRAFT_PROMPT_MAX) {
    sendJson(res, 400, {
      ok: false,
      reason: "invalid-prompt",
      message: `请用一句话描述你想创建的智能体（1-${AGENT_DRAFT_PROMPT_MAX} 字）`,
    });
    return;
  }

  // 引擎进程环境持有 DEEPCODE_API_KEY（桌面壳从钥匙串注入）；缺 Key 时
  // client 为 null，快速失败并给出可操作提示，不让用户干等超时
  const llm = createOpenAIClient(os.homedir());
  if (llm.client === null) {
    sendJson(res, 503, {
      ok: false,
      reason: "llm-not-configured",
      message: "模型未配置：引擎缺少 API Key（需在桌面壳登录模型账号后重试）",
    });
    return;
  }

  try {
    const completion = await llm.client.chat.completions.create(
      {
        model: llm.model,
        messages: [
          { role: "system", content: AGENT_DRAFT_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      },
      { signal: AbortSignal.timeout(AGENT_DRAFT_TIMEOUT_MS) }
    );
    const raw = completion.choices[0]?.message?.content ?? "";
    const draft = parseAgentDraftJson(raw);
    if (draft === null) {
      sendJson(res, 502, {
        ok: false,
        reason: "llm-bad-response",
        message: "模型返回内容无法解析为智能体草稿，请调整描述后重试",
      });
      return;
    }
    sendJson(res, 200, { ok: true, draft });
  } catch {
    sendJson(res, 502, {
      ok: false,
      reason: "llm-request-failed",
      message: "模型调用失败（网络或服务异常），请稍后重试",
    });
  }
}
