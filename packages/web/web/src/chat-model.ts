/**
 * 对话流条目模型：历史消息（REST）与 SSE 事件归并后的统一 UI 模型。
 * App 持有 entries 数组并按事件追加/更新，ChatPane 只负责渲染。
 */
import type { PermissionRequest } from "./sse";

/** 用户消息附件（发送时的本地文件 / 从文件抽屉插入的服务器路径） */
export interface UserAttachment {
  /** 展示名（文件名或路径） */
  name: string;
  /** 来源：local=本地选择/粘贴的文件；server=文件抽屉插入的服务器路径 */
  source: "local" | "server";
  /** 是否图片（决定走 imageUrls 还是文本引用） */
  image: boolean;
}

/** 对话流条目（按时间序渲染） */
export type ChatEntry =
  /** 用户消息：乐观上屏（先展示后等待 202） */
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: UserAttachment[];
      createTime?: string;
      /**
       * 受理模式角标（docs/dev/web-steering.md F2）：
       * 仅运行中发送的补充指令在 202 受理后打标——
       * steered = 已注入当前任务；queued = 排队中。空闲首发消息不打标。
       */
      mode?: "steered" | "queued";
      /**
       * 该用户消息来自 SSE user_message 帧（其他订阅者广播，docs/dev/web-steering.md F3）。
       * 发送者本人的乐观气泡不带此标记——历史恢复时广播帧与乐观消息同源，
       * openChat 合并按此标记去重，避免刷新后同一条消息出现两个气泡。
       */
      fromBroadcast?: boolean;
    }
  /** 助手消息：content 为完整文本（经 A2UI 渲染）；preview 为流式纯文本预览 */
  | {
      kind: "assistant";
      id: string;
      content: string | null;
      preview: string | null;
      /**
       * 流式阶段的思考过程（docs/dev/web-thinking-display.md F1）：
       * llm_delta.thinkingText 独立通道（换行保留），ChatPane 渲染为
       * 可折叠「思考过程」；正式消息（assistant_message）完成后缺省。
       */
      thinking?: string;
      /**
       * 本条为「思考中」占位气泡（萤火虫闪烁）：轮次开始（status processing /
       * llm_delta start 无 thinkingText）时上屏，首个 thinking/正文内容或
       * assistant_message 到达时被替换。修复工具批次结束后新请求窗口期
       * 界面无任何指示、看似卡死的问题。
       */
      thinkingPending?: boolean;
      /** 本条消息是否已终结（收到 assistant_message 后为 true） */
      done: boolean;
    }
  /**
   * 指令注入分隔条（docs/dev/web-steering.md F3/F4）：
   * system 消息且 meta.steeringInject === true（实时 SSE 帧与历史 DTO 两路径），
   * 渲染「指令注入」样式，与技能目录/plan-mode 等常规 system 消息区分。
   */
  | {
      kind: "steering";
      id: string;
      text: string;
    }
  /** 工具执行进度：折叠条目，raw 保留事件原始字段（不丢信息） */
  | {
      kind: "tool";
      id: string;
      label: string;
      status: string;
      raw: Record<string, unknown>;
    }
  /**
   * 执行计划卡片（UpdatePlan 工具）：引擎每次以完整 Markdown 任务列表
   * 覆盖上一版计划，前端只渲染最新态——状态图标 + 进度统计 + 可折叠清单。
   * 实时（tool_progress）与历史恢复（role=tool 消息）两路径同源生成。
   */
  | {
      kind: "plan";
      id: string;
      /** 计划 Markdown 原文（任务列表，[ ]/[>]/[x] 复选框 + 有序/无序列表混排） */
      plan: string;
      /** 可选的变更说明（UpdatePlan 的 explanation 参数） */
      explanation?: string;
    }
  /**
   * 后台任务完成/失败通知卡片（引擎 addBackgroundProcessCompletionMessage）：
   * 引擎以 system 消息（visible=true）推送
   * `Background command "…" failed with signal SIGKILL after 7m 52s. Output: …`
   * + 可选 `<background_task_failure_log>` 日志尾切片。整段文本经 Markdown/A2UI
   * 渲染会命令换行碎裂、日志标签暴露——归并为专用卡片（状态/命令/输出/耗时 +
   * 可折叠日志尾）。实时 SSE system 帧与历史恢复（role=system DTO）两路径同源生成。
   */
  | {
      kind: "bgtask";
      id: string;
      /** 通知载荷（parseBackgroundTaskNotice 解析结果） */
      notice: BackgroundTaskNotice;
    }
  /** 内联权限审批卡片 */
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      decided?: "allow" | "deny";
      /** 决策提交中（防重复点击） */
      submitting: boolean;
    };

