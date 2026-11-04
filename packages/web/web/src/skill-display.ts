/**
 * 技能展示名（web 展示层唯一来源）
 *
 * ## 为什么需要这一层
 *
 * 技能的 `name` 与智能体一样是**技术标识**：kebab-case、全小写，同时是
 * `~/.deepcode/skills/<name>/` 的目录名、`@name` 提及的 token。改成中文会
 * 直接打断这两条链路（智能体的中文名在 frontmatter `role` 里，技能没有
 * 对应字段——多数第三方技能的 frontmatter 只有英文 name + 英文 description）。
 *
 * 因此这里做两件事：
 *
 * 1. **中文名称**：`skillDisplayName()` 从内置中文目录查表命中即给中文名，
 *    未命中回退技术标识（绝不显示空白，绝不猜译）。
 * 2. **功能简介**：`skillDisplaySummary()` 优先用技能自身 frontmatter 的
 *    `description`（那是作者写的功能说明，最权威）；描述缺失或为空时，
 *    用内置目录里的中文简介兜底。
 *
 * ## 中文目录的维护约定
 *
 * 目录按**技术标识**索引（`name`），键与磁盘目录名、@ 提及 token 严格一致。
 * 新增条目时：中文名用名词短语（不含「技能」二字，界面已有徽标），
 * 简介一句话说清「做什么、什么时候用」，不超过 40 字。
 *
 * @module skill-display
 */

/** 展示所需的最小字段集（`CapabilitySkill` 结构上直接兼容） */
export interface SkillDisplaySource {
  /** 技术标识（kebab-case，@ 提及与目录名同源） */
  name: string;
  /** frontmatter `description`：作者写的功能说明（可能为空） */
  description?: string;
}

/** 中文目录条目 */
interface SkillZhEntry {
  /** 中文名称 */
  title: string;
  /** 中文功能简介（description 缺失时的兜底） */
  summary: string;
}

/** 中日韩字符（用于判断描述是否已是中文） */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 内置技能中文目录
 *
 * 覆盖三类来源：
 * - 本仓内置技能（packages/core/templates/skills/bundled）——自研，译文确定；
 * - 用户级第三方技能（~/.agents/skills 等）——按实际安装的常见项收录；
 * - Trae IDE 内置技能（~/.trae-cn/builtin_skills）。
 *
 * 未收录的技能走回退路径：中文名 = 技术标识，简介 = frontmatter description。
 */
