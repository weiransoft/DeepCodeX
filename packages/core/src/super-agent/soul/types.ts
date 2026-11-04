/**
 * Soul（灵魂）类型契约 —— 四层人格模型 + 分类记忆
 *
 * ## 为什么要「四层」而不是一段人设描述
 *
 * 一段自由文本人设的问题不是不好看，而是**不可变与可变的边界糊在一起**：
 * 模型今天听到「你叫司南，做事果断」，明天被一段长上下文顶掉，就漂了。
 * 分层解决的是**变更频率**问题：
 *
 * | 层 | 变更频率 | 作用 |
 * |---|---|---|
 * | 核心本质 CoreEssence | 几乎不变 | 谁、为什么存在、绝不做什么 |
 * | 人格矩阵 PersonalityMatrix | 极少变 | 稳定的行为倾向（OCEAN / 价值观） |
 * | 情感状态 EmotionalState | 每轮可变 | 语气与强度的短期调节 |
 * | 表达风格 ExpressionStyle | 很少变 | 怎么说（详略、口头禅、禁忌） |
 *
 * 越下层越可动、越上层越稳定，这就是「有活人感但不精分」：
 * 情绪会变，人不变。
 *
 * ## 记忆为什么要分类
 *
 * 对开发场景来说，「记住了什么」比「记得多」重要得多。同一个助手，
 * 记得「这个仓库用 pnpm 且提交信息走 conventional commits」比记得
 * 一百句闲聊有用。因此记忆条目带 `category`（开发核心类别，见 `taxonomy.ts`）、
 * `sensitivity`（是否凭证）、`strength`（强度，可增可减）。
 *
 * ## 与 V2 `v2/memory` 的关系
 *
 * V2 MemoryEntry 是「键值 + 置信度」，没有强度、没有敏感性、没有激活计数，
 * 且不提供 update（无法做衰减与合并）。Soul 记忆需要这些字段才能「整理」，
 * 因此单独一层，持久化在 `~/.deepcode/soul/memory.json`。
 * 两者不互相覆盖：V2 记忆是上下文素材，Soul 记忆是长期画像。
 *
 * @module super-agent/soul/types
 */

/**
 * 名称身份
 *
 * 主名用于自称与署名；昵称与偏好称呼给出「怎么叫都行」的空间，
 * 避免用户换个叫法助手就「不认识自己」。
 */
export interface NameIdentity {
  /** 主名称（自称、署名） */
  readonly primary: string;
  /** 英文名（日志 / 非中文界面） */
  readonly latin?: string;
  /** 昵称 */
  readonly nicknames?: readonly string[];
  /** 用户偏好称呼（若设置，优先用这个自称） */
  readonly preferred?: string;
}

/**
 * 起源故事
 *
 * 不是文学装饰：它给模型一个「我为什么在这里」的稳定解释，
 * 在长对话里比一句「你是助手」更抗漂移。
 */
export interface OriginStory {
  /** 背景（从哪来） */
  readonly background: string;
  /** 形成性经历（怎么变成现在这样） */
  readonly formativeExperience: string;
  /** 当前使命（现在为什么在这） */
  readonly currentMission: string;
}

/**
 * 核心本质（Layer 1）—— 不可变层
 */
export interface CoreEssence {
  /** 名称身份 */
  readonly name: NameIdentity;
  /** 本质（一句话说清「是什么」） */
  readonly nature: string;
  /** 存在目的 */
  readonly purpose: string;
  /** 核心信念（指导行为的根本原则，3~5 条） */
  readonly coreBeliefs: readonly string[];
  /** 不可逾越的边界（绝不做的事） */
  readonly inviolableBoundaries: readonly string[];
  /** 起源故事 */
  readonly origin: OriginStory;
}

/**
 * OCEAN 五因素特质（0~1）
 *
 * 用连续值而非标签，是为了让「偏谨慎」和「略谨慎」能区分开——
 * 二元标签在提示词里只会退化成形容词堆砌。
 */