/**
 * 括号平衡扫描提取下一个顶层 JSON 块。
 *
 * 从 fromIndex 起找到第一个 '{'，逐字符扫描至深度归零（跳过字符串字面量与
 * 转义字符内的括号），返回 [块文本, 块起始索引, 块结束后的下一个索引]；
 * 无完整块返回 null。
 *
 * @param content 混排文本
 * @param fromIndex 扫描起始索引
 * @returns [JSON 块文本, 块起始索引, 结束后索引] 或 null
 */
function scanJsonBlock(content: string, fromIndex: number): [string, number, number] | null {
  const start = content.indexOf("{", fromIndex);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      // 字符串内：转义字符跳过下一字符；引号关闭字符串
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return [content.slice(start, i + 1), start, i + 1];
      }
    }
  }
  return null; // 括号不平衡（截断块）：按普通文本处理
}

/**
 * 从字符串中提取可渲染的 JSON 载荷（双重序列化输出解包）。
 *
 * 引擎部分工具（如 query_execution_history）的 output 本身就是序列化
 * JSON 字符串（嵌套双重序列化）；直接显示全是转义 JSON。若字符串
 * trim 后可解析为对象/数组，返回 JSON.stringify(null,2) 的格式化文本
 * （前端 <pre> 等宽渲染，可读性等同结构化视图）；非 JSON 或解析失败
 * 返回 null，调用方按原文显示。
 *
 * @param value 待检测字符串（如工具 output 原文）
 * @returns 格式化 JSON 文本；非 JSON 载荷返回 null
 */
