/**
 * 对话内搜索栏渲染层单测（web/components/ChatSearchBar）
 *
 * 走真实组件渲染（`renderToStaticMarkup`），断言用户可见结构而不是内部实现：
 * - 无查询时只有输入框，不铺开结果面板；
 * - 有命中时按条渲染、当前项高亮、片段内命中词标 <mark>；
 * - 类别筛选条角标与选中态；空类别给出「去全部看」的提示；
 * - 超过渲染上限时截断并提示剩余数量。
 *
 * 交互（点击 / 键盘）由 ChatPane 与组件内的 onKeyDown 承担，这里通过 props 直传
 * 状态来验证各状态下的渲染结果，不引入 DOM 环境。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEntry } from "../web/src/chat-model";
import { searchEntries, type SearchCategory } from "../web/src/search";
import { ChatPane } from "../web/src/components/ChatPane";
import { ChatSearchBar } from "../web/src/components/ChatSearchBar";

/**
 * 构造用户消息条目
 *
 * @param id 条目 id
 * @param text 正文
 * @returns 用户条目
 */
function userEntry(id: string, text: string): ChatEntry {
  return { kind: "user", id, text, attachments: [] };
}

/** 渲染用的默认 props（各用例按需覆盖） */
interface RenderOverrides {
  query?: string;
  hits?: ReturnType<typeof searchEntries>;
  allHits?: ReturnType<typeof searchEntries>;
  activeIndex?: number;
  category?: SearchCategory | null;
}

/**
 * 渲染搜索栏
 *
 * @param overrides 覆盖项
 * @returns 静态 HTML
 */
function renderBar(overrides: RenderOverrides = {}): string {
  const hits = overrides.hits ?? [];
  const allHits = overrides.allHits ?? hits;
  return renderToStaticMarkup(
    <ChatSearchBar
      query={overrides.query ?? ""}
      onQueryChange={() => undefined}
      hits={hits}
      allHits={allHits}
      activeIndex={overrides.activeIndex ?? (hits.length > 0 ? 0 : -1)}
      onActiveIndexChange={() => undefined}
      category={overrides.category ?? null}
      onCategoryChange={() => undefined}
      onClose={() => undefined}
    />
  );
}

// ============================================================================
// U1：空查询
// ============================================================================

test("U1. 无查询时只渲染输入框，不铺结果面板与筛选条", () => {
  const html = renderBar();
  assert.ok(html.includes('class="chat-search-input"'));
  assert.ok(html.includes("搜索对话内容（输入 / 输出 / 思考 / 文件改动 / 报告）"), "占位符应说明搜索范围");
  assert.ok(!html.includes("chat-search-results"), "空查询不渲染结果面板");
  assert.ok(!html.includes("chat-search-filters"), "空查询不渲染类别筛选");
});

test("U1b. 空查询时上下跳转按钮禁用", () => {
  const html = renderBar();
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2, "上一个/下一个都应禁用");
});

// ============================================================================
// U2：命中渲染
// ============================================================================

