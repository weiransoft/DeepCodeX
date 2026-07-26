import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

/**
 * visualization/renderer.ts —— PureShowWidget 渲染器
 *
 * 职责：
 *   - 将 LLM 提交的 widget_code（HTML/SVG/CSS/JS 片段）包裹为自包含 HTML 文件
 *   - 在外层 HTML 中通过 <iframe sandbox="allow-scripts"> 隔离执行 widget_code，
 *     阻止其访问文件系统、Cookie、localStorage 等宿主资源
 *   - 将生成的 HTML 写入项目 .deepcodex/widgets/ 目录，返回文件绝对路径
 *
 * 设计原则：
 *   - 单一职责：仅负责 HTML 渲染与文件落盘，不参与工具调度
 *   - 自包含：生成的 HTML 不依赖任何外部资源（widget_code 自身引用 CDN 除外）
 *   - 安全沙箱：widget_code 在 iframe srcdoc 中执行，sandbox 仅放开 allow-scripts
 *
 * 依赖关系：
 *   - 被 widget-tool.ts 调用
 *   - 不依赖 ToolExecutionContext，可独立单测
 */

/**
 * 支持的 widget 类型枚举
 * - chart：数据图表（柱状图/折线图/饼图等）
 * - diagram：架构图/流程图
 * - card：信息卡片
 * - flow：状态流转/时序图
 * - custom：自定义类型（兜底）
 */
export type WidgetType = "chart" | "diagram" | "card" | "flow" | "custom";

/**
 * renderWidget 返回结果
 * - html：自包含 HTML 文件内容
 * - fileName：建议的文件名（不含路径）
 */
export interface RenderWidgetResult {
  html: string;
  fileName: string;
}

/**
 * WIDGET_TYPE 索引类型（用于内部映射校验）
 */
const VALID_WIDGET_TYPES: ReadonlySet<WidgetType> = new Set(["chart", "diagram", "card", "flow", "custom"]);

/**
 * 校验字符串是否为合法的 WidgetType
 *
 * @param value 待校验值
 * @returns 是否为合法的 widget 类型
 */
export function isValidWidgetType(value: string): value is WidgetType {
  return VALID_WIDGET_TYPES.has(value as WidgetType);
}

/**
 * 生成 widget 文件名
 *
 * 格式：`widget-{timestamp}-{random}.html`
 * - timestamp：毫秒级 Unix 时间戳，保证时间顺序可排序
 * - random：8 字符 hex 随机串，避免同毫秒并发冲突
 *
 * @returns 形如 `widget-1784886478123-a1b2c3d4.html` 的文件名
 */
function buildWidgetFileName(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString("hex");
  return `widget-${timestamp}-${random}.html`;
}

/**
 * 将 widget_code 包裹为自包含 HTML 文件
 *
 * 包裹策略：
 *   1. 外层 HTML 提供完整的 <!DOCTYPE>/head/body 结构，含 viewport meta 和基础样式
 *   2. widget_code 通过 <iframe srcdoc="..."> 嵌入，sandbox="allow-scripts" 限制能力
 *   3. iframe 占据满屏，widget 自管内部样式与脚本
 *   4. widget_code 中的特殊字符（&、<、>、"）经过 HTML 实体转义后嵌入 srcdoc 属性
 *
 * 安全考虑：
 *   - sandbox="allow-scripts" 允许 widget 内运行 JS（图表交互需要），但阻止：
 *     * 同源访问（iframe 来源为 null，与宿主不同源）
 *     * 表单提交、弹窗、顶级导航、modals 等危险能力
 *     * Cookie/localStorage/sessionStorage 访问（srcdoc 文档为 opaque origin）
 *   - widget_code 经 HTML 属性转义后嵌入，避免破坏外层 HTML 结构
 *
 * @param widgetCode widget 代码片段（HTML/SVG/CSS/JS，不含外层 html/head/body）
 * @param widgetType 可视化类型（chart/diagram/card/flow/custom）
 * @param title 可选标题（用于浏览器标签页与页面 H1）
 * @returns 自包含 HTML 字符串 + 文件名
 */
