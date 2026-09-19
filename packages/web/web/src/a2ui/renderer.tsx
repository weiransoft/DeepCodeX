/**
 * A2UI 渲染器：surface 状态机 + 基础目录 React 组件树（R9，设计文档 §3.7）。
 *
 * 组成：
 * 1. reduceSurface()：纯函数状态机，按序应用四类标准消息
 *    （beginRendering / surfaceUpdate / dataModelUpdate / deleteSurface）；
 * 2. A2uiSurface()：React 包装组件——对消息流归约出状态后从 root 递归渲染组件树；
 * 3. 基础目录原语：Text / Heading / Card / Row / Column / List / Divider / Image /
 *    Button / Chart；其余原语（Tabs/Modal/Video/Audio/Slider/Icon/Checkbox/TextField 等）
 *    渲染为语义等价兜底组件（显示其文本属性 + 「A2UI: <类型>」角标），绝不静默丢弃、绝不崩溃。
 *
 * 安全约束（设计文档 §3.6）：
 * - 全部文本以 React 文本节点渲染，禁用 dangerouslySetInnerHTML / innerHTML；
 * - 链接与图片地址做协议白名单校验（javascript: 等一律拒绝）；
 * - DynamicString "${path}" 从 dataModel 取值，取不到显示原始占位串。
 */
import { Component, useMemo, useState, type ReactNode } from "react";
import { ChartView } from "./chart";
import type { A2uiButtonAction, A2uiChartSpec, A2uiComponent, A2uiMessage, A2uiSurfaceState } from "./types";

/** 递归渲染的层级上限：防御外部 surface 出现 childIds 环引用导致栈溢出 */
const MAX_RENDER_DEPTH = 100;

/**
 * 创建初始 surface 状态。
 * @returns 空状态（未 begin、无根、无组件、空数据模型）
 */
function createInitialSurfaceState(): A2uiSurfaceState {
  return {
    started: false,
    rootId: null,
    components: new Map<string, A2uiComponent>(),
    dataModel: {},
  };
}

/**
 * surface 状态机归约：按序应用消息流，返回最终状态快照。
 * 纯函数（不修改入参），便于单元测试与 React memo。
 *
 * - beginRendering：重置状态并记录 root（一个 surface 以最后一次 begin 为准）；
 * - surfaceUpdate：组件按 id 合并覆盖（邻接表语义）；
 * - dataModelUpdate：contents 与已有数据模型浅合并（顶层键覆盖）；
 * - deleteSurface：清空该 surface 全部状态；
 * - 无法识别的消息形态：防御性忽略（外部输入不保证可信，绝不让渲染崩溃）。
 */
export function reduceSurface(messages: A2uiMessage[]): A2uiSurfaceState {
  let state = createInitialSurfaceState();
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;

    if ("beginRendering" in msg && msg.beginRendering) {
      // 重新 begin：等价于重建 surface
      const next = createInitialSurfaceState();
      next.started = true;
      next.rootId = typeof msg.beginRendering.root === "string" ? msg.beginRendering.root : null;
      state = next;
      continue;
    }
    if ("surfaceUpdate" in msg && msg.surfaceUpdate) {
      const { components } = msg.surfaceUpdate;
      if (Array.isArray(components)) {
        // Map 不可变更新：拷贝后逐个覆盖
        const next = new Map(state.components);
        for (const c of components) {
          if (
            c !== null &&
            typeof c === "object" &&
            typeof c.id === "string" &&
            c.component &&
            typeof c.component === "object"
          ) {
            next.set(c.id, c);
          }
        }
        state = { ...state, components: next };
      }
      continue;
    }
    if ("dataModelUpdate" in msg && msg.dataModelUpdate) {
      const { contents } = msg.dataModelUpdate;
      if (contents !== null && typeof contents === "object" && !Array.isArray(contents)) {
        // 浅合并：顶层键覆盖
        state = { ...state, dataModel: { ...state.dataModel, ...contents } };
      }
      continue;
    }
    if ("deleteSurface" in msg && msg.deleteSurface) {
      // 销毁：回到初始空状态
      state = createInitialSurfaceState();
      continue;
    }
    // 未知消息：忽略
  }
  return state;
}