export function extractJsonPayload(value: string): string | null {
  const trimmed = value.trim();
  // 快速路径：非 {/[ 开头（且非引号包裹的序列化字符串）必非 JSON 载荷
  const startsJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const startsQuoted = trimmed.startsWith('"');
  if (!startsJson && !startsQuoted) return null;
  try {
    let parsed: unknown = JSON.parse(trimmed);
    // 引号包裹的序列化字符串（如 "\"{ ... }\""）：再解一层，仍非对象/数组则放弃
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从工具结果对象提取单条可读文本。
 *
 * 字段优先级：output → result → content（引擎工具结果的常见文本字段）；
 * 字段值若为序列化 JSON（工具输出的双重序列化形态）则格式化为缩进 JSON；
 * metadata 中的异常信号（非零退出码/信号/截断/超时）附加为尾部方括号注记。
 *
 * @param obj 工具结果对象（如 { ok, name, output, metadata }）
 * @returns 可读文本；无可提取文本字段时返回 null
 */
function toolResultToText(obj: Record<string, unknown>): string | null {
  const output =
    typeof obj.output === "string"
      ? obj.output
      : typeof obj.result === "string"
        ? obj.result
        : typeof obj.content === "string"
          ? obj.content
          : null;
  if (output === null) return null;
  // 双重序列化（output 本身是 JSON 文本）：格式化缩进显示，转义壳全部消除
  const formatted = extractJsonPayload(output);
  const display = formatted ?? output;
  const meta =
    typeof obj.metadata === "object" && obj.metadata !== null ? (obj.metadata as Record<string, unknown>) : {};
  // 异常信号注记：正常完成（exitCode=0 且无异常标记）不加噪音
  const notes: string[] = [];
  if (typeof meta.exitCode === "number" && meta.exitCode !== 0) notes.push(`退出码 ${meta.exitCode}`);
  if (typeof meta.signal === "string" && meta.signal !== "" && meta.signal !== "null")
    notes.push(`信号 ${meta.signal}`);
  if (meta.truncated === true) notes.push("输出已截断");
  if (meta.timedOut === true) notes.push("执行超时");
  return notes.length > 0 ? `${display}\n[${notes.join("，")}]` : display;
}

/**
 * 解析「JSON 块与自然文本混排」的工具 content 为可读文本段列表。
 *
 * 引擎历史中的工具结果常为多个序列化 JSON 块 + 尾部自然文本（如助手注释）
 * 混排。每块若能解析出含 output/result/content 文本字段的对象则提取为文本，
 * 否则块原样保留；块间自然文本原样保留。
 *
 * @param content 混排原文
 * @returns 可读文本段数组（空段已过滤；至少包含原样回退段）
 */
function parseMixedJsonBlocks(content: string): string[] {
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const scanned = scanJsonBlock(content, cursor);
    if (scanned === null) {
      // 剩余无 JSON 块：全部按自然文本保留
      const rest = content.slice(cursor).trim();
      if (rest !== "") segments.push(rest);
      break;
    }
    const [blockText, startIndex, nextIndex] = scanned;
    // 块前的自然文本
    const before = content.slice(cursor, startIndex).trim();
    if (before !== "") segments.push(before);
    // 块本身：解析成功且含文本字段 → 提取；否则原样保留（信息不丢）
    try {
      const parsed: unknown = JSON.parse(blockText);
      const text =
        parsed !== null && typeof parsed === "object" ? toolResultToText(parsed as Record<string, unknown>) : null;
      segments.push(text ?? blockText);
    } catch {
      segments.push(blockText);
    }
    cursor = nextIndex;
  }
  return segments;
}

/**
 * 解析混排文本的开头 JSON 块（工具名标签提取用）。
 *
 * @param content 混排原文
 * @returns 解析成功的块对象；无块或解析失败时返回 null
 */
export function parseLeadingJsonBlock(content: string): Record<string, unknown> | null {
  const scanned = scanJsonBlock(content, 0);
  if (scanned === null) return null;
  try {
    const parsed: unknown = JSON.parse(scanned[0]);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 判断解析出的 JSON 对象是否为「引擎拼接的工具结果块」。
 *
 * 形态一（严格特征）：name 与 output 均为 string——引擎序列化工具结果的
 * 统一形态（如 { ok, name: "bash", output, metadata }）。
 * 形态二（结构指纹）：ok 为 boolean + name 为 string + metadata 为对象——
 * 部分工具（如 UpdatePlan/write）无 output 字段（结果信息在 metadata），
 * 该三元组合是引擎包装结构独有指纹，模型常规输出不会命中。
 * 仅对匹配块做可读化重写，避免误伤模型主动输出的其他 JSON 数据
 * （如 A2UI 指令、模型给出的配置示例）。
 *
 * @param parsed 已解析的 JSON 对象
 * @returns 是否为工具结果块
 */
function isEngineToolResultBlock(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.name === "string" && typeof parsed.output === "string") {
    return true;
  }
  return (
    typeof parsed.ok === "boolean" &&
    typeof parsed.name === "string" &&
    parsed.metadata !== null &&
    typeof parsed.metadata === "object"
  );
}

/**
 * 「本次渲染的工具折叠条目内容指纹」模块级状态（raw.content 文本集合）。
 *
 * 引擎把工具结果同时写入工具消息（前端渲染为折叠条目）与助手正文
 * （JSON 块拼接）。助手正文可读化时据此决定正文引擎块的去留：
 * 条目的 raw 中含相同 JSON 文本（双写同源）→ 正文移除该块（条目负责
 * 展示）；条目不含该块（如 write 类工具块只进正文不落条目）→ 正文
 * 保留可读化兜底，信息不丢。
 * 渲染入口（ChatPane 组件体）每次渲染同步设置，React 单线程模型下
 * humanize 读取必然发生在同帧 set 之后；纯函数（humanize 及调用方）只读。
 */
let engineToolEntryRawTexts: Set<string> = new Set();

/**
 * 设置本次渲染的工具折叠条目指纹（raw.content 文本集合）。
 *
 * @param rawContents 各工具条目 raw.content 字符串（非字符串项忽略）
 */
export function setEngineToolEntryHint(rawContents: string[]): void {
  engineToolEntryRawTexts = new Set(rawContents);
}

/**
 * 判断正文引擎块是否为「已被折叠条目承载」的双写块。
 *
 * 双写判定（顺序短路）：
 * 1. 条目 raw.content 与块文本完全相等 → 同源；
 * 2. 条目 content 包含块文本（条目 content 为多块混排）→ 同源；
 * 3. 内容等价回退：块与条目 content 中的 JSON 解析后深度相等——
 *    引擎对同一结果两处序列化时 key 顺序/缩进可能不同，文本不等但语义同源。
 *
 * @param blockText 正文中的引擎 JSON 块原文
 * @returns 该块是否已由某个工具折叠条目承载
 */
function isBlockCarriedByToolEntry(blockText: string): boolean {
  if (engineToolEntryRawTexts.size === 0) return false;
  // 快速路径：文本完全相等 / 包含关系
  for (const raw of engineToolEntryRawTexts) {
    if (raw === blockText || raw.includes(blockText)) return true;
  }
  // 内容等价回退：解析正文块，与条目 content 中的 JSON 块深度比对
  let blockParsed: unknown;
  try {
    blockParsed = JSON.parse(blockText);
  } catch {
    return false;
  }
  for (const raw of engineToolEntryRawTexts) {
    const scanned = scanJsonBlock(raw, 0);
    if (scanned === null) continue;
    try {
      const entryParsed: unknown = JSON.parse(scanned[0]);
      if (deepEqualJson(entryParsed, blockParsed)) return true;
    } catch {
      // 条目 content 非 JSON 开头：不构成同源
    }
  }
  return false;
}

/**
 * JSON 值深度相等比较（键序无关，用于双写同源的内容等价判定）。
 *
 * @param a 值 A
 * @param b 值 B
 * @returns 是否语义相等
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keysA = Object.keys(oa);
    const keysB = Object.keys(ob);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.prototype.hasOwnProperty.call(ob, k) && deepEqualJson(oa[k], ob[k]));
  }
  return false;
}

/**
 * 将引擎消息文本中的「工具结果 JSON 块」可读化为纯文本（页面渲染前转换）。
 *
 * 背景：引擎在 nonInteractive 模式下会把工具执行结果以序列化 JSON 文本
 * 拼进 assistant 消息（多个 { ok, name, output, metadata } 块 + 助手自然文本
 * 混排），前端 Markdown 原样渲染导致页面大量 JSON。
 *
 * 转换策略（保守，信息不丢）：
 * - ``` 围栏内的代码块原样保留（模型主动输出，不是引擎拼接物）；
 * - 围栏外的裸 JSON 块仅当匹配工具结果特征（name+output 双 string 字段）
 *   时才重写为 output 文本 + metadata 异常注记；其余 JSON 原样保留；
 * - 无 '{' 的纯文本快速路径零开销直通。
 *
 * @param content 引擎 assistant 消息原文
 * @returns 可读化后的文本（无工具结果块时与原文一致）
 */
export function humanizeEngineContent(content: string): string {
  // 快速路径：不含 JSON 块起始符，无需解析
  if (!content.includes("{")) {
    return content;
  }
  // 按 ``` 围栏切段：围栏内（模型代码输出）原样保留，仅处理围栏外段落
  const fencePattern = /```[\s\S]*?(?:```|$)/g;
  const segments: string[] = [];
  // 围栏外可读化后的重复内容去重集合：引擎双写（工具消息 + 正文拼接同一
  // JSON 块）经确定性可读化后产生完全相同的渲染文本，第二次出现直接删除。
  // 围栏段（模型代码输出）不进此逻辑；流式多气泡各自渲染互不影响
  // （每个助手条目独立调用本函数，集合函数内私有）。
  const seenRendered = new Set<string>();
  let cursor = 0;
  for (;;) {
    fencePattern.lastIndex = 0;
    const rest = content.slice(cursor);
    const fenceMatch = fencePattern.exec(rest);
    if (fenceMatch === null) {
      // 剩余无围栏：整段做混排解析
      segments.push(...parseMixedJsonBlocksStrict(rest, seenRendered));
      break;
    }
    const fenceStart = cursor + (fenceMatch.index ?? 0);
    // 围栏前的文本段：混排解析
    segments.push(...parseMixedJsonBlocksStrict(content.slice(cursor, fenceStart), seenRendered));
    // 围栏段本身原样保留（含未闭合到文末的形态）
    segments.push(content.slice(fenceStart, fenceStart + fenceMatch[0].length));
    cursor = fenceStart + fenceMatch[0].length;
    if (cursor >= content.length) break;
  }
  const joined = segments.join("");
  return joined !== "" ? joined : content;
}

/**
 * 混排解析（严格特征版）：仅重写匹配引擎工具结果特征的 JSON 块。
 *
 * 与 parseMixedJsonBlocks 的差异：块必须命中 isEngineToolResultBlock
 * 才提取 output 文本；其余块（含解析失败的截断块）原样保留；
 * 段落间不加空行分隔（保持原文间距，重组后与原文结构一致）；
 * 可读化输出经 seenRendered 集合做跨段去重（引擎双写的同一块只渲染一次）。
 *
 * @param text 待解析文本段
 * @param seenRendered 围栏外可读化文本去重集合（跨段共享，调用方持有）
 * @returns 处理后的文本段列表（按原文顺序拼接）
 */
function parseMixedJsonBlocksStrict(text: string, seenRendered: Set<string>): string[] {
  if (!text.includes("{")) {
    return [text];
  }
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const scanned = scanJsonBlock(text, cursor);
    if (scanned === null) {
      // 无法再提取完整块（流式截断/JSON 字符串解析失败等异常形态）。
      // 关键回退：若剩余文本本身可解析为 JSON 载荷（如 output 内嵌 JSON
      // 导致字符串/括号状态失步后的残留），格式化吸收整段，避免页面泄漏
      // 大片转义 JSON；否则保留剩余原文。
      const tail = text.slice(cursor);
      const formattedTail = extractJsonPayload(tail);
      if (formattedTail !== null) {
        segments.push(formattedTail);
      } else {
        segments.push(tail);
      }
      break;
    }
    const [blockText, startIndex, nextIndex] = scanned;
    segments.push(text.slice(cursor, startIndex));
    try {
      const parsed: unknown = JSON.parse(blockText);
      if (parsed !== null && typeof parsed === "object" && isEngineToolResultBlock(parsed as Record<string, unknown>)) {
        // 双写同源块（工具折叠条目已承载同一结果）：正文直接移除，
        // 折叠条目（label 已含工具名）负责展示，避免正文被工具输出淹没。
        // 非同源块（如 write 类只进正文不落条目）：正文保留可读化兜底。
        if (isBlockCarriedByToolEntry(blockText)) {
          // 必须推进游标：只 continue 不更新 cursor 会导致死循环
          cursor = nextIndex;
          continue;
        }
        const readable = toolResultToText(parsed as Record<string, unknown>);
        // 无可读字段（如无 output 的形态二块）：格式化缩进显示，与原始
        // 内容信息等价但更易读（键值分行、消除单行密集形态）
        const rendered = readable ?? extractJsonPayload(blockText) ?? blockText;
        // 跨段去重：引擎双写的同一块（字节一致）第二次出现直接删除，
        // 只保留首次渲染，消除正文重复刷屏
        if (seenRendered.has(rendered)) {
          cursor = nextIndex;
          continue;
        }
        seenRendered.add(rendered);
        segments.push(rendered);
      } else {
        // 非工具结果块（模型输出数据/A2UI 指令等）：原样保留
        segments.push(blockText);
      }
    } catch {
      segments.push(blockText);
    }
    cursor = nextIndex;
  }
  return segments;
}