export interface OceanTraits {
  /** 开放性：高 = 好奇、愿意试新方案 */
  readonly openness: number;
  /** 尽责性：高 = 有条理、交付前自检 */
  readonly conscientiousness: number;
  /** 外向性：高 = 主动表达 */
  readonly extraversion: number;
  /** 宜人性：高 = 配合、少对抗 */
  readonly agreeableness: number;
  /** 神经质：高 = 情绪波动大（助手应偏低） */
  readonly neuroticism: number;
}

/**
 * 道德准则条目
 */
export interface MoralPrinciple {
  /** 准则名 */
  readonly name: string;
  /** 具体含义（可直接进提示词的一句话） */
  readonly description: string;
}

/**
 * 人格矩阵（Layer 2）
 */
export interface PersonalityMatrix {
  /** OCEAN 五因素 */
  readonly ocean: OceanTraits;
  /** MBTI（仅作表达倾向提示，不当作硬约束） */
  readonly mbti: string;
  /** 道德准则 */
  readonly moralCompass: readonly MoralPrinciple[];
  /** 价值观优先级（数字越小越优先） */
  readonly values: Readonly<Record<string, number>>;
  /** 自定义认知特质（如「怀疑度」「拆解粒度」） */
  readonly cognitiveTraits?: Readonly<Record<string, number>>;
}

/**
 * 情感基调
 *
 * 比 woagent 的七档多了 `CURIOUS`——开发场景里「这事有点意思，我看看」
 * 是高频且有用的状态，缺了它助手只剩「专业」一种声音。
 */
export type EmotionalTone =
  | "NEUTRAL"
  | "ENTHUSIASTIC"
  | "THOUGHTFUL"
  | "PLAYFUL"
  | "SERIOUS"
  | "ANALYTICAL"
  | "EMPATHETIC"
  | "CURIOUS";

/**
 * 情感状态（Layer 3）—— 唯一每轮可变的层
 */
export interface EmotionalState {
  /** 基础基调（无上下文触发时的默认） */
  readonly baseline: EmotionalTone;
  /** 当前基调 */
  readonly current: EmotionalTone;
  /** 强度（0~1） */
  readonly intensity: number;
  /** 波动性（0~1，越高越容易被上下文带动） */
  readonly volatility: number;
  /** 触发上下文（最近一次改变情绪的那句话，截断保存） */
  readonly triggeredBy?: string;
  /** 触发时间（ISO 8601） */
  readonly triggeredAt?: string;
}

/**
 * 沟通风格
 */
export type CommunicationStyle = "DIRECT" | "ANALYTICAL" | "NARRATIVE" | "INDIRECT" | "SUPPORTIVE";

/**
 * 表达风格（Layer 4）
 */
export interface ExpressionStyle {
  /** 沟通风格 */
  readonly communicationStyle: CommunicationStyle;
  /** 正式度（0~1） */
  readonly formality: number;
  /** 详细度（0~1） */
  readonly detailLevel: number;
  /** 口头禅（用作语气锚点，不是每句都要说） */
  readonly catchphrases: readonly string[];
  /** 禁忌表达（绝不说的话，如空话、过度承诺） */
  readonly forbiddenExpressions: readonly string[];
  /** 表情风格（自然语言描述，不强制 emoji） */
  readonly emojiStyle: string;
  /** 幽默风格 */
  readonly humorStyle: string;
}

/**
 * 决策风格（用户画像）
 */
export type DecisionStyle = "QUICK" | "DEEP_ANALYSIS" | "COLLABORATIVE" | "DATA_DRIVEN" | "INTUITIVE";

/**
 * 用户画像 —— 「更懂用户」的落点
 *
 * 不是给用户打标签，而是**减少重复问**：决策偏快的人不需要每次都收到
 * 三方对比；说「先跑起来」的人不需要被追问三轮需求。
 */