export function renderWidget(widgetCode: string, widgetType: string, title?: string): RenderWidgetResult {
  // 校验 widgetType，无效值降级为 custom（保证健壮性，不抛错）
  const normalizedType: WidgetType = isValidWidgetType(widgetType) ? widgetType : "custom";

  // 标题处理：未提供时使用默认值；过长截断避免布局破坏
  const safeTitle =
    typeof title === "string" && title.trim().length > 0
      ? title.trim().slice(0, 200)
      : `DeepCode Widget · ${normalizedType}`;

  // 生成文件名
  const fileName = buildWidgetFileName();

  // HTML 属性转义：保证 widgetCode 可安全嵌入 srcdoc 属性值
  // 顺序：先 & 再 < > 再 " —— 避免双重转义
  const escapedCode = escapeHtmlAttribute(widgetCode);

  // 组装自包含 HTML
  const html = buildHtmlShell(safeTitle, normalizedType, escapedCode, widgetCode.length);

  return { html, fileName };
}

/**
 * 将字符串转义为 HTML 属性值（用于嵌入 srcdoc="..." 属性中）
 *
 * 转义规则（按顺序应用，避免双重转义）：
 *   1. & → &amp;   （必须最先转义）
 *   2. < → &lt;
 *   3. > → &gt;
 *   4. " → &quot;  （srcdoc 用双引号包裹，必须转义双引号）
 *
 * @param value 原始字符串
 * @returns HTML 属性安全字符串
 */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 构建自包含 HTML 外壳
 *
 * 结构：
 *   <!DOCTYPE html>
 *   <html>
 *     <head>
 *       <meta charset>
 *       <meta viewport>
 *       <title>
 *       <style> 基础样式 </style>
 *     </head>
 *     <body>
 *       <header> 标题与类型徽章 </header>
 *       <main>
 *         <iframe sandbox="allow-scripts" srcdoc="escaped_widget_code">
 *       </main>
 *     </body>
 *   </html>
 *
 * @param title 页面标题
 * @param widgetType widget 类型徽章
 * @param escapedWidgetCode 已转义的 widget 代码（嵌入 srcdoc 属性）
 * @param widgetCodeLength 原始 widget 代码长度（用于页脚统计）
 * @returns 完整 HTML 文档字符串
 */
