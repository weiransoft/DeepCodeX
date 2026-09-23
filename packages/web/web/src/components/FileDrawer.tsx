/**
 * 右侧文件抽屉 FileDrawer（R4，设计文档 §4；弹窗一律抽屉式的 UI 偏好）。
 *
 * 功能：
 * - 目录浏览：GET /api/files?path=&scope=（路径牢笼由服务端校验），面包屑导航 + 条目列表
 *   （类型图标直显：文件夹/图片/代码/普通文件，大小与修改时间）；
 * - 双作用域（docs/dev/web-isolation.md §3.5）：「共享目录」= 管理员配置的 allowRoots；
 *   「我的文件」= 当前用户个人上传区（聊天附件落此处，仅本人可见）；
 * - 上传：行内上传图标按钮（多选），POST /api/files/upload?path=&scope= 后刷新；
 * - 下载：行内下载图标（<a download> 直链 GET /api/files/download?path=&scope=）；
 * - 预览（docs/dev/web-file-preview.md P2/P3）：文本/图片文件行内预览图标 + 点击文件名，
 *   抽屉内容区切换为 FilePreview 覆盖层（md A2UI 渲染 / 代码行号 / 图片内嵌）；
 * - 「作为附件插入对话」：把选中文件路径经 onInsertAttachment 交给 Composer。
 */
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  fileDownloadUrl,
  listFiles,
  uploadFiles,
  type FileEntry,
  type FileListing,
  type FileScope,
} from "../api";
import { formatTime, humanSize } from "../format";
import { FilePreview, isPreviewable } from "./FilePreview";
import {
  CloseIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FolderIcon,
  InsertIcon,
  PreviewIcon,
  RefreshIcon,
  UploadIcon,
} from "./icons";

/** FileDrawer 组件属性 */
export interface FileDrawerProps {
  /** 抽屉是否打开 */
  open: boolean;
  /** 目录白名单（来自 /api/config） */
  allowRoots: string[];
  /**
   * 个人工作目录模式（docs/dev/web-workspace.md W7）：true 时隐藏「共享目录」tab，
   * 作用域锁定 personal（后端 shared 一律 403，前端同步收敛入口）。
   */
  personalOnly: boolean;
  /** 关闭抽屉 */
  onClose: () => void;
  /**
   * 文本预览上限（字节，来自 /api/config）：条目预览入口判定用，
   * 0 = 配置未就绪时宽松放行（后端 preview 端点仍会 413 兜底）。
   */
  maxPreviewBytes: number;
  /**
   * 本人个人工作区绝对路径（来自 /api/config 的 personalRoot）：
   * 列表加载前（或加载失败时）个人区面包屑据此显示完整路径。
   */
  personalRoot: string;
  /**
   * 401 统一收敛回调（会话过期/失效）：文件区任何请求收到 401 时上抛，
   * 由 App 切换到登录页——绝不在失效会话下继续渲染文件区。
   */
  onUnauthorized: () => void;
  /** 把服务器文件路径作为附件插入对话 */
  onInsertAttachment: (path: string, isImage: boolean) => void;
}

/** 拼接子路径（兼容根路径 / 与空串） */
function joinPath(dir: string, name: string): string {
  if (dir === "" || dir === "/") return `/${name}`;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

/** 按类型与名称排序：目录优先，其余按名称字典序（本地化比较） */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

/** 按文件名选择类型图标（图标直显） */
function entryIcon(e: FileEntry) {
  if (e.type === "dir") return <FolderIcon size={16} className="file-row-icon file-icon-dir" />;
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(e.name))
    return <FileImageIcon size={16} className="file-row-icon" />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|c|cpp|h|css|html|md|sh|ya?ml|toml)$/i.test(e.name)) {
    return <FileCodeIcon size={16} className="file-row-icon" />;
  }
  return <FileIcon size={16} className="file-row-icon" />;
}