export interface UserProfile {
  /** 称呼（助手怎么称呼用户） */
  readonly addressAs: string;
  /** 决策风格 */
  readonly decisionStyle: DecisionStyle;
  /** 沟通偏好（可直接执行的短句） */
  readonly communicationPreferences: readonly string[];
  /** 工作习惯 */
  readonly workHabits: readonly string[];
  /** 禁忌话题 / 不要主动提的事 */
  readonly forbiddenTopics: readonly string[];
  /** 汇报偏好（如「先结论后证据」「带文件路径」） */
  readonly reportingPreference: string;
  /** 常用语言 */
  readonly language: string;
}

/**
 * 记忆分类标识（开发核心能力）
 *
 * 这十个类别就是「助手该记住什么」的清单：项目在哪、怎么部署、用什么凭证、
 * 守什么规范、跑什么命令、偏好什么节奏、踩过什么坑。
 */
export type MemoryCategory =
  | "project"
  | "deploy"
  | "credential"
  | "convention"
  | "environment"
  | "command"
  | "preference"
  | "lesson"
  | "people"
  | "domain";

/**
 * 敏感性：决定该条目能否进提示词
 *
 * - `normal`：原文进提示词
 * - `secret`：**只进「已记录」占位**，值不离开本地存储（见 `render.ts`）
 */
export type MemorySensitivity = "normal" | "secret";

/**
 * 记忆条目（Soul 层）
 *
 * 与 V2 MemoryEntry 的差异都在这里：`strength` 可增可减、`activationCount`
 * 记录被召回次数（用于整理时的冷热判断）、`sensitivity` 控制是否遮蔽。
 */
export interface SoulMemory {
  /** 唯一标识 */
  readonly id: string;
  /** 分类 */
  readonly category: MemoryCategory;
  /** 键（稳定标识，同一 key 视为同一条事实的更新） */
  readonly key: string;
  /** 人类可读标题（如「生产部署位置」） */
  readonly title: string;
  /** 值（事实内容；secret 类不渲染进提示词） */
  readonly value: string;
  /** 敏感性 */
  readonly sensitivity: MemorySensitivity;
  /** 强度（0~1，越高越容易进提示词） */
  readonly strength: number;
  /** 被召回次数 */
  readonly activationCount: number;
  /** 来源 */
  readonly source: "user_explicit" | "observed" | "system_default";
  /** 创建时间（ISO 8601） */
  readonly createdAt: string;
  /** 更新时间（ISO 8601） */
  readonly updatedAt: string;
  /** 最后召回时间（ISO 8601） */
  readonly lastRecalledAt?: string;
  /** 标签 */
  readonly tags?: readonly string[];
}

/**
 * 记忆持久化文件结构
 */
export interface SoulMemoryFile {
  /** 格式版本 */
  readonly version: 1;
  /** 作用域（global = 跨项目；project = 绑定单个项目） */
  readonly scope: "global" | "project";
  /** 条目 */
  readonly entries: readonly SoulMemory[];
  /** 最后更新时间（ISO 8601） */
  readonly lastUpdated: string;
}

/**
 * Soul 聚合
 */
export interface Soul {
  /** Soul 标识 */
  readonly id: string;
  /** 预设名（如 `SINAN`） */
  readonly preset: string;
  /** Layer 1 */
  readonly essence: CoreEssence;
  /** Layer 2 */
  readonly personality: PersonalityMatrix;
  /** Layer 3（可变：`adaptToContext` 返回新对象而非原地改） */
  readonly emotion: EmotionalState;
  /** Layer 4 */
  readonly expression: ExpressionStyle;
  /** 用户画像 */
  readonly user: UserProfile;
  /** 记忆（按需加载，可为空） */
  readonly memories: readonly SoulMemory[];
}

/**
 * 记忆召回结果（带分数，便于 UI 与测试断言）
 */
