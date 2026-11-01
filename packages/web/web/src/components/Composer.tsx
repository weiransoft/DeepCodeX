/**
 * 底部输入框 Composer（设计文档 §4）：
 * - 多行文本（自适应高度；Enter 发送 / Shift+Enter 换行；中文输入法 composition 保护）；
 * - 本地附件：点击回形针选择 / 拖拽高亮上传 / 图片粘贴（paste 捕获 clipboardData.files 中 image/*）；
 * - 附件 chips（图标直显，图片带缩略预览，URL.createObjectURL 并在移除时 revoke）；
 * - 服务器附件（文件抽屉"作为附件插入对话"）以 serverFiles 传入，一并展示与发送；
 * - 发送/停止按钮位：生成中显示停止（中断请求由 App 转发到 POST /interrupt）；
 * - steering F1（docs/dev/web-steering.md）：steeringEnabled 时生成中不禁用输入，
 *   用户可随时发送补充指令（后端分类注入或排队），发送与停止按钮并排同显；
 * - @ 提及补全（web-capability T2）：输入 @ 触发候选面板（技能 / Agent / MCP 服务器），
 *   键盘上下选择、Enter/Tab 补全、Esc 关闭；数据源 GET /api/capabilities（懒加载缓存）。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { humanSize } from "../format";
import type { UserAttachment } from "../chat-model";
import { fetchCapabilities, type Capabilities } from "../api";
import { CloseIcon, FileCodeIcon, FileIcon, FileImageIcon, PaperclipIcon, SendIcon, StopIcon } from "./icons";

/** Composer 组件属性 */
export interface ComposerProps {
  /** 生成中：发送按钮切换为停止（steeringEnabled 时发送与停止并排同显） */
  streaming: boolean;
  /** 任务执行中补充指令开关（docs/dev/web-steering.md W7）：false 时生成中禁用输入（旧行为） */
  steeringEnabled: boolean;
  /** 单文件大小上限（来自 /api/config，超出即拒绝并提示） */
  maxUploadBytes: number;
  /** 服务器附件（文件抽屉插入的路径引用） */
  serverFiles: UserAttachment[];
  /** 移除服务器附件 */
  onRemoveServerFile: (index: number) => void;
  /**
   * 发送回调。
   * @param text        文本内容
   * @param localFiles  本地附件（走 multipart file 字段）
   * @param serverFiles 服务器路径附件（图片走 imageUrls，其余并入文本引用）
   */
  onSend: (text: string, localFiles: File[], serverFiles: UserAttachment[]) => void;
  /** 停止生成 */
  onStop: () => void;
}

/** @ 提及候选条目（统一技能 / Agent / MCP 三类为同一展示模型） */
interface MentionItem {
  /** 补全后插入的名字（@ 后面的 token） */
  token: string;
  /** 种类徽标文案 */
  kindLabel: string;
  /** 说明（技能 description / MCP command） */
  description: string;
  /** 种类样式类（mention-badge-skill / -agent / -mcp） */
  kindClass: string;
}

/** 从文件名猜测展示图标（图片/代码/普通文件） */
function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) return <FileImageIcon size={14} />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|c|cpp|h|css|html|md|sh|ya?ml|toml)$/i.test(name)) {
    return <FileCodeIcon size={14} />;
  }
  return <FileIcon size={14} />;
}

/**
 * 解析光标前的 @ 提及上下文：
 * 匹配「行首或空白后的 @token」（token 不含空白与 @），返回 token 起止下标
 * （含 @）与查询词；光标不在 @ token 内时返回 null。
 */
function parseMentionContext(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m === null) return null;
  const atStart = before.length - m[0].length + m[0].indexOf("@");
  return { start: atStart, end: caret, query: m[1] ?? "" };
}

