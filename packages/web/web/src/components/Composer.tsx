/**
 * 底部输入框 Composer（设计文档 §4）：
 * - 多行文本（自适应高度；Enter 发送 / Shift+Enter 换行；中文输入法 composition 保护）；
 * - 本地附件：点击回形针选择 / 拖拽高亮上传 / 图片粘贴（paste 捕获 clipboardData.files 中 image/*）；
 * - 附件 chips（图标直显，图片带缩略预览，URL.createObjectURL 并在移除时 revoke）；
 * - 服务器附件（文件抽屉"作为附件插入对话"）以 serverFiles 传入，一并展示与发送；
 * - 发送/停止按钮位：生成中显示停止（中断请求由 App 转发到 POST /interrupt）；
 * - steering F1（docs/dev/web-steering.md）：steeringEnabled 时生成中不禁用输入，
 *   用户可随时发送补充指令（后端分类注入或排队），发送与停止按钮并排同显。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { humanSize } from "../format";
import type { UserAttachment } from "../chat-model";
import { CloseIcon, FileCodeIcon, FileIcon, FileImageIcon, PaperclipIcon, SendIcon, StopIcon } from "./icons";

/** Composer 组件属性 */
export interface ComposerProps {
  /** 无会话时禁用输入 */
  disabled: boolean;
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

/** 从文件名猜测展示图标（图片/代码/普通文件） */
function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) return <FileImageIcon size={14} />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|c|cpp|h|css|html|md|sh|ya?ml|toml)$/i.test(name)) {
    return <FileCodeIcon size={14} />;
  }
  return <FileIcon size={14} />;
}

/** Composer：底部输入框 */
export function Composer(props: ComposerProps) {
  const { disabled, streaming, steeringEnabled, maxUploadBytes, serverFiles, onRemoveServerFile, onSend, onStop } =
    props;
  /**
   * 输入区是否禁用（steering F1）：steeringEnabled 时生成中仍可输入补充指令；
   * 关闭时回退旧行为（生成中禁用 textarea/附件/发送）。
   */
  const inputBlocked = disabled || (streaming && !steeringEnabled);

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
  /** 中文输入法组合输入中（回车不应触发发送） */
  const composingRef = useRef(false);
  /** 全部已创建的 ObjectURL 登记（卸载时统一 revoke，防内存泄漏） */
  const allObjectUrlsRef = useRef<Set<string>>(new Set());

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

  /** 键盘发送：Enter 发送（IME 组合中除外），Shift+Enter 换行 */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
      e.preventDefault();
      doSend();
    }
  };

  /** 执行发送：有内容或附件才触发；发送后清空本地状态 */
  const doSend = (): void => {
    if (disabled || streaming) return;
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
  };

  /** textarea 自适应高度（上限 200px 后内部滚动） */
  const autoResize = (): void => {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  const canSend = !disabled && !streaming && (text.trim() !== "" || localFiles.length > 0 || serverFiles.length > 0);

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
          placeholder={disabled ? "先从左侧新建或选择一个对话" : "输入消息，Enter 发送，Shift+Enter 换行"}
          rows={1}
          value={text}
          disabled={disabled || streaming}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
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