test("U2. 有命中时按条渲染，当前项带 active 类，片段内命中词标 mark", () => {
  const entries: ChatEntry[] = [userEntry("u1", "帮我改一下 session.ts"), userEntry("u2", "session.ts 还有别的问题")];
  const hits = searchEntries(entries, "session.ts");
  assert.equal(hits.length, 2);

  const html = renderBar({ query: "session.ts", hits });
  assert.equal((html.match(/data-hit-index="/g) ?? []).length, 2);
  assert.ok(html.includes('class="chat-search-hit chat-search-hit-active"'), "首条应为当前项");
  assert.ok(html.includes('<mark class="search-hit-mark">session.ts</mark>'), "命中词应标亮");
  assert.ok(html.includes("我的输入"), "标签应显示内容类别");
  assert.ok(html.includes("1/2"), "计数应显示当前位置");
});

test("U2b. activeIndex 跟随传入值（上下跳转后的渲染）", () => {
  const entries: ChatEntry[] = [userEntry("u1", "关键词 A"), userEntry("u2", "关键词 B")];
  const hits = searchEntries(entries, "关键词");
  const html = renderBar({ query: "关键词", hits, activeIndex: 1 });
  assert.ok(html.includes("2/2"));
  // 只有第二条带 active
  const activeCount = (html.match(/chat-search-hit-active/g) ?? []).length;
  assert.equal(activeCount, 1);
  assert.ok(
    html.indexOf('data-hit-index="1"') < html.indexOf("chat-search-hit-active"),
    "active 类应出现在第二条命中元素上"
  );
});

// ============================================================================
// U3：类别筛选
// ============================================================================

test("U3. 类别 chips 显示各类命中数，选中项高亮", () => {
  const entries: ChatEntry[] = [
    userEntry("u3", "缓存 方案"),
    { kind: "assistant", id: "a1", content: "缓存 建议 LRU", preview: null, done: true },
  ];
  const allHits = searchEntries(entries, "缓存");
  const hits = allHits.filter((h) => h.category === "assistant");
  const html = renderBar({ query: "缓存", hits, allHits, category: "assistant" });

  assert.ok(html.includes("全部"), "应有「全部」chip");
  assert.ok(html.includes("模型输出"), "应有类别名 chip");
  assert.ok(html.includes('class="chat-search-chip chat-search-chip-active"'), "当前类别应高亮");
  // 全部 2 条、模型输出 1 条
  assert.ok(/全部 <span class="chat-search-chip-count">2<\/span>/.test(html));
  assert.ok(/模型输出 <span class="chat-search-chip-count">1<\/span>/.test(html));
});

test("U3b. 当前类别无命中但其他类别有时，提示切到「全部」", () => {
  const entries: ChatEntry[] = [userEntry("u4", "只有用户消息里有 token")];
  const allHits = searchEntries(entries, "token");
  const html = renderBar({ query: "token", hits: [], allHits, category: "tool" });
  assert.ok(html.includes("当前类别下没有命中，试试「全部」"));
});

test("U3c. 全类别都无命中时说明已搜过的范围", () => {
  const html = renderBar({ query: "不存在的词", hits: [], allHits: [] });
  assert.ok(html.includes("未找到匹配内容"));
  assert.ok(html.includes("思考"), "提示语应说明搜索覆盖了思考等类别");
});

// ============================================================================
// U4：长列表截断
// ============================================================================

test("U4. 超过 60 条时只渲染 60 条并提示剩余数量", () => {
  const entries: ChatEntry[] = Array.from({ length: 70 }, (_, i) => userEntry(`u-many-${i}`, `重复命中 ${i}`));
  const hits = searchEntries(entries, "重复命中");
  assert.equal(hits.length, 70);

  const html = renderBar({ query: "重复命中", hits });
  assert.equal((html.match(/data-hit-index="/g) ?? []).length, 60, "渲染上限 60");
  assert.ok(html.includes("还有 10 条未展示"));
});

// ============================================================================
// U5：ChatPane 集成（跳转锚点与入口按钮）
// ============================================================================

/**
 * ChatPane 必需 props 的最小集合（渲染层集成用）
 *
 * @param entries 对话条目
 * @returns ChatPane 元素
 */
function renderChatPane(entries: ChatEntry[]): string {
  return renderToStaticMarkup(
    <ChatPane
      entries={entries}
      streaming={false}
      chatTitle="测试会话"
      onDecide={() => undefined}
      onStop={() => undefined}
      onOpenFileDrawer={() => undefined}
      submittingPermIds={new Set<string>()}
    />
  );
}

test("U5. ChatPane 为每条消息渲染搜索锚点，且默认不展开搜索栏", () => {
  const entries: ChatEntry[] = [
    userEntry("u-anchor", "用户消息"),
    { kind: "assistant", id: "a-anchor", content: "助手回复", preview: null, done: true },
    {
      kind: "tool",
      id: "t-anchor",
      label: "write_file",
      status: "completed",
      raw: { content: JSON.stringify({ ok: true, name: "write_file", metadata: { path: "x.ts" } }) },
    },
  ];
  const html = renderChatPane(entries);

  // 每条消息一个锚点（搜索跳转靠它定位）
  for (const id of ["u-anchor", "a-anchor", "t-anchor"]) {
    assert.ok(html.includes(`data-entry-id="${id}"`), `缺少锚点 ${id}`);
  }
  assert.equal((html.match(/class="entry-anchor"/g) ?? []).length, 3);
  // 未按 ⌘F 时搜索栏不占位
  assert.ok(!html.includes("chat-search-input"), "默认不渲染搜索栏");
  // 顶栏提供搜索入口
  assert.ok(html.includes("搜索对话内容（⌘/Ctrl+F）"), "工具栏应有搜索按钮");
});