/**
 * 从 dataModel 按 "a.b.0.c" 点分路径取值；数组下标以数字段表示。
 * @returns 找到且为原始值（string/number/boolean）时返回字符串化结果，否则 null
 */
function lookupDataPath(model: Record<string, unknown>, path: string): string | null {
  const segments = path.split(".");
  let cur: unknown = model;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") {
    return String(cur);
  }
  return null;
}

/**
 * 解析 DynamicString 的数据绑定：
 * - 整串为单一路径绑定（"${a.b}"）：命中取值；未命中保留原始占位串；
 * - 内嵌绑定（"文本 ${a.b} 文本"）：逐个替换，未命中的占位保持原文。
 */
export function resolveDynamicString(text: string, model: Record<string, unknown>): string {
  // 快速路径：不含绑定标记则原样返回
  if (!text.includes("${")) return text;
  const full = /^\$\{([^{}]+)\}$/.exec(text.trim());
  if (full) {
    return lookupDataPath(model, full[1].trim()) ?? text;
  }
  return text.replace(/\$\{([^{}]+)\}/g, (whole, path: string) => lookupDataPath(model, path.trim()) ?? whole);
}

/**
 * 判断 url 是否可安全渲染（协议白名单）。
 * 链接：http/https/mailto 及站内相对路径；图片：http/https/data:image/blob。
 */
