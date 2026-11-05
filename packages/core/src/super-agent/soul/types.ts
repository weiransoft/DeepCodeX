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
 * ## 与 V2 `v2/memory` 的关系：一套存储，两种视图
 *
 * 早期实现把 Soul 记忆单独放在 `~/.deepcode/soul/memory.json`，结果是
 * `/memory add` 记下的事司南读不到、司南记下的事 `/memory list` 看不到——
 * 同一份「事实」被分裂成两份互相不知道的副本。
 *
 * 现在统一到 V2 的 `MemoryStore`（`~/.deepcode/memory/global.json`、
 * `<projectRoot>/.deepcode/memory/project.json`）：
 *
 * - **Soul 是写者**：Soul 条目以 `MemoryEntry` 形态落盘，强度存 `confidence`，
 *   分类/标题/敏感性/激活计数存 `metadata.soul`，可无损还原；
 * - **V2 是既成事实**：已有的 V2 条目（含 7 维度与 facts）**只读**映射进 Soul，
 *   标记 `origin: "v2"`，引擎不会把它们写回，也不会在整理时裁掉；
 * - **删除双向生效**：在人格面板里忘掉一条 V2 事实，会真的从 V2 文件里删掉。
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
  /**
   * 数据来源层
   *
   * - `soul`（缺省）：本层写入，引擎负责持久化；
   * - `v2`：从 V2 `MemoryStore` 只读映射进来的既成事实，引擎**不写回**，
   *   整理时不衰减不裁剪；用户显式遗忘时才回写删除。
   */
  readonly origin?: "soul" | "v2";
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
 * 对话模式
 *
 * - `work`：工作模式。先定方位、先给结论，效率优先（默认）。
 * - `companion`：陪伴模式。先接住人、再谈事，情绪与关系优先。
 *
 * 模式的边界：只改**语气与表达倾向**（Layer 3/4）和一小部分人格倾向，
 * 不改 Layer 1（核心本质与不可逾越的边界）。否则「换个模式」就变成换个人，
 * 陪伴模式下开始编造、越权、泄露凭证——那不是陪伴，是失控。
 */
export type SoulMode = "work" | "companion";

/**
 * 陪伴模式的可调项
 *
 * 这些不是「人设开关」，而是把「热情」拆成可调的量：
 * 热情过高会变成噪音，过低又回到工作模式的克制。
 */