const SKILL_ZH_CATALOG: ReadonlyMap<string, SkillZhEntry> = new Map<string, SkillZhEntry>([
  // ── 本仓内置技能 ──
  [
    "browser-automation",
    { title: "浏览器自动化", summary: "通过 Chrome DevTools MCP 做网页打开、前端测试、截图与性能分析。" },
  ],
  [
    "code-mode-orchestrator",
    { title: "代码模式编排", summary: "引导模型按任务特征选择 Dynamic Workflows 编排模式执行。" },
  ],
  ["deepcode-self-refer", { title: "DeepCode 自述", summary: "解答 DeepCode CLI 自身的功能、配置与使用方式。" }],
  ["docx", { title: "Word 文档处理", summary: "创建、编辑与解析 .docx 文档，支持批注与修订。" }],
  ["dynamic-ui", { title: "动态可视化", summary: "在回答旁生成紧凑内联图表、流程图与对比视图。" }],
  ["eag-acl", { title: "EAG 防腐层", summary: "防腐层模式与外部模型翻译，隔离外部系统腐化。" }],
  ["eag-aggregate-design", { title: "EAG 聚合设计", summary: "聚合内一致性规则、工厂方法与仓储接口归属。" }],
  ["eag-cqrs-separation", { title: "EAG CQRS 分离", summary: "命令/查询模型分离、事件处理器与投影器模式。" }],
  ["eag-domain-modeling", { title: "EAG 领域建模", summary: "聚合边界五问、实体与值对象判别树、领域事件提取。" }],
  ["eag-saga-orchestration", { title: "EAG Saga 编排", summary: "编排式 Saga、补偿动作与幂等消费。" }],
  ["eag-verify-enterprise", { title: "EAG 企业红线自检", summary: "企业红线自检清单，作为各阶段验证的评估辅助材料。" }],
  ["html-deck", { title: "HTML 演示文稿", summary: "生成自包含的 HTML 幻灯片，浏览器直接放映。" }],
  ["html-report", { title: "HTML 报告", summary: "生成结构化 HTML 报告、数据看板与白皮书。" }],
  ["image-generator", { title: "图像生成", summary: "依据文本或本地图片生成与编辑图像。" }],
  ["pdf", { title: "PDF 处理", summary: "提取 PDF 文本与表格、合并拆分文档。" }],
  ["pptx", { title: "PPT 演示文稿", summary: "创建、编辑与解析 PowerPoint 演示文稿。" }],
  ["skill-digester", { title: "技能描述优化", summary: "审阅并改进其他技能的 description 字段质量。" }],
  ["skill-writer", { title: "技能编写", summary: "指导创建、更新、调试与校验 Agent Skill。" }],
  ["video-generator", { title: "视频生成", summary: "依据文字与参考素材生成带对白与环境音的视频。" }],
  ["web-artisan", { title: "全栈 Web 开发", summary: "React/Vue/Express/Supabase 等全套 Web 开发指南。" }],
  ["web-dev", { title: "Web 从零开发", summary: "从 PRD 到技术文档再到代码的绿地 Web 开发全流程。" }],
  ["xlsx", { title: "Excel 表格处理", summary: "打开、读取、编辑、创建与校验电子表格。" }],

  // ── 用户级第三方技能（~/.agents/skills）──
  ["agent-browser", { title: "浏览器代理", summary: "面向 AI 智能体的浏览器自动化命令行工具。" }],
  ["android-native-dev", { title: "Android 原生开发", summary: "Android 原生应用开发与界面设计指南。" }],
  ["find-skills", { title: "技能发现", summary: "帮助用户检索并安装可用智能体技能。" }],
  ["flutter-dev", { title: "Flutter 开发", summary: "Flutter 跨平台开发与组件模式指南。" }],
  ["frontend-dev", { title: "前端开发", summary: "高品质前端开发，含动效设计与媒体素材生成。" }],
  ["fullstack-dev", { title: "全栈开发", summary: "全栈后端架构与前后端集成落地指南。" }],
  ["gif-sticker-maker", { title: "GIF 表情包制作", summary: "把照片、头像或 Logo 转成 4 帧 GIF 动图。" }],
  ["ios-application-dev", { title: "iOS 应用开发", summary: "iOS 应用开发指南，覆盖 UIKit、SwiftUI 与 SnapKit。" }],
  ["minimax-docx", { title: "Word 文档处理（MiniMax）", summary: "基于 OpenXML 的专业 docx 创建、编辑与排版。" }],
  ["minimax-multimodal-toolkit", { title: "多模态工具集", summary: "调用 MiniMax 多模态模型进行图文理解与生成。" }],
  ["minimax-pdf", { title: "PDF 处理（MiniMax）", summary: "面向视觉质量与设计规范的 PDF 生成与编辑。" }],
  ["minimax-xlsx", { title: "Excel 处理（MiniMax）", summary: "打开、创建、读取、分析、编辑与校验表格文件。" }],
  ["nano-banana-2-image-gen", { title: "图片生成（Nano Banana）", summary: "文生图、视觉信息图生成与既有图片编辑。" }],
  ["office-to-md", { title: "Office 转 Markdown", summary: "把 Office 文档批量转换为 Markdown。" }],
  ["pdf-extraction", { title: "PDF 内容提取", summary: "用 pdfplumber 提取 PDF 文本、表格与元数据。" }],
  // 该技能的 frontmatter `name` 是 "PDF OCR Extraction"（带空格大写，与目录名
  // `pdf-ocr-extraction` 不一致），引擎按 frontmatter 取名，故两个键都收录。
  ["pdf-ocr-extraction", { title: "PDF 文字识别", summary: "对扫描件 PDF 做 OCR 文字提取。" }],
  ["PDF OCR Extraction", { title: "PDF 文字识别", summary: "对扫描件 PDF 做 OCR 文字提取。" }],
  ["pptx-generator", { title: "PPT 生成器", summary: "从零生成、编辑与读取 PowerPoint 演示文稿。" }],
  ["pr-review", { title: "PR 审查", summary: "审查拉取请求的代码变更并给出评审意见。" }],
  ["react-native-dev", { title: "React Native 开发", summary: "React Native 与 Expo 开发、样式与组件指南。" }],
  ["remotion-best-practices", { title: "Remotion 视频开发", summary: "Remotion 视频创作的最佳实践与写法。" }],
  ["shader-dev", { title: "着色器开发", summary: "GLSL 着色器技巧与视觉效果实现。" }],
  ["ui-ux-pro-max", { title: "UI/UX 设计", summary: "UI/UX 设计智能：规划、构建、评审与改进界面。" }],
  ["understand", { title: "代码库理解", summary: "分析代码库并生成交互式知识图谱。" }],
  ["understand-chat", { title: "代码库问答", summary: "就代码库提问，获得带上下文的回答。" }],
  ["understand-dashboard", { title: "理解看板", summary: "启动交互式看板可视化代码库知识图谱。" }],
  ["understand-diff", { title: "变更解读", summary: "解读 git diff 与 PR 中的变更内容。" }],
  ["understand-explain", { title: "代码讲解", summary: "对指定文件、函数做深度剖析讲解。" }],
  ["understand-onboard", { title: "上手指南", summary: "为新成员生成代码库上手指南。" }],
  ["web-design-engineer", { title: "Web 设计工程", summary: "用 HTML/CSS/JS 构建高质量视觉 Web 作品。" }],

  // ── Trae IDE 内置技能（~/.trae-cn/builtin_skills）──
  ["TRAE-code-review", { title: "通用代码审查", summary: "对 MR/PR、提交与分支差异做通用代码审查。" }],
  ["TRAE-debugger", { title: "证据驱动调试", summary: "采集运行时证据，定位并闭环修复复杂问题。" }],
  ["TRAE-generate-mini-app", { title: "小程序生成", summary: "创建、生成与修改可运行的小程序项目。" }],
  ["TRAE-security-review", { title: "安全审查", summary: "对代码差异做安全扫描与漏洞审查。" }],
]);

