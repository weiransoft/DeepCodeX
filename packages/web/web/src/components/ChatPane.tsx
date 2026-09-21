/**
 * 中间对话流（设计文档 §4）：
 * - 用户消息右侧气泡（附件 chips 图标直显）；
 * - 助手消息经 A2UI 渲染层呈现（完整 content → parseMarkdownToA2ui → A2uiSurface）；
 * - 流式阶段显示 previewText 纯文本 + 光标动画（不半截解析，避免 fence 抖动）；
 * - 工具执行进度为折叠条目（<details>，保留事件原始字段）；
 * - 内联权限审批卡片；生成中显示悬浮"停止生成"按钮；
 * - 自动滚动到底部（用户上翻时暂停跟随）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parseMarkdownToA2ui } from "../a2ui/parser";
import { A2uiSurface } from "../a2ui/renderer";
import type { ChatEntry, UserAttachment } from "../chat-model";
import { extractToolText, humanizeEngineContent, setEngineToolEntryHint } from "../chat-model";
import { FolderOpenIcon, PaperclipIcon, StopIcon, WrenchIcon, BotAvatarIcon, UserAvatarIcon } from "./icons";
import { PermissionCard } from "./PermissionCard";

/** ChatPane 组件属性 */
export interface ChatPaneProps {
  /** 对话流条目 */
  entries: ChatEntry[];
  /** 是否正在流式生成（控制停止按钮与光标） */
  streaming: boolean;
  /** 当前会话标题（未选会话时为 null → 欢迎页） */
  chatTitle: string | null;
  /** 决策回调（透传给 PermissionCard） */
  onDecide: (toolCallId: string, decision: "allow" | "deny") => void;
  /** 停止生成 */
  onStop: () => void;
  /** 打开文件抽屉 */
  onOpenFileDrawer: () => void;
  /** 提交中审批卡片数量（>0 时对应卡片按钮禁用） */
  submittingPermIds: Set<string>;
}

/** 工具进度状态的中文展示映射 */
const TOOL_STATUS_TEXT: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  error: "失败",
};

/**
 * 助手消息 → A2UI surface：
 * 仅对完整 content 解析（流式 preview 不进管线，见设计文档 §3.7 流式约束）。
 * useMemo 以 content 为缓存键，流式更新不触发重复解析。
 */
function AssistantA2ui({ content, messageId }: { content: string; messageId: string }) {
  const messages = useMemo(() => parseMarkdownToA2ui(content, `msg-${messageId}`), [content, messageId]);
  return <A2uiSurface messages={messages} className="a2ui-surface chat-assistant-body" />;
}

/** PreviewMarkdown 组件属性 */
interface PreviewMarkdownProps {
  /** 流式累积文本（正文 preview 或思考 thinking，均可能含未闭合围栏） */
  text: string;
  /** A2UI surface 标识（同一气泡内正文/思考各自独立，避免 surface key 冲突） */
  surfaceId: string;
  /** 是否显示流式光标（生成中 true） */
  cursor?: boolean;
}

/**
 * 流式预览 → 容错 Markdown 渲染（docs/dev/web-thinking-display.md F2）。
 *
 * 与旧「纯文本 div」的区别：thinking/preview 均经 parseMarkdownToA2ui 渲染，
 * 恢复分段、列表、代码围栏等格式；解析器对**未闭合围栏自动补全到文末**，
 * 半截 fence 渲染为代码块而非吞掉后续内容（fence 抖动防护由解析器承担）。
 * useMemo 以 text 为缓存键，流式更新只重解析当前文本。
 */
function PreviewMarkdown({ text, surfaceId, cursor = false }: PreviewMarkdownProps) {
  const messages = useMemo(() => parseMarkdownToA2ui(text, `stream-${surfaceId}`), [text, surfaceId]);
  return (
    <div className="chat-stream-preview">
      <A2uiSurface messages={messages} className="a2ui-surface" />
      {cursor && <span className="stream-cursor" aria-hidden="true" />}
    </div>
  );
}

/** 附件 chips（图标按类型直显） */
function AttachmentChips({ attachments }: { attachments: UserAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((a, i) => (
        <span key={`${a.name}-${i}`} className="attach-chip" title={a.name}>
          <PaperclipIcon size={12} />
          <span className="attach-chip-name">{a.name}</span>
        </span>
      ))}
    </div>
  );
}

/** 单条工具进度折叠条目（展开区优先文本渲染，原始 JSON 收进次级折叠不丢信息） */
function ToolEntry({ entry }: { entry: Extract<ChatEntry, { kind: "tool" }> }) {
  const statusText = TOOL_STATUS_TEXT[entry.status] ?? entry.status;
  // 可读文本提取：output 直显（含混排 JSON 块解析）；null 时回退原始 JSON
  const text = extractToolText(entry.raw);
  const rawJson = JSON.stringify(entry.raw, null, 2);
  return (
    <details className="tool-entry">
      <summary>
        <WrenchIcon size={14} className="tool-entry-icon" />
        <span className="tool-entry-label">{entry.label}</span>
        <span className={`tool-entry-status tool-entry-status-${entry.status}`}>{statusText}</span>
      </summary>
      {text !== null ? (
        // 文本渲染：工具输出直显（等宽保留换行，限高滚动）
        <pre className="tool-entry-text">{text}</pre>
      ) : (
        // 兜底：无可读文本时维持原始 JSON 展示
        <pre className="tool-entry-raw">{rawJson}</pre>
      )}
      {/* 原始事件数据次级折叠：文本渲染的同时保留完整事件字段（信息不丢） */}
      <details className="tool-entry-raw-toggle">
        <summary>原始事件数据</summary>
        <pre className="tool-entry-raw">{rawJson}</pre>
      </details>
    </details>
  );
}

