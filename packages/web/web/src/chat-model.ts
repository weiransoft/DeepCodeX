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
    }
  /** 助手消息：content 为完整文本（经 A2UI 渲染）；preview 为流式纯文本预览 */
  | {
      kind: "assistant";
      id: string;
      content: string | null;
      preview: string | null;
      /** 本条消息是否已终结（收到 assistant_message 后为 true） */
      done: boolean;
    }
  /** 工具执行进度：折叠条目，raw 保留事件原始字段（不丢信息） */
  | {
      kind: "tool";
      id: string;
      label: string;
      status: string;
      raw: Record<string, unknown>;
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
 * 从工具结果对象提取单条可读文本。
 *
 * 字段优先级：output → result → content（引擎工具结果的常见文本字段）；
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
  const meta =
    typeof obj.metadata === "object" && obj.metadata !== null ? (obj.metadata as Record<string, unknown>) : {};
  // 异常信号注记：正常完成（exitCode=0 且无异常标记）不加噪音
  const notes: string[] = [];
  if (typeof meta.exitCode === "number" && meta.exitCode !== 0) notes.push(`退出码 ${meta.exitCode}`);
  if (typeof meta.signal === "string" && meta.signal !== "" && meta.signal !== "null")
    notes.push(`信号 ${meta.signal}`);
  if (meta.truncated === true) notes.push("输出已截断");
  if (meta.timedOut === true) notes.push("执行超时");
  return notes.length > 0 ? `${output}\n[${notes.join("，")}]` : output;
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
