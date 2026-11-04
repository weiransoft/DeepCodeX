/**
 * 记忆分类表 —— 「助手该记住什么」的权威清单
 *
 * ## 为什么要有分类，而不是一锅自由文本
 *
 * 自由文本记忆有三个必然结局：重复（同一件事记五条）、过期（改了地址旧条目还在）、
 * 权重平均（「生产密码在哪」和「用户喜欢蓝色」占同样篇幅）。
 * 分类把这三个问题变成可计算的问题：
 *
 * 1. **重复**——同 `category + key` 视为同一事实，后写覆盖（见 `upsertMemory`）；
 * 2. **过期**——`strength` 与 `updatedAt` 参与打分，旧的自然下沉；
 * 3. **权重**——类别自身带优先级，`credential` / `deploy` 永远排在 `preference` 之前。
 *
 * ## 十个类别从哪来
 *
 * 不是拍脑袋列全，而是从「一个开发助手每天被问什么」反推：
 * 代码在哪、怎么跑起来、发到哪、用什么账号、守什么规范、踩过什么坑。
 * 缺任何一类，助手就得回头问人；多出十类没人填，等于没有。
 *
 * @module super-agent/soul/taxonomy
 */

import type { MemoryCategory, MemorySensitivity } from "./types.js";

/**
 * 单个分类的定义
 */
export interface CategoryDefinition {
  /** 分类标识 */
  readonly id: MemoryCategory;
  /** 中文名（UI 与提示词标题） */
  readonly label: string;
  /** 采集提示：这一类该记什么（UI 空态引导 + 分类器说明） */
  readonly hint: string;
  /** 默认敏感性 */
  readonly sensitivity: MemorySensitivity;
  /**
   * 类别权重（0~1）
   *
   * 只影响召回排序，不影响存不存在。开发场景里「怎么部署」比「喜欢什么语气」
   * 更可能决定下一步动作，所以 deploy / credential 高于 preference。
   */
  readonly weight: number;
  /** 触发关键词（中文 + 英文；分类器按命中数打分） */
  readonly keywords: readonly string[];
}

/**
 * 分类表（顺序即提示词中的展示顺序）
 */
export const MEMORY_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: "project",
    label: "项目档案",
    hint: "项目地址、仓库 URL、本地路径、主分支、语言与技术栈",
    sensitivity: "normal",
    weight: 0.95,
    keywords: [
      "项目地址",
      "仓库",
      "仓库地址",
      "本地路径",
      "代码在",
      "代码路径",
      "repo",
      "repository",
      "git@",
      "github.com",
      "gitlab",
      "主分支",
      "monorepo",
    ],
  },
  {
    id: "deploy",
    label: "部署运行",
    hint: "部署位置（机器/域名/集群）、部署形式（docker/systemd/pm2/k8s/serverless）、发布命令",
    sensitivity: "normal",
    weight: 0.95,
    keywords: [
      "部署",
      "上线",
      "发布",
      "服务器",
      "机器",
      "域名",
      "端口",
      "docker",
      "kubernetes",
      "k8s",
      "pm2",
      "systemd",
      "nginx",
      "serverless",
      "vercel",
      "云函数",
      "容器",
      "镜像",
      "集群",
    ],
  },
  {
    id: "credential",
    label: "凭证",
    hint: "常用账号、密码、Token、密钥的存放位置与用途（值默认不进提示词）",
    sensitivity: "secret",
    weight: 0.9,
    keywords: [
      "密码",
      "口令",
      "账号",
      "账户",
      "token",
      "apikey",
      "api key",
      "密钥",
      "私钥",
      "secret",
      "credential",
      "凭据",
      "登录名",
      "管理员",
    ],
  },
  {
    id: "convention",
    label: "代码规范",
    hint: "命名、目录结构、提交信息、lint/format、测试与评审约定",
    sensitivity: "normal",
    weight: 0.85,
    keywords: [
      "规范",
      "约定",
      "风格",
      "命名",
      "目录结构",
      "提交信息",
      "commit",
      "conventional",
      "lint",
      "eslint",
      "prettier",
      "格式化",
      "测试用例",
      "评审",
      "review",
      "代码审查",
    ],
  },
  {
    id: "environment",
    label: "开发环境",
    hint: "运行时版本、包管理器、代理、端口占用、必需的环境变量",
    sensitivity: "normal",
    weight: 0.8,
    keywords: [
      "环境变量",
      "node 版本",
      "nodejs",
      "python 版本",
      "pnpm",
      "npm",
      "yarn",
      "bun",
      "代理",
      "proxy",
      "端口冲突",
      "依赖安装",
      "sdk",
      "虚拟环境",
    ],
  },
  {
    id: "command",
    label: "常用命令",
    hint: "构建、启动、测试、发布的固定命令（含参数与工作目录）",
    sensitivity: "normal",
    weight: 0.8,
    keywords: ["命令", "怎么跑", "怎么启动", "启动", "构建", "build", "npm run", "make", "脚本", "一键"],
  },
  {
    id: "preference",
    label: "协作偏好",
    hint: "语言、汇报风格、节奏、篇幅偏好、不喜欢的做法",
    sensitivity: "normal",
    weight: 0.6,
    keywords: ["偏好", "喜欢", "不喜欢", "别用", "不要", "汇报", "简洁", "详细", "语气", "先说结论", "风格偏好"],
  },
  {
    id: "lesson",
    label: "经验教训",
    hint: "踩过的坑、失败原因、验证方法、不能做的事",
    sensitivity: "normal",
    weight: 0.75,
    keywords: ["踩坑", "坑", "教训", "失败", "根因", "原因", "注意", "别碰", "曾经", "回归", "容易错"],
  },
  {
    id: "people",
    label: "人与关系",
    hint: "团队成员、对接人、审批人、负责模块",
    sensitivity: "normal",
    weight: 0.55,
    keywords: ["负责人", "对接人", "审批", "同事", "团队", "组长", "owner", "联系人", "找谁"],
  },
  {
    id: "domain",
    label: "领域知识",
    hint: "业务术语、行业约束、合规要求、口径定义",
    sensitivity: "normal",
    weight: 0.55,
    keywords: ["业务", "术语", "领域", "合规", "口径", "定义", "行业", "监管", "标准", "指标含义"],
  },
];