/**
 * 从工具条目 raw 中提取可读文本（页面文本渲染优先，JSON 兜底）。
 *
 * raw 形态与处理：
 * - { content }（磁盘历史）：content 为「JSON 块 + 自然文本」混排 → parseMixedJsonBlocks；
 * - { event, item }（实时 tool_progress）：item 优先提取 output/result/content 文本字段；
 * - 均无文本可提取：返回 null，调用方回退渲染原始 JSON（信息不丢失）。
 *
 * @param raw 工具条目原始数据
 * @returns 可读文本；null 表示需回退 JSON 渲染
 */
export function extractToolText(raw: Record<string, unknown>): string | null {
  // 1) 历史形态：content 混排文本
  if (typeof raw.content === "string" && raw.content !== "") {
    const segments = parseMixedJsonBlocks(raw.content);
    if (segments.length === 0) return null;
    const joined = segments.join("\n\n");
    return joined !== "" ? joined : null;
  }
  // 2) 实时形态：item 优先、event 兜底
  for (const key of ["item", "event"]) {
    const obj = raw[key];
    if (obj !== null && typeof obj === "object") {
      const text = toolResultToText(obj as Record<string, unknown>);
      if (text !== null) return text;
    }
  }
  return null;
}

/** UpdatePlan 提取结果（执行计划卡片数据） */
export interface PlanPayload {
  /** 计划 Markdown 原文（非空） */
  plan: string;
  /** 变更说明（UpdatePlan 可选 explanation，缺省 undefined） */
  explanation?: string;
}