export interface RecalledMemory {
  /** 条目 */
  readonly memory: SoulMemory;
  /** 综合分数（0~1） */
  readonly score: number;
  /** 分数构成（调试与「为什么想起这条」的解释） */
  readonly reasons: readonly string[];
}

/**
 * 记忆整理报告（`organize()` 的产出）
 */
export interface OrganizeReport {
  /** 合并（同 key 多条 → 一条）次数 */
  readonly merged: number;
  /** 因强度过低被归档（active=false 删除）的条数 */
  readonly pruned: number;
  /** 整理后条目数 */
  readonly total: number;
  /** 分类分布 */
  readonly byCategory: Readonly<Record<MemoryCategory, number>>;
  /** 人类可读结论（供 CLI / Web 直接展示） */
  readonly notes: readonly string[];
}

/**
 * 记忆存储端口（内核不碰文件系统，由 `soul-io.ts` 实现）
 */
export interface SoulMemoryStore {
  /** 读取（文件不存在返回空文件，不抛错） */
  load(): SoulMemoryFile;
  /** 覆盖写入（实现负责原子性） */
  save(file: SoulMemoryFile): void;
}

/**
 * Soul 快照（Web / CLI 展示用的稳定结构）
 */
export interface SoulSnapshot {
  /** 身份签名（如 `司南（Sinan）· 常驻主理智能体`） */
  readonly signature: string;
  /** 一句话职责 */
  readonly tagline: string;
  /** 名称身份 */
  readonly name: NameIdentity;
  /** 本质 */
  readonly nature: string;
  /** 使命 */
  readonly purpose: string;
  /** 核心信念 */
  readonly coreBeliefs: readonly string[];
  /** 边界 */
  readonly boundaries: readonly string[];
  /** MBTI */
  readonly mbti: string;
  /** OCEAN */
  readonly ocean: OceanTraits;
  /** 价值观（按优先级排序后的数组） */
  readonly values: readonly { readonly name: string; readonly priority: number }[];
  /** 当前情感 */
  readonly emotion: { readonly tone: EmotionalTone; readonly label: string; readonly intensity: number };
  /** 表达风格摘要 */
  readonly expression: {
    readonly style: CommunicationStyle;
    readonly formality: number;
    readonly detailLevel: number;
    readonly catchphrases: readonly string[];
    readonly forbidden: readonly string[];
  };
  /** 用户画像 */
  readonly user: UserProfile;
  /** 记忆分组（按类别） */
  readonly memoryGroups: readonly MemoryGroup[];
  /** 记忆统计 */
  readonly memoryStats: {
    readonly total: number;
    readonly byCategory: Readonly<Record<MemoryCategory, number>>;
    /** 尚未记录的类别（驱动用户补齐，而不是假装知道） */
    readonly missing: readonly MemoryCategory[];
  };
  /** 记忆整理报告 */
  readonly organization: OrganizeReport;
  /** 提示词预览（实际注入模型的那段，便于可观测） */
  readonly promptPreview: string;
}

/**
 * 记忆分组（UI 按类别折叠展示）
 */
export interface MemoryGroup {
  /** 分类 */
  readonly category: MemoryCategory;
  /** 中文名 */
  readonly label: string;
  /** 采集提示（该类别该记什么） */
  readonly hint: string;
  /** 条目（secret 已遮蔽） */
  readonly items: readonly MemoryItemView[];
}

/**
 * 记忆条目视图（脱敏后）
 */
export interface MemoryItemView {
  /** ID */
  readonly id: string;
  /** 标题 */
  readonly title: string;
  /** 值（secret 为遮蔽串） */
  readonly value: string;
  /** 是否被遮蔽 */
  readonly redacted: boolean;
  /** 强度 */
  readonly strength: number;
  /** 更新时间 */
  readonly updatedAt: string;
  /** 来源 */
  readonly source: SoulMemory["source"];
}
