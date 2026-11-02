/**
 * 对话内全局搜索（2026-11-02）
 *
 * ## 为什么要有这一层
 *
 * 对话流里的信息大部分**不在视野内**：思考过程默认收在折叠区、工具结果收在
 * `<details>` 里（写文件、跑命令的痕迹全在那里）、执行计划只显示最新一版、
 * 后台任务日志默认收起。「我记得刚才改过那个文件」在页面上却搜不到——因为浏览器
 * 自带的查找只认已渲染进 DOM 的文本，折叠区里的内容虽然渲染了却难以逐个展开。
 *
 * 所以搜索必须建立在**数据层**（`ChatEntry`）而不是 DOM 上：这里把条目归一化成
 * 「可搜索文档」，UI 只负责渲染命中与跳转。这样折叠/未折叠、实时/历史两条路径
 * 行为完全一致。
 *
 * ## 覆盖范围
 *
 * | 类别 | 数据来源 |
 * |---|---|
 * | user | 用户消息正文、附件名、指令注入原文 |
 * | assistant | 助手正文（原始 content，含工具结果 JSON 块，宁可噪不可漏） |
 * | thinking | 思考过程（流式累积的那份，刷新后引擎不持久化故可能为空） |
 * | tool | 工具名 + 可读输出（`extractToolText`），无可读文本时回退原始 JSON |
 * | plan | 执行计划正文与变更说明、后台任务命令与日志尾 |
 *
 * 定义加载提示条（智能体 / 技能）只索引**名称与 `@token`**，不索引定义原文：
 * 原文是几千字的角色约束（准则清单），收录进来会让每个常见词都命中一堆噪音，
 * 与把定义折叠起来的初衷相悖。
 *
 * 权限卡片不含可检索文本，刻意不入索引。
 *
 * @module web/search
 */

import type { ChatEntry } from "./chat-model";
import { extractToolText } from "./chat-model";
import { agentDisplayName } from "./agent-display";

/** 搜索类别（UI 筛选维度） */
export type SearchCategory = "user" | "assistant" | "thinking" | "tool" | "plan";

/** 全部类别的固定顺序（筛选栏渲染顺序） */
export const SEARCH_CATEGORIES: ReadonlyArray<SearchCategory> = Object.freeze([
  "user",
  "assistant",
  "thinking",
  "tool",
  "plan",
]);

/** 类别中文名 */
export const SEARCH_CATEGORY_LABELS: Record<SearchCategory, string> = Object.freeze({
  user: "我的输入",
  assistant: "模型输出",
  thinking: "思考",
  tool: "工具与文件",
  plan: "计划与报告",
});

/** 一条可搜索文档（条目 → 一个或多个文档） */
export interface SearchDocument {
  /** 归属条目 id（跳转锚点） */
  entryId: string;
  /** 内容类别 */
  category: SearchCategory;
  /** 展示用来源标签（如「工具：write_file」） */
  label: string;
  /** 参与匹配的完整文本 */
  text: string;
}

/** 一条命中（每条文档最多一条，保证跳转可预期） */
export interface SearchHit {
  /** 归属条目 id（跳转锚点） */
  entryId: string;
  /** 内容类别 */
  category: SearchCategory;
  /** 展示用来源标签 */
  label: string;
  /** 命中片段（空白已折叠为单空格，首尾可能带省略号） */
  snippet: string;
  /** 命中词在 snippet 内的起始偏移（用于片段内高亮） */
  snippetMatchStart: number;
  /** 命中词长度（snippet 内） */
  snippetMatchLength: number;
  /** 命中词在文档 text 内的起始偏移（排序 / 后续跳转用） */
  index: number;
  /** 本条文档命中的全部关键词（多关键词 AND 匹配） */
  matchedTerms: string[];
}

/** snippet 上下文半径（命中词两侧各保留的字符数） */
const SNIPPET_RADIUS = 44;

/** snippet 硬上限（避免超长单行撑破面板） */
const SNIPPET_MAX = 160;