/** ChatPane：中间对话流 */
export function ChatPane(props: ChatPaneProps) {
  const { entries, streaming, chatTitle, onDecide, onStop, onOpenFileDrawer, submittingPermIds } = props;
  /** 滚动容器引用：自动跟随到底部 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否主动上翻离开底部（此时暂停自动跟随） */
  const [followBottom, setFollowBottom] = useState(true);

  // 渲染入口同步「工具折叠条目内容指纹」：助手正文可读化时据此判定引擎
  // 工具结果块是否已被折叠条目承载（双写同源 → 正文移除；否则正文兜底展示）。
  // 在组件体（map 渲染之前）执行，React 单线程保证 humanize 调用时值已就绪。
  setEngineToolEntryHint(
    entries
      .filter((x) => x.kind === "tool")
      .map((x) => (typeof x.raw.content === "string" ? x.raw.content : ""))
      .filter((s) => s !== "")
  );

  // 条目或流式状态变化时：若用户位于底部附近则滚动到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && followBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries, streaming, followBottom]);

  /** 滚动事件：距底部 < 80px 视为"在底部"，恢复跟随 */
  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setFollowBottom(nearBottom);
  };

  // 未选择会话：欢迎页（品牌 + 提示）
  if (chatTitle === null) {
    return (
      <main className="chat-pane">
        <div className="chat-toolbar">
          <span className="chat-toolbar-title" />
          <button type="button" className="icon-btn" title="文件目录" onClick={onOpenFileDrawer}>
            <FolderOpenIcon size={17} />
          </button>
        </div>
        <div className="chat-welcome">
          <div className="chat-welcome-brand">DeepCodeX</div>
          <div className="chat-welcome-hint">从左侧新建对话，开始与 DeepCodeX 引擎对话</div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-pane">
      {/* 顶栏：会话标题 + 文件目录入口 */}
      <div className="chat-toolbar">
        <span className="chat-toolbar-title" title={chatTitle}>
          {chatTitle}
        </span>
        <button type="button" className="icon-btn" title="文件目录" onClick={onOpenFileDrawer}>
          <FolderOpenIcon size={17} />
        </button>
      </div>

      {/* 消息滚动区 */}
      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="chat-entries">
          {entries.map((entry) => {
            switch (entry.kind) {
              case "user":
                return (
                  <div key={entry.id} className="msg-row msg-row-user">
                    <div className="msg-user-bubble">
                      {/* steering F2 角标：运行中补充指令的受理模式（202 mode 打标） */}
                      {entry.mode !== undefined && (
                        <span className={`user-mode-badge user-mode-badge-${entry.mode}`}>
                          {entry.mode === "steered" ? "已注入当前任务" : "排队中"}
                        </span>
                      )}
                      <AttachmentChips attachments={entry.attachments} />
                      {entry.text !== "" && <div className="msg-user-text">{entry.text}</div>}
                    </div>
                    {/* 默认用户头像（气泡右侧，与右对齐布局一致） */}
                    <UserAvatarIcon size={26} className="msg-avatar msg-avatar-user" />
                  </div>
                );
              case "steering":
                // steering F3/F4：执行中补充指令的注入分隔条（system + meta.steeringInject）
                return (
                  <div key={entry.id} className="steering-divider">
                    <span className="steering-divider-label">指令注入</span>
                    <span className="steering-divider-text">{entry.text}</span>
                  </div>
                );
              case "assistant":
                return (
                  <div key={entry.id} className="msg-row msg-row-assistant">
                    {/* 默认机器头像（DeepCodeX 引擎，内容左侧） */}
                    <div className="msg-assistant-with-avatar">
                      <BotAvatarIcon size={26} className="msg-avatar msg-avatar-assistant" />
                      {entry.content !== null ? (
                        // 完整内容：先可读化（引擎拼接的工具结果 JSON 块 → output 文本，
                        // 围栏代码与非工具结果 JSON 原样保留）再进 A2UI 管线渲染
                        <AssistantA2ui content={humanizeEngineContent(entry.content)} messageId={entry.id} />
                      ) : (
                        // 流式阶段（docs/dev/web-thinking-display.md F2）：
                        // 思考过程（可折叠，默认展开）+ 正文预览，均经容错 Markdown
                        // 管线渲染——恢复分段与格式；未闭合围栏自动补全，防 fence 抖动。
                        <>
                          {entry.thinking !== undefined && entry.thinking !== "" && (
                            <details className="chat-thinking" open>
                              <summary className="chat-thinking-summary">思考过程</summary>
                              <PreviewMarkdown text={entry.thinking} surfaceId={`thinking-${entry.id}`} />
                            </details>
                          )}
                          <PreviewMarkdown
                            text={humanizeEngineContent(entry.preview ?? "")}
                            surfaceId={`preview-${entry.id}`}
                            cursor={entry.done !== true}
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              case "tool":
                return <ToolEntry key={entry.id} entry={entry} />;
              case "permission":
                return (
                  <div key={entry.id} className="msg-row msg-row-permission">
                    <PermissionCard
                      request={entry.request}
                      decided={entry.decided}
                      submitting={entry.submitting || submittingPermIds.has(entry.request.toolCallId)}
                      onDecide={onDecide}
                    />
                  </div>
                );
              default:
                // 穷举保护：未知条目类型不渲染（TypeScript 已保证不可达）
                return null;
            }
          })}

          {/* 生成中：悬浮停止条（点击中断引擎会话） */}
          {streaming && (
            <div className="stop-bar">
              <button type="button" className="stop-btn" onClick={onStop}>
                <StopIcon size={13} />
                停止生成
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
