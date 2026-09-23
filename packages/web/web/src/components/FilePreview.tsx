/**
 * 文件预览覆盖层 FilePreview（docs/dev/web-file-preview.md P2/P3）。
 *
 * 覆盖于文件抽屉内容区之上，对文本/图片文件做就地渲染：
 * - Markdown（.md/.markdown）：复用对话 A2UI 渲染管线（parseMarkdownToA2ui + A2uiSurface）；
 * - 代码/文本：等宽 <pre> + 行号渲染（不引入语法高亮依赖——技术栈约束，保持零新增依赖）；
 * - 图片：直链内嵌 <img>（GET /api/files/download，object-fit 自适应）；
 * - 加载失败（413 超大 / 415 二进制 / 越界 403 等）：展示原因 + 下载引导。
 *
 * 安全：预览文本经 JSON 字符串由 React 转义渲染（无 innerHTML）；
 * Markdown 管线与对话消息共用同一渲染器（同等安全边界）。
 */
import { useEffect, useMemo, useState } from "react";
import { ApiError, fetchPreview, fileDownloadUrl, type FilePreviewResult, type FileScope } from "../api";
import { humanSize } from "../format";
import { parseMarkdownToA2ui } from "../a2ui/parser";
import { A2uiSurface } from "../a2ui/renderer";
import { BackIcon, DownloadIcon } from "./icons";

/** FilePreview 组件属性 */
export interface FilePreviewProps {
  /** 预览文件绝对路径（牢笼内，服务端二次校验） */
  path: string;
  /** 文件名（扩展名决定渲染分支） */
  name: string;
  /** 文件字节大小（图片直链场景展示） */
  size: number;
  /** 作用域（shared/personal，决定 download 直链与 preview 请求） */
  scope: FileScope;
  /** 返回列表 */
  onBack: () => void;
  /**
   * 401 统一收敛回调（会话过期/失效）：预览请求收到 401 时上抛给
   * App 切登录页；缺省不传时仅在预览区内展示错误（组件独立复用语义）。
   */
  onUnauthorized?: () => void;
  /**
   * 并排预览态（宽屏抽屉加宽后的左栏）：预览头隐藏返回按钮
   * （列表仍在右栏可见可点，文件标识由抽屉面包屑末级承担，返回语义统一为关闭预览）。
   */
  inSplit?: boolean;
}

/** 图片扩展名（与 FileDrawer.entryIcon 同一判定源） */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** Markdown 扩展名（A2UI 渲染管线分支） */
const MARKDOWN_EXT_RE = /\.(md|markdown|mdx)$/i;

/**
 * 扩展名 → 语言标注（头部徽标展示；等宽渲染不做语法高亮）。
 * 未收录扩展名统一标「文本」。
 */
const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  h: "C/C++ 头文件",
  cpp: "C++",
  hpp: "C++ 头文件",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  sql: "SQL",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  xml: "XML",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  conf: "配置",
  cfg: "配置",
  env: "环境变量",
  log: "日志",
  csv: "CSV",
  txt: "文本",
  lock: "Lockfile",
};

/** 可预览文本扩展名白名单（与后端 UTF-8 校验互补：宽进严出，不符则预览层显示错误引导） */
const TEXT_EXT_RE =
  /\.(md|markdown|mdx|txt|text|log|csv|tsv|json|jsonc|json5|ya?ml|toml|ini|conf|cfg|env|properties|xml|html?|htm|css|scss|less|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|h|cpp|hpp|cc|cs|rb|php|pl|lua|sh|bash|zsh|fish|sql|r|m|scala|groovy|vue|svelte|graphql|proto|diff|patch|gitignore|dockerignore|editorconfig)(\..+)?$/i;

/**
 * 判断条目是否提供预览入口（docs/dev/web-file-preview.md P2）。
 *
 * 图片直接可预览（直链渲染，不受 preview 端点限制）；
 * 文本类要求扩展名在白名单内且大小 ≤ maxPreviewBytes。
 *
 * @param name 文件名
 * @param size 字节大小
 * @param maxPreviewBytes 后端文本预览上限（来自 /api/config；0 = 未知，宽松放行）
 */
export function isPreviewable(name: string, size: number, maxPreviewBytes: number): boolean {
  if (IMAGE_EXT_RE.test(name)) return true;
  if (!TEXT_EXT_RE.test(name)) return false;
  return maxPreviewBytes <= 0 || size <= maxPreviewBytes;
}