function isSafeHref(url: string): boolean {
  return /^(https?:\/\/|mailto:|\/|#|\.\/)/i.test(url);
}
function isSafeImageSrc(url: string): boolean {
  return /^(https?:\/\/|data:image\/|blob:)/i.test(url);
}

/**
 * 行内 Markdown 解析：把纯文本解析为 React 元素序列。
 * 支持语法（任务指定子集）：**粗体** / *斜体* / `行内代码` / [链接](url)。
 * 未闭合标记按字面文本处理；所有内容均为 React 文本节点（XSS 安全）。
 * 优先级：`code` 最高（内部不再解析其它标记，保持代码字面量）。
 */
export function parseInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  let i = 0;

  /** 推进一个纯文本节点 */
  const pushText = (s: string) => {
    if (s.length > 0) nodes.push(s);
  };

  while (i < text.length) {
    const ch = text[i];

    // 行内代码 `...`：内部内容保持字面量
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        nodes.push(
          <code key={key++} className="a2ui-inline-code">
            {text.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
      pushText(ch);
      i++;
      continue;
    }

    // 粗体 **...**：内部递归解析（允许嵌套斜体/代码/链接）
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        nodes.push(<strong key={key++}>{parseInlineMarkdown(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
      pushText(ch);
      i++;
      continue;
    }

    // 斜体 *...*：内容不含星号，递归解析
    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        nodes.push(<em key={key++}>{parseInlineMarkdown(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
      pushText(ch);
      i++;
      continue;
    }

    // 链接 [label](url)：协议白名单校验，不安全地址按普通文本渲染
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        const url = m[2];
        if (isSafeHref(url)) {
          nodes.push(
            <a key={key++} href={url} target="_blank" rel="noopener noreferrer" className="a2ui-inline-link">
              {parseInlineMarkdown(m[1])}
            </a>
          );
        } else {
          // 不安全协议（如 javascript:）：降级为纯文本，绝不生成可点击地址
          nodes.push(`${m[1]}（${url}）`);
        }
        i += m[0].length;
        continue;
      }
      pushText(ch);
      i++;
      continue;
    }

    // 普通字符：累积到下一个标记字符
    let j = i + 1;
    while (j < text.length && text[j] !== "`" && text[j] !== "*" && text[j] !== "[") {
      j++;
    }
    pushText(text.slice(i, j));
    i = j;
  }
  return nodes;
}

/** 组件渲染上下文：状态 + 递归深度（用于环引用防护） */
interface RenderCtx {
  state: A2uiSurfaceState;
  depth: number;
}

/** 安全复制文本到剪贴板：clipboard API 优先，失败回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（http）下 clipboard API 不可用：回退到临时 textarea 方案
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Text 原语属性（渲染层视角） */
interface TextPropsView {
  text?: unknown;
  variant?: unknown;
  bold?: unknown;
}

/**
 * Text 原语渲染：
 * - body：div + 行内标记解析；
 * - monospace：pre 等宽（代码块内容，保持字面量，不做行内解析）；
 * - quote：blockquote 引用样式；
 * - bold=true：包一层 <strong>（表格表头）。
 */
function renderText(props: TextPropsView, ctx: RenderCtx): ReactNode {
  const raw = typeof props.text === "string" ? props.text : "";
  const variant = props.variant === "monospace" || props.variant === "quote" ? props.variant : "body";
  const resolved = resolveDynamicString(raw, ctx.state.dataModel);

  let inner: ReactNode;
  if (variant === "monospace") {
    // 代码内容保持字面量（含换行），pre-wrap 保留格式
    inner = resolved;
  } else {
    inner = parseInlineMarkdown(resolved);
  }
  if (props.bold === true) {
    inner = <strong>{inner}</strong>;
  }

  switch (variant) {
    case "monospace":
      return <pre className="a2ui-text-mono">{inner}</pre>;
    case "quote":
      return <blockquote className="a2ui-text-quote">{inner}</blockquote>;
    default:
      return <div className="a2ui-text">{inner}</div>;
  }
}

/** h1-h6 标签查表：数值 level 无法收窄为标签字面量联合，用查表规避模板字符串类型（TS1360） */
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * Heading 原语渲染：level 1-6 映射到 h1-h6 标签（类名控制视觉尺寸）。
 */
function renderHeading(props: { text?: unknown; level?: unknown }, ctx: RenderCtx): ReactNode {
  const raw = typeof props.text === "string" ? props.text : "";
  const level = typeof props.level === "number" && props.level >= 1 && props.level <= 6 ? Math.floor(props.level) : 1;
  const resolved = resolveDynamicString(raw, ctx.state.dataModel);
  const Tag: (typeof HEADING_TAGS)[number] = HEADING_TAGS[level - 1] ?? "h1";
  return <Tag className={`a2ui-heading a2ui-heading-${level}`}>{parseInlineMarkdown(resolved)}</Tag>;
}

/**
 * Card 原语渲染：标题栏（title + headerAction 动作按钮）+ 内容子组件。
 * headerAction 当前支持 copy（代码块复制按钮）；子组件经 childIds 引用递归渲染。
 */
function renderCard(props: { title?: unknown; childIds?: unknown; headerAction?: unknown }, ctx: RenderCtx): ReactNode {
  const title = typeof props.title === "string" ? resolveDynamicString(props.title, ctx.state.dataModel) : "";
  const childIds = Array.isArray(props.childIds)
    ? (props.childIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const action = (props.headerAction ?? null) as A2uiButtonAction | null;

  return (
    <div className="a2ui-card">
      {(title !== "" || action !== null) && (
        <div className="a2ui-card-header">
          <span className="a2ui-card-title">{title}</span>
          {action !== null && action.type === "copy" && typeof action.text === "string" && (
            <CopyButton text={action.text} />
          )}
        </div>
      )}
      <div className="a2ui-card-body">{childIds.map((id) => renderComponentById(ctx, id))}</div>
    </div>
  );
}

/** 复制按钮：点击复制目标文本，成功/失败给出即时反馈（2 秒后复原） */
function CopyButton({ text }: { text: string }) {
  const [feedback, setFeedback] = useState<"idle" | "ok" | "fail">("idle");

  /** 执行复制并根据结果展示反馈 */
  const onClick = (): void => {
    void copyText(text).then((ok) => {
      setFeedback(ok ? "ok" : "fail");
      window.setTimeout(() => setFeedback("idle"), 2000);
    });
  };

  return (
    <button type="button" className="a2ui-copy-btn" onClick={onClick} title="复制内容">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {/* 复制图标：两叠矩形 */}
        <rect x="5" y="5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H4.5A1.5 1.5 0 0 0 3 3.5v7A1.5 1.5 0 0 0 4.5 12H5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
      <span className="a2ui-copy-feedback">{feedback === "ok" ? "已复制" : feedback === "fail" ? "复制失败" : ""}</span>
    </button>
  );
}

/** Row / Column / List 原语渲染：flex 布局容器 + 子组件递归 */
function renderContainer(
  type: "Row" | "Column" | "List",
  props: { childIds?: unknown; gap?: unknown; direction?: unknown; wrap?: unknown },
  ctx: RenderCtx
): ReactNode {
  const childIds = Array.isArray(props.childIds)
    ? (props.childIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const gap = typeof props.gap === "number" && props.gap >= 0 ? props.gap : undefined;
  const style: React.CSSProperties = gap !== undefined ? { gap: `${gap}px` } : {};

  if (type === "Row") {
    // Row：横向 flex；wrap 属性控制换行
    const flexWrap = props.wrap === true ? "wrap" : "nowrap";
    return (
      <div className="a2ui-row" style={{ ...style, flexWrap }}>
        {childIds.map((id) => renderComponentById(ctx, id))}
      </div>
    );
  }
  if (type === "Column") {
    // Column：纵向 flex
    return (
      <div className="a2ui-column" style={style}>
        {childIds.map((id) => renderComponentById(ctx, id))}
      </div>
    );
  }
  // List：纵向/横向列表
  const dir = props.direction === "horizontal" ? "horizontal" : "vertical";
  return (
    <div className={`a2ui-list a2ui-list-${dir}`} style={style}>
      {childIds.map((id) => renderComponentById(ctx, id))}
    </div>
  );
}

/** Divider 原语渲染：水平分隔线 */
function renderDivider(): ReactNode {
  return <hr className="a2ui-divider" />;
}

/**
 * Image 原语渲染：协议白名单校验 + 加载失败降级为替代文本（不崩溃）。
 */
function renderImage(props: { url?: unknown; alt?: unknown }): ReactNode {
  const url = typeof props.url === "string" ? props.url : "";
  const alt = typeof props.alt === "string" ? props.alt : "";
  if (url === "" || !isSafeImageSrc(url)) {
    // 非法地址：显示替代文本 + 说明，不渲染 <img>
    return (
      <div className="a2ui-image a2ui-image-invalid">
        <span aria-hidden="true">🖼️</span>
        <span>{alt !== "" ? alt : "图片地址不可用"}</span>
      </div>
    );
  }
  return <ImageWithFallback url={url} alt={alt} />;
}

/** 图片加载失败兜底：onError 后切换为替代文本展示 */
function ImageWithFallback({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="a2ui-image a2ui-image-invalid">
        <span aria-hidden="true">🖼️</span>
        <span>{alt !== "" ? alt : "图片加载失败"}</span>
      </div>
    );
  }
  return (
    <img
      className="a2ui-image"
      src={url}
      alt={alt}
      loading="lazy"
      // 加载失败切换兜底展示（React 合成事件，安全）
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Button 原语渲染：label 文案 + 动作执行。
 * - copy：复制 action.text 到剪贴板；
 * - submit / 其它：显式提示"当前渲染层不支持该动作"（不静默、不伪造提交）。
 */
function renderButton(props: { label?: unknown; action?: unknown }): ReactNode {
  const label = typeof props.label === "string" ? props.label : "按钮";
  const action = (props.action ?? null) as A2uiButtonAction | null;
  return <A2uiButton label={label} action={action} />;
}

/** 带动作反馈的按钮实体（需要局部 state，独立成组件） */
function A2uiButton({ label, action }: { label: string; action: A2uiButtonAction | null }) {
  const [hint, setHint] = useState("");

  /** 点击处理：按动作类型分发，反馈文案 2.5 秒后自动清除 */
  const onClick = (): void => {
    if (action !== null && action.type === "copy" && typeof action.text === "string") {
      void copyText(action.text).then((ok) => {
        setHint(ok ? "已复制" : "复制失败");
        window.setTimeout(() => setHint(""), 2500);
      });
      return;
    }
    setHint("当前渲染层不支持该动作");
    window.setTimeout(() => setHint(""), 2500);
  };

  return (
    <span className="a2ui-button-wrap">
      <button type="button" className="a2ui-button" onClick={onClick}>
        {label}
      </button>
      {hint !== "" && <span className="a2ui-button-hint">{hint}</span>}
    </span>
  );
}

/** Chart 原语渲染：委托给纯 SVG 的 ChartView */
function renderChart(props: { chart?: unknown }): ReactNode {
  const spec = (props.chart ?? null) as A2uiChartSpec | null;
  if (spec === null || typeof spec !== "object" || !Array.isArray((spec as { series?: unknown }).series)) {
    // 规格缺失/畸形：显示说明而非崩溃
    return <div className="a2ui-fallback">图表数据不可用</div>;
  }
  return <ChartView spec={spec} />;
}

/** 未知属性键中可作为兜底展示的候选（按优先级排序） */
const FALLBACK_TEXT_KEYS = ["text", "title", "label", "name", "value", "placeholder", "alt", "url", "src"];

/**
 * 未实现原语的语义等价兜底渲染：
 * - 抽取组件属性中的字符串型可展示字段（text/title/label/...）逐行显示；
 * - 带「A2UI: <类型>」角标，明确标识为兜底呈现；
 * - 有 childIds 则继续递归渲染子组件；绝不静默丢弃、绝不崩溃。
 */
function renderFallback(type: string, props: Record<string, unknown>, ctx: RenderCtx): ReactNode {
  const lines: string[] = [];
  for (const key of FALLBACK_TEXT_KEYS) {
    const v = props[key];
    if (typeof v === "string" && v.length > 0) {
      lines.push(`${key}: ${resolveDynamicString(v, ctx.state.dataModel)}`);
    }
  }
  // 属性里没有可展示文本时，展示剩余字符串型属性（最多 4 条），保证信息不丢
  if (lines.length === 0) {
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === "string" && v.length > 0) {
        lines.push(`${k}: ${resolveDynamicString(v, ctx.state.dataModel)}`);
        if (lines.length >= 4) break;
      }
    }
  }
  const childIds = Array.isArray(props.childIds)
    ? (props.childIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  return (
    <div className="a2ui-fallback">
      <span className="a2ui-fallback-badge">A2UI: {type}</span>
      {lines.map((l, i) => (
        <div key={i} className="a2ui-fallback-line">
          {l}
        </div>
      ))}
      {childIds.map((id) => renderComponentById(ctx, id))}
    </div>
  );
}

/**
 * 按 id 渲染组件：查邻接表 → 分发到具体原语渲染器。
 * - id 不存在：渲染缺失占位（邻接表引用悬空时不崩溃）；
 * - 未知原语类型：走兜底渲染；
 * - 层级超限：渲染提示节点（防环引用栈溢出）。
 */
function renderComponentById(ctx: RenderCtx, id: string): ReactNode {
  const comp = ctx.state.components.get(id);
  if (comp === undefined) {
    return (
      <div key={id} className="a2ui-missing">
        [缺失组件: {id}]
      </div>
    );
  }
  if (ctx.depth >= MAX_RENDER_DEPTH) {
    return (
      <div key={`depth-${id}`} className="a2ui-missing">
        [组件层级超过 {MAX_RENDER_DEPTH} 层，已停止递归]
      </div>
    );
  }
  const nextCtx: RenderCtx = { state: ctx.state, depth: ctx.depth + 1 };
  return <ComponentNode key={id} ctx={nextCtx} comp={comp} />;
}

/**
 * 单组件渲染节点：解包 component 单键并分发；外层包错误边界，
 * 保证任何单个组件的渲染异常不会拖垮整个 surface。
 */
function ComponentNode({ ctx, comp }: { ctx: RenderCtx; comp: A2uiComponent }) {
  const entries = Object.entries(comp.component);
  const [type, props] = entries[0] ?? ["", {}];
  const propsObj = (props !== null && typeof props === "object" ? props : {}) as Record<string, unknown>;

  let node: ReactNode;
  try {
    node = dispatchComponent(type, propsObj, ctx);
  } catch {
    // 分发阶段异常：降级为兜底展示（保留原语类型与属性摘要）
    node = renderFallback(type || "Unknown", propsObj, ctx);
  }
  return <ErrorBoundary fallbackId={comp.id}>{node}</ErrorBoundary>;
}

/** 按原语类型分发到具体渲染函数 */
function dispatchComponent(type: string, props: Record<string, unknown>, ctx: RenderCtx): ReactNode {
  switch (type) {
    case "Text":
      return renderText(props as TextPropsView, ctx);
    case "Heading":
      return renderHeading(props as { text?: unknown; level?: unknown }, ctx);
    case "Card":
      return renderCard(props as { title?: unknown; childIds?: unknown; headerAction?: unknown }, ctx);
    case "Row":
      return renderContainer("Row", props, ctx);
    case "Column":
      return renderContainer("Column", props, ctx);
    case "List":
      return renderContainer("List", props, ctx);
    case "Divider":
      return renderDivider();
    case "Image":
      return renderImage(props as { url?: unknown; alt?: unknown });
    case "Button":
      return renderButton(props as { label?: unknown; action?: unknown });
    case "Chart":
      return renderChart(props as { chart?: unknown });
    default:
      // 未实现原语（Tabs/Modal/Video/Audio/Slider/Icon/Checkbox/TextField 等）：语义等价兜底
      return renderFallback(type, props, ctx);
  }
}

/**
 * 渲染阶段错误边界：任何子树抛错时降级为占位提示。
 * React 错误边界必须用类组件实现（官方机制），此处为唯一的类组件。
 */
class ErrorBoundary extends Component<{ fallbackId: string; children: ReactNode }, { failed: boolean }> {
  // 显式初始化 state（React 类组件不初始化时 this.state 为 null）
  override state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {
    // 渲染异常已被边界吸收：保留静默以避免控制台噪音；占位 UI 已向用户明示异常
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return <div className="a2ui-missing">[组件渲染异常: {this.props.fallbackId}]</div>;
    }
    return this.props.children;
  }
}

/** A2uiSurface 组件属性 */
export interface A2uiSurfaceProps {
  /** 标准 A2UI v0.8 消息流（JSONL 每行解析后的对象） */
  messages: A2uiMessage[];
  /** 附加到根容器的类名（可选） */
  className?: string;
}

/**
 * A2UI surface 渲染入口：
 * 1. 对消息流做一次性归约（useMemo 缓存，消息引用不变则不重算）；
 * 2. 未 begin / 无根：渲染 null（空 surface）；
 * 3. 从 rootId 递归渲染组件树。
 */
export function A2uiSurface({ messages, className }: A2uiSurfaceProps) {
  const state = useMemo(() => reduceSurface(messages ?? []), [messages]);
  if (!state.started || state.rootId === null) {
    return <div className={className ?? "a2ui-surface"} />;
  }
  const ctx: RenderCtx = { state, depth: 0 };
  return (
    <div className={className ?? "a2ui-surface"} data-a2ui-surface="true">
      {renderComponentById(ctx, state.rootId)}
    </div>
  );
}