/**
 * 折叠空白：连续换行/缩进压成单空格
 *
 * 代码块与工具输出里的换行在单行片段里没有意义，只会让片段变成一行怪异的空白。
 *
 * @param text 原文
 * @returns 折叠后的文本
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * 从一篇文章里切出命中片段
 *
 * 截断边界用「字符数」而不是「词边界」：中文没有空格分词，按词切会把命中词
 * 所在的句子整段截掉。超出上限时再强制裁到 SNIPPET_MAX。
 *
 * @param text 完整文本
 * @param start 命中词起始偏移
 * @param length 命中词长度
 * @returns 片段与片段内高亮区间
 */
function buildSnippet(
  text: string,
  start: number,
  length: number
): { snippet: string; snippetMatchStart: number; snippetMatchLength: number } {
  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.length, start + length + SNIPPET_RADIUS);
  const prefix = collapseWhitespace(text.slice(from, start));
  // 命中词本身也可能含空白（多词查询），同样折叠后再计长度
  const match = collapseWhitespace(text.slice(start, start + length));
  const suffix = collapseWhitespace(text.slice(start + length, to));
  const leading = from > 0 ? "…" : "";
  const trailing = to < text.length ? "…" : "";
  let snippet = `${leading}${prefix}${match}${suffix}${trailing}`;
  let snippetMatchStart = leading.length + prefix.length;
  if (snippet.length > SNIPPET_MAX) {
    // 超上限：以命中词为中心重新裁切，尽量保留两侧上下文
    const keepLeft = Math.max(0, Math.min(prefix.length, SNIPPET_MAX - match.length - 2));
    const left = prefix.slice(prefix.length - keepLeft);
    const rightBudget = Math.max(0, SNIPPET_MAX - match.length - keepLeft - 2);
    const right = suffix.slice(0, rightBudget);
    snippet = `…${left}${match}${right}…`;
    snippetMatchStart = 1 + left.length;
  }
  return { snippet, snippetMatchStart, snippetMatchLength: match.length };
}

/**
 * 把对话条目归一化为可搜索文档
 *
 * 一条 `ChatEntry` 可能产出多条文档（助手消息的正文与思考分属两个类别），
 * 这样筛「只看思考」时才不会把正文命中一并带出来。
 *
 * @param entries 对话流条目（App 持有的那份）
 * @returns 文档列表（顺序与条目顺序一致，便于结果按对话顺序排列）
 */
export function buildSearchDocuments(entries: ReadonlyArray<ChatEntry>): SearchDocument[] {
  const docs: SearchDocument[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        // 附件名单独拼一段：用户常按文件名回忆「我当时发了哪个文件」
        const attachments = entry.attachments.map((a) => a.name).join(" ");
        const text =
          entry.text === "" ? attachments : attachments === "" ? entry.text : `${entry.text}\n${attachments}`;
        docs.push({ entryId: entry.id, category: "user", label: "我的输入", text });
        break;
      }
      case "steering": {
        docs.push({ entryId: entry.id, category: "user", label: "指令注入", text: entry.text });
        break;
      }
      case "assistant": {
        // 正文用原始 content：工具结果 JSON 块里有文件路径与命令，属于用户要找的东西；
        // 可读化（humanizeEngineContent）会丢掉部分字段，搜索阶段不宜先做有损转换
        const body = entry.content ?? entry.preview ?? "";
        if (body !== "") {
          docs.push({ entryId: entry.id, category: "assistant", label: "模型输出", text: body });
        }
        if (entry.thinking !== undefined && entry.thinking !== "") {
          docs.push({ entryId: entry.id, category: "thinking", label: "思考过程", text: entry.thinking });
        }
        break;
      }
      case "tool": {
        // 可读输出优先（write/edit/bash 的结果都在这里）；取不到时回退原始事件 JSON，
        // 宁可片段里出现 JSON 也不能让「改了哪个文件」搜不到
        const readable = extractToolText(entry.raw);
        const text = readable ?? JSON.stringify(entry.raw);
        docs.push({ entryId: entry.id, category: "tool", label: `工具：${entry.label}`, text });
        break;
      }
      case "plan": {
        const parts = [entry.plan];
        if (entry.explanation !== undefined && entry.explanation !== "") parts.push(entry.explanation);
        docs.push({ entryId: entry.id, category: "plan", label: "执行计划", text: parts.join("\n") });
        break;
      }
      case "bgtask": {
        const n = entry.notice;
        const parts = [n.command, n.exitText, n.outputPath];
        if (n.logTail !== undefined) parts.push(n.logTail);
        if (n.note !== undefined) parts.push(n.note);
        docs.push({ entryId: entry.id, category: "plan", label: "后台任务", text: parts.join("\n") });
        break;
      }
      case "contextLoad": {
        // 只入索引名称与 @token（不入定义原文，理由见文件头注释）：
        // 「我当时加载的是哪个智能体」是可回忆的，定义正文不是
        const display = entry.source === "agent" ? agentDisplayName(entry) : entry.name;
        docs.push({
          entryId: entry.id,
          category: "tool",
          label: entry.source === "agent" ? "已加载智能体" : "已加载技能",
          text: `${display} @${entry.name}`,
        });
        break;
      }
      case "permission":
        // 审批卡片只有工具名与参数摘要，属于操作而非内容，不入索引
        break;
      default:
        break;
    }
  }
  return docs;
}