/** FileDrawer：右侧抽屉 */
export function FileDrawer({
  open,
  allowRoots,
  personalOnly,
  maxPreviewBytes,
  personalRoot,
  onUnauthorized,
  onClose,
  onInsertAttachment,
}: FileDrawerProps) {
  /** 当前浏览目录（初始为第一个白名单根；无白名单时为空串由服务端决定默认） */
  const [currentPath, setCurrentPath] = useState(() => (allowRoots.length > 0 ? allowRoots[0] : ""));
  /** 文件区作用域：shared=共享 allowRoots / personal=本人个人区（隔离设计 §3.5；个人模式下恒为 personal） */
  const [scope, setScope] = useState<FileScope>(personalOnly ? "personal" : "shared");
  /** 预览目标（null = 列表态；非空 = 抽屉内容区覆盖为 FilePreview） */
  const [preview, setPreview] = useState<{ path: string; name: string; size: number } | null>(null);

  // 个人模式配置异步就绪（config 晚于首次渲染返回）时把作用域收敛到 personal，
  // 避免残留 shared 作用域向已被后端禁用的共享区发请求
  useEffect(() => {
    if (personalOnly && scope !== "personal") {
      setScope("personal");
      setListing(null);
      setCurrentPath("");
      setPreview(null); // 作用域收敛时退出预览态（预览目标可能属共享区）
    }
  }, [personalOnly, scope]);
  /** 目录列表数据 */
  const [listing, setListing] = useState<FileListing | null>(null);
  /** 加载中 / 上传中 / 错误提示 */
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  /** 隐藏的上传 input 引用 */
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 面包屑当前目录完整路径：服务端归一 listing.path 优先 → 本地 currentPath →
   * 个人作用域回退个人区根（personalRoot）——列表加载失败/未加载时
   * 「我的文件」仍显示完整路径，而不是「（未选择目录）」。
   */
  const browsePath = listing?.path ?? (currentPath !== "" ? currentPath : scope === "personal" ? personalRoot : "");

  /**
   * 请求错误统一处理：401 上抛给 App 切登录页（不渲染过期会话下的文件区），
   * 其它错误置列表空态并展示原因。
   */
  const handleRequestError = (e: unknown, fallback: string): void => {
    setListing(null);
    if (e instanceof ApiError && e.status === 401) {
      onUnauthorized();
      return;
    }
    setError(e instanceof Error ? e.message : fallback);
  };

  /** 加载目录列表（scope 由调用方显式传入，避免闭包读到旧状态） */
  const load = (path: string, sc: FileScope): void => {
    setLoading(true);
    setError("");
    listFiles(path, sc)
      .then((data) => {
        setListing(data);
        // 以服务端归一化后的路径为准（消除 ~ 展开等差异）
        setCurrentPath(data.path);
      })
      .catch((e: unknown) => {
        handleRequestError(e, "目录加载失败");
      })
      .finally(() => setLoading(false));
  };

  // 抽屉打开时加载当前目录
  useEffect(() => {
    if (open) load(currentPath, scope);
    // 仅在 open 变化时触发；currentPath 变化经由面包屑点击后显式 load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 当前作用域尚无有效目录时自动初始化（DR2：覆盖 shared 与 personal 两作用域）：
  // - 首次打开/切换作用域后 path 为空 → shared 取第一个白名单根，personal 空 path
  //   由服务端缺省到个人区根；
  // - 上次加载失败（listing 为 null、error 非空、path 已被 DR1 清空）后，
  //   配置（allowRoots/personalOnly）就绪或重试条件具备时自动重试。
  useEffect(() => {
    if (!open || loading || listing !== null || currentPath !== "") return;
    if (scope === "personal") {
      load("", scope);
    } else if (allowRoots.length > 0) {
      load(allowRoots[0], scope);
    }
    // 仅在影响「能否初始化」的状态变化时触发；load 稳定、scope 变化已由 switchScope 显式加载
  }, [open, allowRoots, listing, loading, currentPath, scope, personalOnly]);

  /**
   * 切换作用域：清空路径由服务端返回各区默认目录，并立即加载。
   * 重复点击当前作用域时不直接早退——若列表处于失败空态（listing 为 null
   * 且未在加载），重新发起加载，给用户一个明确的「重试」入口。
   */
  const switchScope = (next: FileScope): void => {
    if (next === scope) {
      if (!loading && listing === null) load("", next);
      return;
    }
    setScope(next);
    setListing(null);
    setCurrentPath("");
    load("", next);
  };

  /** 执行上传后刷新列表 */
  const handleUpload = (files: FileList): void => {
    if (files.length === 0) return;
    setUploading(true);
    setError("");
    uploadFiles(currentPath, Array.from(files), scope)
      .then(() => load(currentPath, scope))
      .catch((e: unknown) => {
        // 401 → 统一收敛登录页；其它错误仅提示（列表数据仍在，不清空）
        if (e instanceof ApiError && e.status === 401) {
          setUploading(false);
          onUnauthorized();
          return;
        }
        setError(e instanceof Error ? e.message : "上传失败");
      })
      .finally(() => {
        setUploading(false);
      });
  };

  // 未打开时不渲染（抽屉动画由 CSS 过渡处理；直接卸载可保证状态干净）
  if (!open) return null;

  // 面包屑分段：从服务端返回的归一路径拆解，逐级可点；
  // 绝对路径的根段显示为「根目录」二字（完整路径已在上方 crumb-fullpath 行展示）
  const segments = browsePath.split("/").filter((s) => s !== "");

  // 列表渲染守卫：先收窄到局部常量再遍历——map 回调内一律读列表常量
  // （currentListing.entries / currentListing.path），杜绝压缩后渲染函数里对
  // 已置空状态的裸读（点击「我的文件」401 时 listing 置 null 的同帧不再可能读到 null.path）
  const currentListing = listing;

  // 预览内容体（列表区与预览并排时共用同一实例语义——仅一份渲染树）
  const previewBody = (
    <FilePreview
      path={preview.path}
      name={preview.name}
      size={preview.size}
      scope={scope}
      onBack={() => setPreview(null)}
      // 401 统一收敛：预览请求失效会话时上抛登录页
      onUnauthorized={onUnauthorized}
      // 并排态标记：类名门控 CSS——宽屏（≥980px）时抽屉加宽为左右双栏
      // （左预览 / 右列表并排）；窄屏退化为列表下方独立预览区
      inSplit
    />
  );

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div className="drawer-overlay" onClick={onClose} />
      <aside className={preview !== null ? "drawer drawer-previewing" : "drawer"} role="dialog" aria-label="文件目录">
        {/* 抽屉头：标题 + 操作（上传/刷新/关闭） */}
        <div className="drawer-head">
          <span className="drawer-title">文件目录</span>
          <span className="drawer-actions">
            <button
              type="button"
              className="icon-btn"
              title="上传到当前目录"
              disabled={uploading || loading}
              onClick={() => uploadInputRef.current?.click()}
            >
              <UploadIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="刷新"
              disabled={loading}
              onClick={() => load(currentPath, scope)}
            >
              <RefreshIcon size={16} />
            </button>
            <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
              <CloseIcon size={16} />
            </button>
          </span>
          {/* 隐藏上传选择器（多选） */}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files !== null) handleUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {/* 作用域切换（docs/dev/web-isolation.md §3.5）：共享目录 / 我的文件；
            个人工作目录模式（W7）下共享区已被后端禁用，隐藏 tab 仅保留「我的文件」 */}
        <div className="drawer-scope" role="tablist" aria-label="文件区作用域">
          {!personalOnly && (
            <button
              type="button"
              role="tab"
              aria-selected={scope === "shared"}
              className={scope === "shared" ? "scope-tab scope-tab-active" : "scope-tab"}
              onClick={() => switchScope("shared")}
            >
              共享目录
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={scope === "personal"}
            className={scope === "personal" ? "scope-tab scope-tab-active" : "scope-tab"}
            onClick={() => switchScope("personal")}
          >
            我的文件
          </button>
        </div>

        {/* 多白名单根切换（仅共享区有意义；个人区恒为本人单一根） */}
        {scope === "shared" && allowRoots.length > 1 && (
          <div className="drawer-roots">
            <select
              className="drawer-root-select"
              value={allowRoots.find((r) => (listing?.path ?? currentPath).startsWith(r)) ?? allowRoots[0]}
              onChange={(e) => load(e.target.value, scope)}
            >
              {allowRoots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* 面包屑：当前目录完整路径（单行、中间省略、title 悬浮全量）+ 逐级可点 */}
        <nav className="breadcrumb" aria-label="路径">
          <span className="crumb-fullpath" title={browsePath}>
            {browsePath === "" ? "（未选择目录）" : browsePath}
          </span>
        </nav>
        <nav className="breadcrumb breadcrumb-trail" aria-label="逐级目录">
          <button
            type="button"
            className="crumb"
            onClick={() => {
              // DR3：有有效列表时回到当前目录所属作用域的根（listing.path 即当前作用域根内路径）；
              // 无列表时按作用域缺省（shared 取第一个白名单根；personal 空 path 服务端缺省个人区根）。
              // 绝不再把另一作用域的残留路径或空 path 发进错误牢笼。
              if (listing !== null) {
                load(listing.path, scope);
              } else if (scope === "personal") {
                load("", scope);
              } else if (allowRoots.length > 0) {
                load(allowRoots[0], scope);
              }
            }}
            disabled={scope === "shared" && listing === null && allowRoots.length === 0}
            title={browsePath !== "" ? browsePath : "回到根目录"}
          >
            根目录
          </button>
          {segments.map((seg, i) => {
            const prefix = `/${segments.slice(0, i + 1).join("/")}`;
            return (
              <span key={prefix} className="crumb-seg">
                <span className="crumb-sep">/</span>
                <button
                  type="button"
                  className="crumb"
                  onClick={() => {
                    setPreview(null); // 点目录逐级回列表
                    load(prefix, scope);
                  }}
                  title={prefix}
                >
                  {seg}
                </button>
              </span>
            );
          })}
          {/* 预览态面包屑：末级追加文件名（不可点，仅标识当前预览对象） */}
          {preview !== null && (
            <span className="crumb-seg">
              <span className="crumb-sep">/</span>
              <span className="crumb crumb-current" title={preview.path}>
                {preview.name}
              </span>
            </span>
          )}
        </nav>

        {/* 错误与状态提示 */}
        {error !== "" && <div className="drawer-error">{error}</div>}
        {uploading && <div className="drawer-hint">上传中…</div>}

        {/* 内容区：列表（+ 预览并排，宽屏时左右双栏）。预览态下列表保留可见，
            点击其他文件即时切换预览目标 */}
        <div className={preview !== null ? "drawer-body drawer-body-row" : "drawer-body"}>
          {/* 条目列表 */}
          <div className="file-list">
            {loading && <div className="drawer-hint">加载中…</div>}
            {!loading && currentListing !== null && currentListing.entries.length === 0 && (
              <div className="drawer-hint">空目录</div>
            )}
            {!loading &&
              currentListing !== null &&
              sortEntries(currentListing.entries).map((e) => {
                const full = joinPath(currentListing.path, e.name);
                if (e.type === "dir") {
                  return (
                    <button
                      key={full}
                      type="button"
                      className="file-row file-row-dir"
                      onClick={() => {
                        setPreview(null); // 进入子目录回列表态
                        load(full, scope);
                      }}
                      title={full}
                    >
                      {entryIcon(e)}
                      <span className="file-row-name">{e.name}</span>
                      <span className="file-row-meta">目录</span>
                    </button>
                  );
                }
                const previewable = isPreviewable(e.name, e.size, maxPreviewBytes);
                /** 打开预览：stopPropagation 阻断行点击重复触发 */
                const openPreview = (event: { stopPropagation: () => void }): void => {
                  event.stopPropagation();
                  setPreview({ path: full, name: e.name, size: e.size });
                };
                return (
                  <div
                    key={full}
                    className="file-row file-row-file"
                    title={previewable ? `${full}（点击预览）` : full}
                    onClick={previewable ? () => setPreview({ path: full, name: e.name, size: e.size }) : undefined}
                  >
                    {entryIcon(e)}
                    <span className="file-row-name">{e.name}</span>
                    <span className="file-row-meta">
                      {humanSize(e.size)} · {formatTime(e.mtime)}
                    </span>
                    {/* 行内操作：预览（文本/图片）/ 插入对话 / 下载（图标直显；
                      按钮一律 stopPropagation，防止触发行级预览） */}
                    <span className="file-row-actions" onClick={(ev) => ev.stopPropagation()}>
                      {previewable && (
                        <button type="button" className="icon-btn" title="预览" onClick={openPreview}>
                          <PreviewIcon size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        title="作为附件插入对话"
                        onClick={() => onInsertAttachment(full, /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(e.name))}
                      >
                        <InsertIcon size={15} />
                      </button>
                      {/* 原生下载直链：服务端 Content-Disposition 附件响应 */}
                      <a className="icon-btn" href={fileDownloadUrl(full, scope)} download={e.name} title="下载">
                        <svg viewBox="0 0 16 16" width="15" height="15" aria-label="下载" role="img">
                          <path
                            d="M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M2.8 12.2v.8a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.8"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      </a>
                    </span>
                  </div>
                );
              })}
          </div>

          {/* 预览区（docs/dev/web-file-preview.md P3）：宽屏（≥980px）时与列表
              左右并排（预览在左、列表在右）；窄屏退化为列表下方独立预览区 */}
          {preview !== null && previewBody}
        </div>
      </aside>
    </>
  );
}