/** Composer：底部输入框 */
export function Composer(props: ComposerProps) {
  const { streaming, steeringEnabled, maxUploadBytes, serverFiles, onRemoveServerFile, onSend, onStop } = props;
  /**
   * 输入区是否禁用（steering F1）：steeringEnabled 时生成中仍可输入补充指令；
   * 关闭时回退旧行为（生成中禁用 textarea/附件/发送）。
   * 注意：不存在「无会话禁用」——无选中会话时发送由 App 自动新建会话承载。
   */
  const inputBlocked = streaming && !steeringEnabled;

  /** 输入文本 */
  const [text, setText] = useState("");
  /** 本地附件列表 */
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  /** 图片缩略预览的 ObjectURL（name → url，移除/卸载时 revoke 防泄漏） */
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  /** 拖拽悬停高亮 */
  const [dragOver, setDragOver] = useState(false);
  /** 行内错误提示（超限文件名等） */
  const [error, setError] = useState("");
  /** 隐藏的文件选择 input 引用 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** textarea 引用：自适应高度 */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 中文输入法组合输入中（回车不应触发发送/补全） */
  const composingRef = useRef(false);
  /** 全部已创建的 ObjectURL 登记（卸载时统一 revoke，防内存泄漏） */
  const allObjectUrlsRef = useRef<Set<string>>(new Set());

  /** 能力清单（技能/Agent/MCP；首个 @ 懒加载，30s TTL 缓存） */
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const capsFetchedAtRef = useRef(0);
  const capsLoadingRef = useRef(false);
  /** @ 提及状态：null = 面板关闭；否则为解析出的替换区间 + 候选 + 高亮项 */
  const [mention, setMention] = useState<{
    range: { start: number; end: number; query: string };
    items: MentionItem[];
    active: number;
  } | null>(null);

  /** 懒加载能力清单（30s TTL；失败静默——面板仅展示空态） */
  const ensureCaps = (): void => {
    const now = Date.now();
    if (capsLoadingRef.current || now - capsFetchedAtRef.current < 30_000) return;
    capsLoadingRef.current = true;
    fetchCapabilities()
      .then((data) => {
        setCaps(data);
        capsFetchedAtRef.current = Date.now();
      })
      .catch(() => {
        // 失败不缓存：下次 @ 再试
        capsFetchedAtRef.current = 0;
      })
      .finally(() => {
        capsLoadingRef.current = false;
      });
  };

  /** 由能力清单构建候选（按查询词过滤；技能/Agent/MCP 依次排列） */
  const buildMentionItems = (data: Capabilities | null, query: string): MentionItem[] => {
    if (data === null) return [];
    const q = query.toLowerCase();
    const hit = (name: string): boolean => q === "" || name.toLowerCase().includes(q);
    const items: MentionItem[] = [];
    for (const s of data.skills) {
      if (s.kind === "skill" && hit(s.name)) {
        items.push({ token: s.name, kindLabel: "技能", description: s.description, kindClass: "mention-badge-skill" });
      }
    }
    for (const s of data.skills) {
      if (s.kind === "agent" && hit(s.name)) {
        items.push({ token: s.name, kindLabel: "Agent", description: s.description, kindClass: "mention-badge-agent" });
      }
    }
    for (const m of data.mcpServers) {
      if (hit(m.name)) {
        items.push({ token: m.name, kindLabel: "MCP", description: m.command, kindClass: "mention-badge-mcp" });
      }
    }
    return items.slice(0, 8);
  };

  /**
   * 刷新 @ 提及面板：按光标位置重新解析上下文并计算候选。
   * 光标位置从 textarea 实时读取（change / click / keyup 后均为最新）。
   */
  const refreshMention = (value: string): void => {
    const el = textareaRef.current;
    const caret = el !== null ? (el.selectionStart ?? value.length) : value.length;
    const ctx = parseMentionContext(value, caret);
    if (ctx === null) {
      setMention(null);
      return;
    }
    ensureCaps();
    const items = buildMentionItems(caps, ctx.query);
    if (items.length === 0) {
      setMention({ range: ctx, items, active: -1 });
      return;
    }
    setMention((prev) => ({ range: ctx, items, active: prev !== null ? Math.min(prev.active, items.length - 1) : 0 }));
  };

  /** 应用选中候选：把 @query 替换为 @token 并把光标落到补全文本之后 */
  const applyMention = (item: MentionItem): void => {
    const el = textareaRef.current;
    if (mention === null) return;
    const { start, end } = mention.range;
    const inserted = `@${item.token} `;
    const next = text.slice(0, start) + inserted + text.slice(end);
    setText(next);
    setMention(null);
    if (el !== null) {
      const caret = start + inserted.length;
      // React 受控更新后异步定位光标
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  };

  // 组件卸载时释放全部 ObjectURL
  useEffect(() => {
    const urls = allObjectUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  /** 追加本地文件：校验大小上限；图片建立缩略预览 */
  const addFiles = (files: FileList | File[]): void => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(files)) {
      // 仅在拿到有效上限时校验（配置未就绪时不误拒）
      if (maxUploadBytes > 0 && f.size > maxUploadBytes) {
        // 超出服务端上限：明确拒绝并提示（避免 202 后上传才失败）
        rejected.push(`${f.name}（超过 ${humanSize(maxUploadBytes)}）`);
        continue;
      }
      accepted.push(f);
    }
    if (rejected.length > 0) setError(`以下文件未添加：${rejected.join("、")}`);
    else setError("");
    if (accepted.length === 0) return;

    setLocalFiles((prev) => [...prev, ...accepted]);
    setPreviews((prev) => {
      const next = new Map(prev);
      for (const f of accepted) {
        if (f.type.startsWith("image/")) {
          const url = URL.createObjectURL(f);
          allObjectUrlsRef.current.add(url);
          next.set(f.name, url);
        }
      }
      return next;
    });
  };

  /** 移除本地附件（同时释放预览 URL） */
  const removeFile = (index: number): void => {
    setLocalFiles((prev) => {
      const target = prev[index];
      if (target !== undefined) {
        setPreviews((m) => {
          const url = m.get(target.name);
          if (url !== undefined) {
            URL.revokeObjectURL(url);
            const next = new Map(m);
            next.delete(target.name);
            return next;
          }
          return m;
        });
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  /** 粘贴：捕获剪贴板中的图片文件（image/*）加入附件 */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = e.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (images.length > 0) {
        e.preventDefault(); // 阻止默认插入文件路径文本
        addFiles(images);
      }
    }
  };

  /** 拖拽放下：收集全部文件 */
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  /** 键盘发送：Enter 发送（IME 组合中除外），Shift+Enter 换行；
   *  @ 面板打开时优先消费方向键 / Enter / Tab / Escape（不发送）。 */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
      // @ 面板打开且有高亮候选：Enter = 补全（不发送）
      if (mention !== null && mention.active >= 0 && mention.items.length > 0) {
        e.preventDefault();
        void applyMention(mention.items[mention.active]);
        return;
      }
      e.preventDefault();
      doSend();
      return;
    }
    if (mention !== null && mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => (m !== null ? { ...m, active: (m.active + 1) % m.items.length } : m));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => (m !== null ? { ...m, active: (m.active - 1 + m.items.length) % m.items.length } : m));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void applyMention(mention.items[Math.max(mention.active, 0)]);
        return;
      }
    }
    if (e.key === "Escape" && mention !== null) {
      e.preventDefault();
      setMention(null);
    }
  };

  /** 执行发送：有内容或附件才触发；发送后清空本地状态 */
  const doSend = (): void => {
    if (inputBlocked) return;
    const trimmed = text.trim();
    if (trimmed === "" && localFiles.length === 0 && serverFiles.length === 0) return;
    onSend(trimmed, localFiles, serverFiles);
    setText("");
    setLocalFiles([]);
    setPreviews((m) => {
      for (const url of m.values()) URL.revokeObjectURL(url);
      return new Map();
    });
    setError("");
    setMention(null);
  };

  /** textarea 自适应高度（上限 200px 后内部滚动） */
  const autoResize = (): void => {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  /** 可发送：输入未被阻塞（生成中且 steering 关闭时阻塞）且有文本或附件 */
  const canSend = !inputBlocked && (text.trim() !== "" || localFiles.length > 0 || serverFiles.length > 0);

  return (
    <div
      className={`composer${dragOver ? " composer-dragover" : ""}`}
      // 拖拽上传：dragover 必须阻止默认行为，drop 事件才会触发
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 仅当离开整个 composer 容器时取消高亮（子元素间移动不触发）
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {/* 拖拽高亮遮罩文案 */}
      {dragOver && <div className="composer-drag-tip">松开以添加附件</div>}

      {/* @ 提及候选面板（悬浮于输入框上方；空态提示可输入内容过滤） */}
      {mention !== null && (
        <div className="composer-mention" role="listbox" aria-label="@ 提及候选">
          <div className="composer-mention-title">技能 / Agent / MCP（↑↓ 选择，Enter 补全，Esc 关闭）</div>
          {mention.items.length === 0 ? (
            <div className="composer-mention-empty">{caps === null ? "正在加载可用能力…" : "无匹配项"}</div>
          ) : (
            mention.items.map((item, i) => (
              <button
                type="button"
                key={`${item.kindLabel}-${item.token}`}
                className={`composer-mention-item${i === mention.active ? " active" : ""}`}
                role="option"
                aria-selected={i === mention.active}
                onMouseEnter={() => setMention((m) => (m !== null ? { ...m, active: i } : m))}
                onMouseDown={(e) => {
                  // mousedown 防止 textarea 失焦导致面板先关闭
                  e.preventDefault();
                  void applyMention(item);
                }}
              >
                <span className={`mention-badge ${item.kindClass}`}>{item.kindLabel}</span>
                <span className="mention-token">{item.token}</span>
                <span className="mention-desc">{item.description}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 附件 chips 区（本地 + 服务器路径） */}
      {(localFiles.length > 0 || serverFiles.length > 0) && (
        <div className="composer-chips">
          {localFiles.map((f, i) => {
            const previewUrl = previews.get(f.name);
            return (
              <span key={`${f.name}-${i}`} className="composer-chip" title={`${f.name} · ${humanSize(f.size)}`}>
                {previewUrl !== undefined ? (
                  <img className="composer-chip-thumb" src={previewUrl} alt={f.name} />
                ) : (
                  <span className="composer-chip-icon">{fileIcon(f.name)}</span>
                )}
                <span className="composer-chip-name">{f.name}</span>
                <button type="button" className="chip-remove" title="移除附件" onClick={() => removeFile(i)}>
                  <CloseIcon size={11} />
                </button>
              </span>
            );
          })}
          {serverFiles.map((sf, i) => (
            <span key={`${sf.name}-server-${i}`} className="composer-chip composer-chip-server" title={sf.name}>
              <span className="composer-chip-icon">{fileIcon(sf.name)}</span>
              <span className="composer-chip-name">{sf.name}</span>
              <button type="button" className="chip-remove" title="移除附件" onClick={() => onRemoveServerFile(i)}>
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 行内错误提示（超限文件等） */}
      {error !== "" && <div className="composer-error">{error}</div>}

      <div className="composer-main">
        {/* 附件选择按钮（图标直显；生成中在 steering 模式下仍可添加附件） */}
        <button
          type="button"
          className="icon-btn composer-attach"
          title="添加附件"
          disabled={inputBlocked}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon size={17} />
        </button>
        {/* 隐藏文件选择器：multiple 支持多选 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files !== null) addFiles(e.target.files);
            e.target.value = ""; // 允许重复选择同一文件
          }}
        />

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder="输入消息，@ 唤起技能 / MCP，Enter 发送，Shift+Enter 换行"
          rows={1}
          value={text}
          disabled={inputBlocked}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
            refreshMention(e.target.value);
          }}
          onKeyUp={(e) => {
            // 方向键移动光标后重算 @ 上下文（不改值，仅按当前值重解析）
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
              refreshMention(text);
            }
          }}
          onClick={() => refreshMention(text)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />

        {/* 发送 / 停止按钮位：
            - steering 关闭（旧行为）：生成中只显示停止；
            - steering 开启：生成中 发送 + 停止 并排同显（补充指令随时可发）。 */}
        {streaming && !steeringEnabled ? (
          <button type="button" className="composer-send composer-send-stop" title="停止生成" onClick={onStop}>
            <StopIcon size={15} />
          </button>
        ) : (
          <>
            {streaming && (
              <button type="button" className="composer-send composer-send-stop" title="停止生成" onClick={onStop}>
                <StopIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className="composer-send"
              title={streaming ? "发送补充指令" : "发送"}
              disabled={!canSend}
              onClick={doSend}
            >
              <SendIcon size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
