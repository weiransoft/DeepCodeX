/**
 * 对话内搜索栏（2026-11-02）
 *
 * 定位：不是浏览器查找的替身，而是**跨内容类型**的检索面板——用户输入、模型输出、
 * 思考过程、工具与文件改动、计划与报告全在同一处命中，按类别可筛。
 *
 * 交互约定：
 * - ⌘/Ctrl+F 唤起（由 ChatPane 监听全局键盘事件），Esc 关闭；
 * - 输入即时匹配（数据在内存里，无需防抖）；Enter 下一个 / Shift+Enter 上一个；
 * - 点命中项直接跳转，并把该条目内的折叠区（思考过程、工具详情）展开——
 *   否则「搜到了但看不到」等于没搜到。
 *
 * 组件本身无状态：查询串、命中、当前项全部由 ChatPane 持有，便于与滚动/跳转联动。
 *
 * @module web/components/ChatSearchBar
 */

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  countHitsByCategory,
  SEARCH_CATEGORIES,
  SEARCH_CATEGORY_LABELS,
  type SearchCategory,
  type SearchHit,
} from "../search";
import { ChevronIcon, CloseIcon, SearchIcon } from "./icons";

/** 结果列表一次最多渲染的条数（更长时提示剩余数量，避免超长会话卡顿） */
const MAX_RENDERED_HITS = 60;

/** ChatSearchBar 组件属性 */
export interface ChatSearchBarProps {
  /** 当前查询串 */
  query: string;
  /** 查询串变化 */
  onQueryChange: (query: string) => void;
  /** 命中列表（已按当前类别筛选） */
  hits: ReadonlyArray<SearchHit>;
  /** 全类别命中列表（用于类别角标；不受筛选影响） */
  allHits: ReadonlyArray<SearchHit>;
  /** 当前命中的下标（-1 表示未定位） */
  activeIndex: number;
  /** 切换当前命中 */
  onActiveIndexChange: (index: number) => void;
  /** 当前类别筛选（null = 全部） */
  category: SearchCategory | null;
  /** 切换类别 */
  onCategoryChange: (category: SearchCategory | null) => void;
  /** 关闭搜索栏 */
  onClose: () => void;
}

/**
 * 片段 → 高亮节点
 *
 * 只高亮**当前这一处**命中（snippetMatchStart/Length 由搜索层给出），而不是把所有
 * 关键词都标亮：一条片段里出现多次时全标会让用户分不清「跳到的是哪一处」。
 *
 * @param hit 命中项
 * @returns 渲染节点
 */
function renderSnippet(hit: SearchHit): ReactNode {
  const { snippet, snippetMatchStart, snippetMatchLength } = hit;
  const end = snippetMatchStart + snippetMatchLength;
  // 边界防御：偏移越界（理论上不会）时退回纯文本，绝不吞掉片段
  if (snippetMatchStart < 0 || end > snippet.length || snippetMatchLength <= 0) return snippet;
  return (
    <>
      {snippet.slice(0, snippetMatchStart)}
      <mark className="search-hit-mark">{snippet.slice(snippetMatchStart, end)}</mark>
      {snippet.slice(end)}
    </>
  );
}

/** 对话内搜索栏 */
export function ChatSearchBar(props: ChatSearchBarProps) {
  const { query, onQueryChange, hits, allHits, activeIndex, onActiveIndexChange, category, onCategoryChange, onClose } =
    props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 结果列表容器：键盘上下移动时把当前项滚进视野 */
  const listRef = useRef<HTMLDivElement | null>(null);
  const allCounts = countHitsByCategory(allHits);
  const hasQuery = query.trim() !== "";

  // 打开即聚焦：搜索栏是为了「马上打字」而存在的
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 当前命中变化时把对应结果行滚进视野（列表可能远长于容器高度）
  useEffect(() => {
    const list = listRef.current;
    if (list === null || activeIndex < 0) return;
    const row = list.querySelector<HTMLElement>(`[data-hit-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, hits]);

  /** 上一个 / 下一个（循环） */
  const step = (delta: number): void => {
    if (hits.length === 0) return;
    const next = (activeIndex + delta + hits.length) % hits.length;
    onActiveIndexChange(next);
  };

  return (
    <div className="chat-search" role="search" aria-label="搜索对话内容">
      <div className="chat-search-bar">
        <SearchIcon size={15} className="chat-search-icon" />
        <input
          ref={inputRef}
          className="chat-search-input"
          type="text"
          value={query}
          placeholder="搜索对话内容（输入 / 输出 / 思考 / 文件改动 / 报告）"
          aria-label="搜索对话内容"
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              step(1);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              step(-1);
            }
          }}
        />
        <span className="chat-search-count" aria-live="polite">
          {hasQuery ? (hits.length === 0 ? "无匹配" : `${activeIndex + 1}/${hits.length}`) : ""}
        </span>
        <button
          type="button"
          className="icon-btn chat-search-nav"
          title="上一个（Shift+Enter）"
          aria-label="上一个命中"
          disabled={hits.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronIcon up size={14} />
        </button>
        <button
          type="button"
          className="icon-btn chat-search-nav"
          title="下一个（Enter）"
          aria-label="下一个命中"
          disabled={hits.length === 0}
          onClick={() => step(1)}
        >
          <ChevronIcon size={14} />
        </button>
        <button type="button" className="icon-btn chat-search-close" title="关闭（Esc）" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      {/* 类别筛选：角标为「全类别命中数」，切换筛选时不清零，方便看出各类有多少 */}
      {hasQuery && (
        <div className="chat-search-filters">
          <button
            type="button"
            className={`chat-search-chip${category === null ? " chat-search-chip-active" : ""}`}
            onClick={() => onCategoryChange(null)}
          >
            全部 <span className="chat-search-chip-count">{allHits.length}</span>
          </button>
          {SEARCH_CATEGORIES.map((c) => {
            const count = allCounts[c];
            return (
              <button
                key={c}
                type="button"
                className={`chat-search-chip${category === c ? " chat-search-chip-active" : ""}${
                  count === 0 ? " chat-search-chip-empty" : ""
                }`}
                onClick={() => onCategoryChange(category === c ? null : c)}
              >
                {SEARCH_CATEGORY_LABELS[c]} <span className="chat-search-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 结果列表：无查询时给用法提示，有查询无命中时说明搜索范围 */}
      {hasQuery && (
        <div className="chat-search-results" ref={listRef}>
          {hits.length === 0 ? (
            <div className="chat-search-empty">
              {allHits.length > 0
                ? "当前类别下没有命中，试试「全部」"
                : "未找到匹配内容（已搜索输入、输出、思考、工具与文件、计划与报告）"}
            </div>
          ) : (
            <>
              {hits.slice(0, MAX_RENDERED_HITS).map((hit, index) => (
                <button
                  key={`${hit.entryId}-${hit.category}-${index}`}
                  type="button"
                  data-hit-index={index}
                  className={`chat-search-hit${index === activeIndex ? " chat-search-hit-active" : ""}`}
                  onClick={() => onActiveIndexChange(index)}
                >
                  <span className={`chat-search-hit-label chat-search-hit-label-${hit.category}`}>{hit.label}</span>
                  <span className="chat-search-hit-snippet">{renderSnippet(hit)}</span>
                </button>
              ))}
              {hits.length > MAX_RENDERED_HITS && (
                <div className="chat-search-more">
                  还有 {hits.length - MAX_RENDERED_HITS} 条未展示，输入更多关键词可缩小范围
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