/**
 * 技能中文显示名
 *
 * @param skill 能力条目（至少含 name）
 * @returns 目录命中时给中文名；未命中回退技术标识
 *
 * @example
 * skillDisplayName({ name: "frontend-dev" })  // => "前端开发"
 * skillDisplayName({ name: "my-own-skill" })  // => "my-own-skill"
 */
export function skillDisplayName(skill: SkillDisplaySource): string {
  return SKILL_ZH_CATALOG.get(skill.name)?.title ?? skill.name;
}

/**
 * 技能功能简介
 *
 * 三级优先（目标：界面上的简介一律是中文，英文描述只作最后兜底）：
 * 1. frontmatter `description` **本身是中文** → 直接用（自研内置技能多为中英混写，
 *    中文优先能保住最贴切的原文）；
 * 2. 目录里的中文简介（覆盖第三方英文描述的技能，如 `frontend-dev`）；
 * 3. frontmatter 原始 description（目录未收录时至少不丢信息）。
 *
 * @param skill 能力条目（至少含 name）
 * @returns 功能简介；全无时返回空字符串
 */
export function skillDisplaySummary(skill: SkillDisplaySource): string {
  const description = (skill.description ?? "").trim();
  const entry = SKILL_ZH_CATALOG.get(skill.name);
  if (description !== "") {
    if (entry === undefined || CJK_PATTERN.test(description)) {
      return description;
    }
    // 目录有中文译文但原始描述是英文 → 用中文译文
    return entry.summary;
  }
  return entry?.summary ?? "";
}