/**
 * 从 UpdatePlan 工具结果块中提取执行计划（Markdown 任务列表）。
 *
 * 识别判据（保守，宁缺勿错）：
 * 1. 块 JSON 解析成功且 name === "UpdatePlan"（引擎工具结果统一形态）；
 * 2. metadata.plan 为非空字符串——每次 UpdatePlan 都是「完整任务列表」，
 *    前端只渲染最新态（引擎协议：latest call replaces the previous visible plan）。
 * 非 UpdatePlan 块 / 缺 plan / 空 plan 一律返回 null（条目按普通工具展示）。
 *
 * 兼容两种载荷位置（信息不丢）：
 * - 标准形态：{ ok, name: "UpdatePlan", output, metadata: { plan, explanation } }；
 * - 退化形态（metadata 丢失但 plan 直挂顶层）：{ name: "UpdatePlan", plan }。
 *
 * @param content 工具结果 JSON 文本（历史 content 或实时 item 序列化后）
 * @returns 计划载荷；非 UpdatePlan 或缺计划返回 null
 */
export function extractPlanFromToolContent(content: string): PlanPayload | null {
  const block = parseLeadingJsonBlock(content);
  if (block === null || block.name !== "UpdatePlan") return null;
  // 失败块不渲染计划卡（引擎执行失败时无有效计划态）
  if (block.ok === false) return null;
  // 标准形态：metadata.plan
  const meta =
    typeof block.metadata === "object" && block.metadata !== null ? (block.metadata as Record<string, unknown>) : {};
  const planRaw = typeof meta.plan === "string" ? meta.plan : block.plan;
  if (typeof planRaw !== "string" || planRaw.trim() === "") return null;
  const explanationRaw = typeof meta.explanation === "string" ? meta.explanation : block.explanation;
  const explanation =
    typeof explanationRaw === "string" && explanationRaw.trim() !== "" ? explanationRaw.trim() : undefined;
  return { plan: planRaw, explanation };
}