function buildHtmlShell(
  title: string,
  widgetType: WidgetType,
  escapedWidgetCode: string,
  widgetCodeLength: number
): string {
  // 标题 HTML 转义（用于 <title> 与 <h1> 内容）
  const safeTitleContent = escapeHtmlText(title);
  // 类型徽章大写显示
  const typeBadge = widgetType.toUpperCase();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="generator" content="DeepCodeX PureShowWidget">
  <meta name="widget-type" content="${escapeHtmlAttribute(widgetType)}">
  <title>${safeTitleContent}</title>
  <style>
    /* === 基础重置 === */
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Helvetica Neue", "PingFang SC", "Hiragino Sans GB",
                   "Microsoft YaHei", sans-serif;
      background: #ffffff;
      color: #1f2328;
    }
    /* 亮色默认（与 dynamic-ui token 体系对齐） */
    body {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    /* === 页头 === */
    .dcx-widget-header {
      padding: 12px 20px;
      border-bottom: 1px solid #d0d7de;
      background: #f6f8fa;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .dcx-widget-header h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: #1f2328;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dcx-widget-badge {
      display: inline-block;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: #6f42c1;
      background: #f1e6ff;
      border: 1px solid #d8b4fe;
      border-radius: 4px;
      text-transform: uppercase;
    }
    /* === iframe 容器 === */
    .dcx-widget-main {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    .dcx-widget-main iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: transparent;
    }
    /* === 页脚 === */
    .dcx-widget-footer {
      padding: 6px 20px;
      border-top: 1px solid #d0d7de;
      background: #f6f8fa;
      font-size: 11px;
      color: #6e7781;
      flex-shrink: 0;
    }
    /* === 暗色主题覆盖 === */
    @media (prefers-color-scheme: dark) {
      html, body { background: #0d1117; color: #e6edf3; }
      .dcx-widget-header {
        background: #161b22;
        border-bottom-color: #30363d;
      }
      .dcx-widget-header h1 { color: #e6edf3; }
      .dcx-widget-badge {
        color: #d8b4fe;
        background: #1f1729;
        border-color: #4c2889;
      }
      .dcx-widget-footer {
        background: #161b22;
        border-top-color: #30363d;
        color: #8b949e;
      }
    }
  </style>
</head>
<body>
  <header class="dcx-widget-header">
    <h1>${safeTitleContent}</h1>
    <span class="dcx-widget-badge">${escapeHtmlText(typeBadge)}</span>
  </header>
  <main class="dcx-widget-main">
    <iframe
      sandbox="allow-scripts"
      srcdoc="${escapedWidgetCode}"
      loading="eager"
      referrerpolicy="no-referrer"
    ></iframe>
  </main>
  <footer class="dcx-widget-footer">
    Generated by DeepCodeX PureShowWidget · type: ${escapeHtmlText(widgetType)} · size: ${widgetCodeLength} chars
  </footer>
</body>
</html>`;
}

/**
 * 将字符串转义为 HTML 文本内容（用于 <title>/<h1>/页脚等可见文本节点）
 *
 * 转义规则：& < > 三种字符（HTML 文本节点中 " 不强制转义）
 *
 * @param value 原始字符串
 * @returns HTML 文本安全字符串
 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 将 HTML 内容保存到项目 .deepcodex/widgets/ 目录
 *
 * 行为：
 *   - 自动创建 .deepcodex/widgets/ 目录（含父目录，递归）
 *   - 文件已存在时覆盖（基于文件名时间戳+随机数，实际冲突概率极低）
 *   - 同步写入，调用方无需等待
 *
 * 异常处理：
 *   - 目录创建失败或文件写入失败时抛出 Error
 *   - 调用方（widget-tool handler）应捕获并返回 ToolExecutionResult.error
 *
 * @param html HTML 文件内容
 * @param fileName 文件名（不含路径，由 renderWidget 生成）
 * @param projectRoot 项目根目录
 * @returns 文件绝对路径
 */
export function saveWidget(html: string, fileName: string, projectRoot: string): string {
  // 校验项目根目录非空
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("saveWidget 失败：projectRoot 不能为空");
  }
  // 校验文件名非空且不含路径分隔符（防止路径穿越）
  if (!fileName || typeof fileName !== "string") {
    throw new Error("saveWidget 失败：fileName 不能为空");
  }
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new Error(`saveWidget 失败：fileName 含非法路径字符 (${fileName})`);
  }

  // 构造 widgets 目录路径：{projectRoot}/.deepcodex/widgets/
  const widgetsDir = path.join(projectRoot, ".deepcodex", "widgets");

  // 递归创建目录（recursive: true 等同于 mkdir -p，已存在时不报错）
  try {
    fs.mkdirSync(widgetsDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`saveWidget 失败：无法创建 widgets 目录 ${widgetsDir} (${message})`);
  }

  // 构造完整文件路径
  const filePath = path.join(widgetsDir, fileName);

  // 同步写入文件（UTF-8 编码）
  try {
    fs.writeFileSync(filePath, html, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`saveWidget 失败：无法写入文件 ${filePath} (${message})`);
  }

  // 返回绝对路径（path.join 已规范化，但显式 resolve 确保绝对）
  return path.resolve(filePath);
}