/** 分类 → 定义 的索引 */
const CATEGORY_INDEX: ReadonlyMap<MemoryCategory, CategoryDefinition> = new Map(
  MEMORY_CATEGORIES.map((definition) => [definition.id, definition])
);

/**
 * 取分类定义
 *
 * @param category 分类
 * @returns 定义（未知分类回落到 `domain`，不抛错——记忆不应因分类写错而丢失）
 */
export function categoryDefinition(category: MemoryCategory): CategoryDefinition {
  return CATEGORY_INDEX.get(category) ?? CATEGORY_INDEX.get("domain")!;
}

/**
 * 取分类中文名
 *
 * @param category 分类
 * @returns 中文名
 */
export function categoryLabel(category: MemoryCategory): string {
  return categoryDefinition(category).label;
}

/**
 * 全部分类（按展示顺序）
 *
 * @returns 分类 id 数组
 */
export function allCategories(): MemoryCategory[] {
  return MEMORY_CATEGORIES.map((definition) => definition.id);
}

/**
 * 生成空的分类计数
 *
 * @returns 全零计数
 */
export function emptyCategoryCount(): Record<MemoryCategory, number> {
  const counts = {} as Record<MemoryCategory, number>;
  for (const definition of MEMORY_CATEGORIES) counts[definition.id] = 0;
  return counts;
}

/**
 * 分类识别结果
 */
export interface ClassificationResult {
  /** 命中的分类 */
  readonly category: MemoryCategory;
  /** 置信度（0~1） */
  readonly confidence: number;
  /** 命中的关键词（用于解释「为什么归到这一类」） */
  readonly matched: readonly string[];
  /** 是否由默认规则回落（未命中任何关键词） */
  readonly fallback: boolean;
}

/**
 * 按文本归类记忆
 *
 * 规则简单但要**可解释**：命中关键词数最多的类别胜出，同分时按类别权重高者优先。
 * 不调用模型——分类是高频操作，走模型会让「记住一句话」变成昂贵动作，
 * 且模型分类结果不稳定，反而破坏「同一事实只有一条」。
 *
 * 未命中任何关键词时回落到 `preference`（用户陈述默认视为协作偏好），
 * 并置 `fallback: true`——调用方可以据此在 UI 上提示「已按偏好记录，可改分类」。
 *
 * @param text 记忆原文
 * @returns 分类结果
 */
export function classifyMemoryText(text: string): ClassificationResult {
  const normalized = text.toLowerCase();
  let best: { definition: CategoryDefinition; matched: string[]; score: number } | undefined;

  for (const definition of MEMORY_CATEGORIES) {
    const matched: string[] = [];
    for (const keyword of definition.keywords) {
      if (normalized.includes(keyword.toLowerCase())) matched.push(keyword);
    }
    if (matched.length === 0) continue;
    // 命中数为主，类别权重为次的微调（同分时高权重胜出）
    const score = matched.length + definition.weight * 0.1;
    if (best === undefined || score > best.score) {
      best = { definition, matched, score };
    }
  }

  if (best === undefined) {
    return { category: "preference", confidence: 0.35, matched: [], fallback: true };
  }

  // 置信度：命中 1 个 0.55 起，每多一个 +0.15，上限 0.95
  const confidence = Math.min(0.95, 0.55 + (best.matched.length - 1) * 0.15);
  return { category: best.definition.id, confidence, matched: best.matched, fallback: false };
}

/**
 * 判断分类是否敏感
 *
 * @param category 分类
 * @returns 是否默认敏感
 */
export function isSecretCategory(category: MemoryCategory): boolean {
  return categoryDefinition(category).sensitivity === "secret";
}

/**
 * 由标题生成稳定的记忆键
 *
 * 稳定性来自「只取 ASCII 词与数字」：中文标题转不成 slug 时用长度与首字哈希，
 * 这样同一句话重复录入得到的键一致，才能做覆盖而不是堆积。
 *
 * @param category 分类
 * @param title 标题
 * @returns 形如 `deploy.prod-host` / `convention.zh-a1b2c3`
 */
export function suggestMemoryKey(category: MemoryCategory, title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length >= 2) {
    return `${category}.${ascii.slice(0, 40)}`;
  }
  // 中文标题：取首字码点与长度做短哈希，保证稳定性（不用随机数）
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 100000;
  }
  return `${category}.zh-${hash.toString(36)}`;
}