/** 搜索选项 */
export interface SearchOptions {
  /** 仅在这些类别内匹配（缺省 / 空数组 = 全部） */
  categories?: ReadonlyArray<SearchCategory>;
  /** 命中上限（缺省 200，防止超长会话把面板撑爆） */
  limit?: number;
}

/**
 * 关键词切分
 *
 * 空格分隔 → 多关键词 AND。中文用户常直接输入整句，此时退化为单关键词子串匹配，
 * 仍然可用；不做分词是为了「搜什么就匹配什么」，避免分词器把文件路径切碎。
 *
 * @param query 原始查询串
 * @returns 小写化后的关键词列表（已去重、去空）
 */
export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = raw.trim();
    if (term === "" || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/**
 * 在文档集合里搜索
 *
 * 文档只扫描一次：先按类别过滤，再逐个关键词 `indexOf`（区分大小写归一到小写，
 * 对中英文都成立）。全部关键词都命中才算命中（AND），片段以最早出现的那个
 * 关键词为中心。
 *
 * @param documents 文档集合（`buildSearchDocuments` 的产物）
 * @param query 查询串
 * @param options 类别过滤与上限
 * @returns 命中列表（按文档顺序，即对话顺序）
 */
export function searchDocuments(
  documents: ReadonlyArray<SearchDocument>,
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];
  const allowed =
    options.categories !== undefined && options.categories.length > 0 ? new Set(options.categories) : null;
  const limit = options.limit ?? 200;
  const hits: SearchHit[] = [];

  for (const doc of documents) {
    if (allowed !== null && !allowed.has(doc.category)) continue;
    const haystack = doc.text.toLowerCase();
    let earliest = -1;
    let earliestTerm = "";
    let allMatched = true;
    for (const term of terms) {
      const at = haystack.indexOf(term);
      if (at < 0) {
        allMatched = false;
        break;
      }
      if (earliest < 0 || at < earliest) {
        earliest = at;
        earliestTerm = term;
      }
    }
    if (!allMatched || earliest < 0) continue;

    const { snippet, snippetMatchStart, snippetMatchLength } = buildSnippet(doc.text, earliest, earliestTerm.length);
    hits.push({
      entryId: doc.entryId,
      category: doc.category,
      label: doc.label,
      snippet,
      snippetMatchStart,
      snippetMatchLength,
      index: earliest,
      matchedTerms: terms,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 便捷入口：条目 → 文档 → 搜索（UI 通常直接用这个） */
export function searchEntries(
  entries: ReadonlyArray<ChatEntry>,
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  if (query.trim() === "") return [];
  return searchDocuments(buildSearchDocuments(entries), query, options);
}

/**
 * 按类别统计命中数（筛选栏角标）
 *
 * @param hits 命中列表
 * @returns 每个类别（含 0 的类别由调用方补）的条数
 */
export function countHitsByCategory(hits: ReadonlyArray<SearchHit>): Record<SearchCategory, number> {
  const counts: Record<SearchCategory, number> = {
    user: 0,
    assistant: 0,
    thinking: 0,
    tool: 0,
    plan: 0,
  };
  for (const hit of hits) counts[hit.category] += 1;
  return counts;
}
