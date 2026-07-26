import type { ToolExecutionContext, ToolExecutionResult } from "../tools/executor";
import type { ToolDefinition } from "../prompt";
import { renderWidget, saveWidget, isValidWidgetType } from "./renderer";

/**
 * visualization/widget-tool.ts —— PureShowWidget 工具定义与处理函数
 *
 * 职责：
 *   - 暴露 PureShowWidget 工具的 schema 定义（pureShowWidgetToolDefinition）
 *   - 处理 LLM 调用 pure_show_widget(widget_code, widget_type, title?) 的请求
 *   - 调用 renderer.ts 渲染 HTML 并落盘，返回文件路径
 *
 * 工具契约（与 dynamic-ui SKILL.md §4 工具契约对齐）：
 *   - 参数 widget_code：完整的自包含 HTML/CSS/SVG/JS 片段（无外层 html/head/body）
 *   - 参数 widget_type：可视化类型标识（chart/diagram/card/flow/custom）
 *   - 参数 title：可选标题（用于浏览器标签页与页面 H1）
 *   - 返回：成功时含 metadata.filePath（绝对路径），失败时含 error 信息
 *
 * 注册位置：
 *   - prompt.ts 的 getTools()：根据 enabledSkills["dynamic-ui"] 条件注册
 *   - executor.ts 的 registerToolHandlers()：注册对应 handler
 *
 * 安全规则（与 dynamic-ui SKILL.md §7 安全规则对齐）：
 *   - widget_code 在 iframe sandbox="allow-scripts" 内执行
 *   - 禁止 widget_code 访问文件系统（iframe 沙箱隔离）
 *   - 生成的 HTML 文件为自包含（无外部依赖，除非 widget_code 自身引用 CDN）
 */

/**
 * PureShowWidget 工具 schema 定义
 *
 * 参考 prompt.ts 中其他工具的格式（如 WebSearch 工具，位于 prompt.ts 第 684-702 行）。
 *
 * 字段说明：
 *   - widget_code：widget 代码片段，应为不含外层 html/head/body 的自包含 HTML/CSS/SVG/JS
 *   - widget_type：可视化类型枚举，决定文件元数据与默认标题
 *   - title：可选标题，用于浏览器标签页与页面 H1，未提供时使用默认值
 */
export const pureShowWidgetToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "pure_show_widget",
    description:
      "渲染内联可视化 widget。接收 widget_code（HTML/SVG/图表代码）和 widget_type（chart/diagram/card/flow），" +
      "生成自包含 HTML 文件并返回文件路径。widget_code 应为不含外层 html/head/body 的自包含片段，" +
      "在外层 iframe sandbox 内执行，可访问允许的 CDN（cdnjs/esm.sh/jsdelivr/unpkg）。" +
      "调用后请在回复中提示用户在浏览器中打开返回的文件路径。",
    parameters: {
      type: "object",
      properties: {
        widget_code: {
          type: "string",
          description:
            "widget 代码片段。输出顺序：<style> → 内容 HTML/SVG → <script>（仅交互需要时）。" +
            "禁止 <!DOCTYPE>/<html>/<head>/<body> 等外层标签。" +
            "颜色/字体/间距/圆角应使用 dynamic-ui skill 的 token 体系（见 tokens/visual-tokens.md）。",
        },
        widget_type: {
          type: "string",
          enum: ["chart", "diagram", "card", "flow", "custom"],
          description:
            "可视化类型标识。chart=数据图表；diagram=架构/流程图；card=信息卡片；" +
            "flow=状态流转/时序图；custom=自定义类型（兜底）。",
        },
        title: {
          type: "string",
          description: "可选标题。用于浏览器标签页与页面 H1。未提供时使用默认值。",
        },
      },
      required: ["widget_code", "widget_type"],
      additionalProperties: false,
    },
  },
};

/**
 * PureShowWidget 工具处理函数
 *
 * 处理流程：
 *   1. 校验必填参数 widget_code 和 widget_type
 *   2. 调用 renderer.renderWidget() 生成自包含 HTML 与文件名
 *   3. 调用 renderer.saveWidget() 写入 {projectRoot}/.deepcodex/widgets/
 *   4. 返回 ToolExecutionResult，成功时 metadata.filePath 含绝对路径
 *
 * 错误处理：
 *   - 参数缺失或类型错误：返回 ok:false + error
 *   - 渲染或写入异常：捕获后返回 ok:false + error（不向上抛出）
 *
 * @param args 工具调用参数（已由 executor 解析 JSON 对象）
 * @param context 工具执行上下文（含 projectRoot）
 * @returns ToolExecutionResult
 */
export async function handlePureShowWidget(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const TOOL_NAME = "pure_show_widget";

  // === 参数校验 ===
  // widget_code：必填，非空字符串
  const widgetCode = args.widget_code;
  if (typeof widgetCode !== "string" || widgetCode.length === 0) {
    return {
      ok: false,
      name: TOOL_NAME,
      error: '参数 widget_code 必须为非空字符串（Parameter "widget_code" must be a non-empty string）',
    };
  }

  // widget_type：必填，合法枚举值
  const widgetType = args.widget_type;
  if (typeof widgetType !== "string" || widgetType.length === 0) {
    return {
      ok: false,
      name: TOOL_NAME,
      error: '参数 widget_type 必须为非空字符串（Parameter "widget_type" must be a non-empty string）',
    };
  }
  if (!isValidWidgetType(widgetType)) {
    return {
      ok: false,
      name: TOOL_NAME,
      error: `参数 widget_type 不合法，应为 chart/diagram/card/flow/custom 之一（Invalid widget_type "${widgetType}", expected one of: chart, diagram, card, flow, custom）`,
    };
  }

  // title：可选，字符串
  const title = typeof args.title === "string" ? args.title : undefined;

  // projectRoot：从 context 获取，必须存在
  const projectRoot = context.projectRoot;
  if (!projectRoot || typeof projectRoot !== "string") {
    return {
      ok: false,
      name: TOOL_NAME,
      error: "工具执行上下文缺少 projectRoot（ToolExecutionContext.projectRoot is missing）",
    };
  }

  // === 渲染与落盘 ===
  try {
    // 调用 renderer 生成自包含 HTML 与文件名
    const { html, fileName } = renderWidget(widgetCode, widgetType, title);

    // 落盘到 {projectRoot}/.deepcodex/widgets/{fileName}
    const filePath = saveWidget(html, fileName, projectRoot);

    // 构造成功结果
    return {
      ok: true,
      name: TOOL_NAME,
      output: `Widget 已渲染并保存到：${filePath}\n请在浏览器中打开该文件查看可视化内容。`,
      metadata: {
        filePath,
        fileName,
        widgetType,
        title: title ?? null,
        sizeBytes: Buffer.byteLength(html, "utf8"),
      },
    };
  } catch (error) {
    // 捕获渲染或写入异常，返回失败结果（不向上抛出，保证工具调用契约）
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name: TOOL_NAME,
      error: `Widget 渲染失败（Widget rendering failed）: ${message}`,
    };
  }
}