export interface SoulCompanionConfig {
  /** 称呼用户的昵称（空字符串 = 沿用 `user.addressAs`） */
  readonly addressAs: string;
  /** 热情度（0~1）：影响语气温度与感叹节制，不影响判断与如实 */
  readonly warmth: number;
  /** 主动性（0~1）：主动追问、主动开话题的强度 */
  readonly proactivity: number;
  /** 是否在合适时机鼓励用户联系现实中的人（防依赖，默认开） */
  readonly encourageHumanContact: boolean;
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
  /** 当前对话模式（缺省视为 `work`） */
  readonly mode?: SoulMode;
  /** 陪伴模式的可调项（mode=companion 时由引擎注入，渲染提示词用） */
  readonly companion?: SoulCompanionConfig;
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
  /**
   * 删除若干条目（可选）
   *
   * 只有「外部来源」的条目需要它：这些条目不在本层的覆盖写范围内，
   * 用户显式遗忘时必须回到原来的存储里删。
   */
  remove?(ids: readonly string[]): void;
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
  /** 当前对话模式 */
  readonly mode: SoulMode;
  /** 模式中文名（UI 直接展示） */
  readonly modeLabel: string;
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

// ---------------------------------------------------------------------------
// 形象与声音配置
// ---------------------------------------------------------------------------

/**
 * 头像配置
 *
 * 默认为应用图标裁出的兔狲脸，静态资源路径 /manul-avatar.png；用户可上传自定义图。
 * 自定义图以 dataUrl 存放：它是用户资产，不参与提示词，也不进仓库，
 * 由仓库根 .gitignore 里的 soul 目录规则一并接住。
 */
export interface SoulAvatarConfig {
  /** 默认兔狲 / 自定义 */
  readonly kind: "default" | "custom";
  /** 自定义头像（dataUrl）；kind=default 时缺省 */
  readonly dataUrl?: string;
}

/**
 * 语音合成引擎（与 sidecar 支持的实现一一对应）
 *
 * 取值来自本机实测：`mlx-audio` 0.6.4 的模型目录里**没有** CosyVoice2，
 * 中文可用且支持「用一句话描述音色」的是 Qwen3-TTS 的 VoiceDesign 变体。
 * 保留 kokoro 作为轻量兜底（中文一般，但确定能出声）。
 */
export type VoiceEngine = "qwen3-voicedesign" | "qwen3-customvoice" | "kokoro";

/**
 * 语音对话配置
 *
 * 全部字段都可缺省——`normalizeSoulConfig()` 会逐项兜底，
 * 因为这份配置可能被手改、被旧版本写过、被别的客户端改过。
 */
export interface SoulVoiceConfig {
  /** 总开关：关掉时语音入口不出现 */
  readonly enabled: boolean;
  /** 引擎（中文首选 qwen3-voicedesign；kokoro 是"至少能出声"的兜底） */
  readonly engine: VoiceEngine;
  /**
   * 音色。对 VoiceDesign 是**自然语言描述**（"成熟女性，中低音区…"），
   * 对 CustomVoice 是预置 speaker 名，对 kokoro 是音色 id。
   * 用描述而不是固定 id，是因为「御姐音」是一组声学倾向，
   * 不是某个现存音色——VoiceDesign 正是为这件事设计的。
   */
  readonly voice: string;
  /** 语速（0.5~2.0） */
  readonly speed: number;
  /** sidecar 地址（仅 http://，仅回环） */
  readonly endpoint: string;
  /** sidecar 鉴权 token（与 sidecar 启动时读取的同一份配置比对） */
  readonly token: string;
  /** 是否自动朗读助手回复 */
  readonly speakReplies: boolean;
  /**
   * 是否常驻监听唤醒词
   *
   * 默认关，且**不跟平台走**：总开关是"这个平台能不能用"，唤醒是
   * "愿不愿意让麦克风一直开着"——后者是隐私选择，只能用户自己点开。
   */
  readonly wakeEnabled: boolean;
  /** 唤醒词（1~12 字；空串由规范化兜底成默认值） */
  readonly wakeWord: string;
}

/**
 * 名字覆盖（用户可改）
 *
 * 名字不是界面文案：它同时进**提示词**（自称）、**署名**（消息气泡）、
 * **唤醒词默认值**与**界面标题**。四处必须同源，否则会出现「界面叫小南、
 * 模型自称司南」的分裂感。
 *
 * 因此这里只存用户显式改过的值：空串表示「没改过」，由 `SUPER_AGENT_IDENTITY`
 * 兜底。不把默认值落盘，是为了让默认名将来能升级而不被旧配置钉死。
 */
export interface SoulIdentityConfig {
  /** 中文名（自称、署名）；空串 = 用默认「司南」 */
  readonly name: string;
  /** 英文名（日志 / 非中文界面）；空串 = 用默认「Sinan」 */
  readonly nameEn: string;
}

/**
 * 司南的配置（`~/.deepcode/soul/config.json`）
 *
 * 与记忆分文件存放：记忆是**给模型的事实**（存 V2 memory 目录），
 * 配置是**给人的偏好**（形象、声音、对话模式、名字），生命周期与读取方都不同。
 */
export interface SoulConfig {
  /** 头像 */
  readonly avatar: SoulAvatarConfig;
  /** 语音 */
  readonly voice: SoulVoiceConfig;
  /** 名字（用户可改；空串表示沿用默认） */
  readonly identity: SoulIdentityConfig;
  /** 对话模式（work = 工作，companion = 陪伴） */
  readonly mode: SoulMode;
  /** 陪伴模式可调项（mode=work 时保留但不生效） */
  readonly companion: SoulCompanionConfig;
}
