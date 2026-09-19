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

/** 单条工具进度折叠条目 */
function ToolEntry({ entry }: { entry: Extract<ChatEntry, { kind: "tool" }> }) {
  const statusText = TOOL_STATUS_TEXT[entry.status] ?? entry.status;
  return (
    <details className="tool-entry">
      <summary>
        <WrenchIcon size={14} className="tool-entry-icon" />
        <span className="tool-entry-label">{entry.label}</span>
        <span className={`tool-entry-status tool-entry-status-${entry.status}`}>{statusText}</span>
      </summary>
      {/* 事件原始字段以 JSON 展示（React 文本节点，安全；信息不丢失） */}
      <pre className="tool-entry-raw">{JSON.stringify(entry.raw, null, 2)}</pre>
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
                      <AttachmentChips attachments={entry.attachments} />
                      {entry.text !== "" && <div className="msg-user-text">{entry.text}</div>}
                    </div>
                    {/* 默认用户头像（气泡右侧，与右对齐布局一致） */}
                    <UserAvatarIcon size={26} className="msg-avatar msg-avatar-user" />
                  </div>
                );
              case "assistant":
                return (
                  <div key={entry.id} className="msg-row msg-row-assistant">
                    {/* 默认机器头像（DeepCodeX 引擎，内容左侧） */}
                    <div className="msg-assistant-with-avatar">
                      <BotAvatarIcon size={26} className="msg-avatar msg-avatar-assistant" />
                      {entry.content !== null ? (
                        // 完整内容：A2UI 管线渲染
                        <AssistantA2ui content={entry.content} messageId={entry.id} />
                      ) : (
                        // 流式阶段：previewText 纯文本 + 光标动画
                        <div className="chat-stream-preview">
                          {entry.preview ?? ""}
                          {entry.done !== true && <span className="stream-cursor" aria-hidden="true" />}
                        </div>
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