/** 按扩展名取语言标注 */
function langLabel(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (/\.(md|markdown|mdx)$/i.test(name)) return "Markdown";
  return LANG_LABELS[ext] ?? "文本";
}

/** FilePreview：预览覆盖层（含加载态/错误态/三类渲染分支） */
export function FilePreview({ path, name, size, scope, onBack, onUnauthorized, inSplit = false }: FilePreviewProps) {
  /** 文本预览数据（图片路径不请求） */
  const [data, setData] = useState<FilePreviewResult | null>(null);
  /** 加载错误文案（null = 无错误） */
  const [error, setError] = useState<string | null>(null);
  /** 请求竞态序号（快速切换预览时丢弃过期响应） */
  const [reqSeq] = useState({ seq: 0 });

  const isImage = IMAGE_EXT_RE.test(name);

  // 非图片：拉取 preview 端点（图片走 download 直链 <img>，无需请求）
  useEffect(() => {
    if (isImage) return;
    const seq = ++reqSeq.seq;
    setData(null);
    setError(null);
    fetchPreview(path, scope)
      .then((result) => {
        if (reqSeq.seq === seq) setData(result);
      })
      .catch((e: unknown) => {
        if (reqSeq.seq !== seq) return;
        // 401：会话已失效——上抛统一收敛登录页，不在失效会话下展示错误态
        if (e instanceof ApiError && e.status === 401 && onUnauthorized) {
          onUnauthorized();
          return;
        }
        setError(e instanceof ApiError ? `${e.message}` : "预览加载失败");
      });
    // reqSeq 为恒定对象引用（仅承载序号），无需进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, scope, isImage]);

  // Esc 返回列表（抽屉在预览态期间的键盘交互）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Markdown → A2UI 消息序列（与对话消息同一管线；代码/图片不解析）
  const markdownMessages = useMemo(
    () => (data !== null && MARKDOWN_EXT_RE.test(name) ? parseMarkdownToA2ui(data.text, `file-${path}`) : null),
    [data, name, path]
  );

  // 代码/纯文本 → 行号行数组（尾部换行不产生空尾行）
  const codeLines = useMemo(() => {
    if (data === null || markdownMessages !== null || isImage) return null;
    const text = data.text;
    return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  }, [data, markdownMessages, isImage]);

  return (
    <div
      className={inSplit ? "file-preview file-preview-split" : "file-preview"}
      role="region"
      aria-label={`预览 ${name}`}
    >
      {/* 预览头：返回（窄屏覆盖态）+ 文件名 + 类型徽标 + 大小 + 下载；
          并排态（inSplit）隐藏返回按钮——列表就在右栏，返回语义统一为关闭预览 */}
      <div className="file-preview-head">
        {!inSplit && (
          <button type="button" className="icon-btn" title="返回列表" onClick={onBack}>
            <BackIcon size={16} />
          </button>
        )}
        <span className="file-preview-name" title={path}>
          {name}
        </span>
        <span className="file-preview-badge">{langLabel(name)}</span>
        <span className="file-preview-size">{humanSize(size)}</span>
        <a className="icon-btn" href={fileDownloadUrl(path, scope)} download={name} title="下载原文件">
          <DownloadIcon size={15} />
        </a>
      </div>

      {/* 预览体：图片 / Markdown / 代码文本 / 错误 */}
      <div className="file-preview-body">
        {isImage ? (
          <img className="file-preview-image" src={fileDownloadUrl(path, scope)} alt={name} loading="lazy" />
        ) : error !== null ? (
          <div className="file-preview-error">
            <p>{error}</p>
            <p className="file-preview-error-hint">该文件可点击下载原文件后本地查看。</p>
          </div>
        ) : data === null ? (
          <div className="drawer-hint">加载预览…</div>
        ) : markdownMessages !== null ? (
          <A2uiSurface messages={markdownMessages} className="a2ui-surface file-preview-markdown" />
        ) : (
          <pre className="file-preview-code">
            {codeLines?.map((line, i) => (
              <div className="code-line" key={i}>
                <span className="code-line-no">{i + 1}</span>
                <span className="code-line-text">{line === "" ? " " : line}</span>
              </div>
            ))}
          </pre>
        )}
        {data !== null && data.truncated && <div className="drawer-hint">文件过大，预览已截断</div>}
      </div>
    </div>
  );
}