/** 计划任务行的状态分类（复选框标记 → 图标/进度语义） */
export type PlanTaskStatus = "done" | "active" | "pending";

/** 计划解析结果：单条任务行 */
export interface PlanTaskItem {
  /** 任务文本（已去掉列表符号与复选框标记） */
  text: string;
  /** 状态：done=[x] / active=[>] / pending=[ ] 或无复选框 */
  status: PlanTaskStatus;
  /** 缩进层级（列表嵌套深度，按行首空格估算） */
  depth: number;
}

/**
 * 解析计划 Markdown 为任务行列表（仅处理列表行，非列表行忽略——
 * 标题/段落等结构交给卡片头部与说明区表达，任务行承载进度）。
 *
 * 识别规则：
 * - 无序/有序列表行（- / * / 1.）；
 * - 复选框标记：[x]/[X] → done；[>] → active（进行中）；[ ] → pending；
 * - depth 按行首空格数折算（2 空格一级，上限 3 级防御畸形缩进）。
 *
 * @param plan 计划 Markdown 原文
 * @returns 任务行数组（顺序保持原文；无列表行时为空数组）
 */
export function parsePlanTasks(plan: string): PlanTaskItem[] {
  const items: PlanTaskItem[] = [];
  for (const rawLine of plan.split(/\r?\n/)) {
    // 列表行匹配：可选缩进 + （无序 - * + 或有序 数字. ）+ 内容
    const m = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(rawLine);
    if (m === null) continue;
    const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
    let text = m[2].trim();
    let status: PlanTaskStatus = "pending";
    // 复选框标记（GFM 风格）：[x]/[X]=完成，[>]=进行中，[ ]=待办
    const cb = /^\[([xX> ])\]\s*(.*)$/.exec(text);
    if (cb !== null) {
      status = cb[1] === "x" || cb[1] === "X" ? "done" : cb[1] === ">" ? "active" : "pending";
      text = cb[2].trim();
    }
    if (text !== "") items.push({ text, status, depth });
  }
  return items;
}

/**
 * 后台任务完成/失败通知载荷（引擎
 * addBackgroundProcessCompletionMessage 的 system 消息结构化解析结果）。
 */
export interface BackgroundTaskNotice {
  /** 状态：completed（ok）/ failed（信号或退出码） */
  status: "completed" | "failed";
  /** 状态说明原文（signal SIGKILL / exit code 1 / unknown status / completed） */
  exitText: string;
  /** 后台命令原文（多行，卡片等宽折叠展示） */
  command: string;
  /** 运行时长文本（如 "7m 52s"，引擎 formatBackgroundDuration 产出） */
  duration: string;
  /** 输出日志文件路径 */
  outputPath: string;
  /** 失败日志尾切片（<background_task_failure_log> 标签内原文；完成态无） */
  logTail?: string;
  /** 日志尾是否被引擎截断（"(N bytes)..." 前缀标记） */
  logTruncated?: boolean;
}

/**
 * 解析引擎后台任务通知文本（system 消息 content）。
 *
 * 引擎形态（session.ts addBackgroundProcessCompletionMessage）：
 *   Background command "<cmd>" completed|failed with <exitText> after <dur>. Output: <path>
 *   [<background_task_failure_log path="...">(N bytes)...\n]<log>[/background_task_failure_log]
 * 命令本身可含换行（heredoc / && 续行），正则必须用 [\s\S]+? 跨行匹配；
 * exitText 单行不含 " after "，duration 不含 ". Output:"，均可安全捕获。
 *
 * @param content system 消息原文
 * @returns 结构化载荷；非后台通知文本返回 null（调用方按普通消息渲染）
 */
export function parseBackgroundTaskNotice(content: string): BackgroundTaskNotice | null {
  const m =
    /^Background command "([\s\S]+?)" (completed|failed) with (.+?) after ([^\n]+?)\. Output: (\S+)(?:\n([\s\S]*))?$/m.exec(
      content
    );
  if (m === null) return null;
  const [, command, statusWord, exitText, duration, outputPath, tailRaw] = m;
  const notice: BackgroundTaskNotice = {
    status: statusWord === "completed" ? "completed" : "failed",
    exitText: exitText.trim(),
    command,
    duration,
    outputPath,
  };
  // 引擎字段缺省防御（unknown status 分支不产出 " after …" 段）：不在此类
  // 边缘形态上猜测，交给调用方按普通消息渲染，保证信息不丢
  if (duration.trim() === "" || outputPath === "") return null;
  // 失败日志尾：<background_task_failure_log path="…">…</background_task_failure_log>
  if (typeof tailRaw === "string" && tailRaw.trim() !== "") {
    const log = /<background_task_failure_log path="[^"]*">([\s\S]*?)<\/background_task_failure_log>/.exec(tailRaw);
    let logBody = log !== null ? log[1] : tailRaw.trim();
    // 引擎截断前缀："(N bytes)...\n"（日志超长时仅保留尾部切片）；
    // 标签后可能紧跟换行（引擎 join），前缀匹配前先剥离开头空白
    const trunc = /^\s*\((\d+) bytes\)\.\.\.\n?/.exec(logBody);
    if (trunc !== null) {
      notice.logTruncated = true;
      logBody = logBody.slice(trunc[0].length);
    }
    // 首尾空白规整（标签后换行不进日志体；多行日志内部换行保留）
    notice.logTail = logBody.replace(/^\s+/, "").replace(/\s+$/, "");
  }
  return notice;
}
