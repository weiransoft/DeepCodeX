/**
 * Karpathy 四大核心原则 - 注入提示常量
 *
 * 来源：multi-agent-team skill v2.4+ Karpathy 4 原则
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 4 大核心原则：
 * 1. Think Before Coding（三思而后行）
 * 2. Simplicity First（简单优先）
 * 3. Surgical Changes（精准修改）
 * 4. Goal-Driven Execution（目标驱动执行）
 *
 * 提供：
 * - 4 原则完整 Markdown 文本
 * - 4 原则单条片段
 * - 原则组合：拼接多个原则（用于 system prompt 注入）
 *
 * 作者：trae-multi-agent 融合 Phase 1（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

/**
 * 4 大原则 ID
 */
export const KARPATHY_PRINCIPLE_IDS = {
  THINK_BEFORE_CODING: "think_before_coding",
  SIMPLICITY_FIRST: "simplicity_first",
  SURGICAL_CHANGES: "surgical_changes",
  GOAL_DRIVEN: "goal_driven",
} as const;

export type KarpathyPrincipleId = (typeof KARPATHY_PRINCIPLE_IDS)[keyof typeof KARPATHY_PRINCIPLE_IDS];

/** 所有 4 原则 ID（按推荐顺序：思考 → 简单 → 精准 → 目标） */
export const ALL_KARPATHY_PRINCIPLES: readonly KarpathyPrincipleId[] = [
  KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING,
  KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST,
  KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES,
  KARPATHY_PRINCIPLE_IDS.GOAL_DRIVEN,
];

/** 校验 Karpathy 原则 ID */
export function isValidKarpathyPrinciple(id: string): id is KarpathyPrincipleId {
  return (ALL_KARPATHY_PRINCIPLES as readonly string[]).includes(id);
}

// ============================================================================
// 原则 1：Think Before Coding
// ============================================================================

/**
 * Think Before Coding 原则完整内容
 */
export const THINK_BEFORE_CODING = `# 🧠 Think Before Coding（三思而后行）

改代码前先明确假设、呈现权衡、遇不清就问用户。

## 核心要求

1. **明确假设**：列出所有未经验证的假设
2. **呈现权衡**：多种方案时呈现给用户选择
3. **遇不清就问**：需求不明时停下来问，而不是猜
4. **文档化决策**：重要决策记录理由
5. **复盘总结**：完成后回顾假设是否正确

## 反模式（避免）

- ❌ 凭直觉写代码，假设"用户大概想要这样"
- ❌ 看到需求直接开干，不确认边界
- ❌ 实现到一半才发现需求理解错
- ❌ 提交代码后才问"这个功能要不要？"

## 应用场景

- 需求不明确：停下来问清楚
- 多种方案可选：呈现权衡让用户选
- 接口设计：先定义 contract，再实现
- 错误处理：先想清楚错误边界`;

// ============================================================================
// 原则 2：Simplicity First
// ============================================================================

/**
 * Simplicity First 原则完整内容
 */
export const SIMPLICITY_FIRST = `# 🎯 Simplicity First（简单优先）

最小代码、无 speculative features、YAGNI；但不放弃用户明确要求的功能。

## 核心要求

1. **YAGNI**：You Aren't Gonna Need It，不写未要求的代码
2. **最小可行**：先做最简单能用的版本
3. **无推测性需求**：不为"未来可能用到"加功能
4. **拒绝过度设计**：单次使用的抽象直接删
5. **KISS 原则**：Keep It Simple, Stupid

## 反模式（避免）

- ❌ 创建从未被复用的抽象类
- ❌ 引入新依赖解决 3 行能搞定的问题
- ❌ 为"未来可能扩展"预留配置项
- ❌ 写只有自己看得懂的"聪明"代码
- ❌ 提前优化未发生性能问题的代码

## 平衡原则

- ✅ 简单不等于简陋
- ✅ 用户明确要求的功能必须完整实现
- ✅ 安全/并发/事务边界不可简化
- ✅ 涉及金钱/隐私的逻辑不可压缩`;

// ============================================================================
// 原则 3：Surgical Changes
// ============================================================================

/**
 * Surgical Changes 原则完整内容
 */
export const SURGICAL_CHANGES = `# 🔬 Surgical Changes（精准修改）

只改必要的、保持风格一致、不顺手改无关代码。

## 核心要求

1. **最小变更面**：diff 越小越好
2. **风格一致**：保持与原有代码风格一致
3. **无关不碰**：看到不顺眼的代码不"顺便"改
4. **无格式化混杂**：不改无关的缩进/换行
5. **提交原子化**：一个 commit 只做一件事

## 反模式（避免）

- ❌ 在修 bug 时"顺便"重构无关函数
- ❌ 提交中混入了格式调整
- ❌ "顺手"修复发现的另一个 bug
- ❌ 大规模 reformat 与实际修改一起提交
- ❌ 删除原作者的有意为之的注释

## 改完后自检

- [ ] diff 是否只涉及直接相关的代码？
- [ ] 是否保持了原有代码风格？
- [ ] 是否修改了无关功能？
- [ ] 是否有格式化混杂？
- [ ] 注释是否被无意义删除？`;

// ============================================================================
// 原则 4：Goal-Driven Execution
// ============================================================================

/**
 * Goal-Driven Execution 原则完整内容
 */
export const GOAL_DRIVEN_EXECUTION = `# ✅ Goal-Driven Execution（目标驱动执行）

定义成功标准、验证检查点、迭代直到完成。

## 核心要求

1. **明确成功标准**：可量化的指标，不是"差不多就行"
2. **验证检查点**：分阶段验证，不到最后才测
3. **完成即闭环**：未达标前不算完成
4. **失败有回退**：明确中止条件
5. **可复现**：他人能按文档复现你的结果

## 反模式（避免）

- ❌ 没定义成功标准就开始
- ❌ "应该没问题吧"的心态
- ❌ 写完代码不运行
- ❌ 跳过分阶段验证
- ❌ 用"基本完成"代替"完成"

## 完成定义（DoD）

- [ ] 所有功能按需求文档实现
- [ ] 单元测试覆盖关键路径
- [ ] 集成测试通过
- [ ] 代码审查通过
- [ ] 文档更新完毕
- [ ] 已知缺陷已记录

## 验证检查点

1. **需求理解**：明确所有功能点
2. **设计评审**：方案已通过架构审查
3. **编码中**：每完成一个功能点即测试
4. **集成完成**：端到端测试通过
5. **发布前**：所有 DoD 勾选完毕`;

// ============================================================================
// 4 原则组合
// ============================================================================

/**
 * 4 原则按顺序的完整拼接
 *
 * 用于 system prompt 注入，包含全部 4 原则
 */
export const KARPATHY_4_PRINCIPLES_FULL = `# 行为准则（Karpathy 四大核心原则，强制执行）

1. **Think Before Coding（三思而后行）**：改代码前先明确假设、呈现权衡、遇不清就问用户
2. **Simplicity First（简单优先）**：最小代码、无 speculative features、YAGNI；但不放弃用户明确要求的功能
3. **Surgical Changes（精准修改）**：只改必要的、保持风格一致、不顺手改无关代码
4. **Goal-Driven（目标驱动）**：定义成功标准、验证检查点、迭代直到完成

${THINK_BEFORE_CODING}

${SIMPLICITY_FIRST}

${SURGICAL_CHANGES}

${GOAL_DRIVEN_EXECUTION}
`;

/**
 * 获取 4 原则的指定组合
 */
export function getKarpathyPrinciples(principles?: KarpathyPrincipleId[]): string {
  if (!principles || principles.length === 0) {
    return KARPATHY_4_PRINCIPLES_FULL;
  }

  const map: Record<KarpathyPrincipleId, string> = {
    [KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING]: THINK_BEFORE_CODING,
    [KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST]: SIMPLICITY_FIRST,
    [KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES]: SURGICAL_CHANGES,
    [KARPATHY_PRINCIPLE_IDS.GOAL_DRIVEN]: GOAL_DRIVEN_EXECUTION,
  };

  const selected = principles.map((p) => map[p] ?? "").filter((s) => s.length > 0);
  return selected.join("\n\n---\n\n");
}

/** 获取单个原则文本 */
export function getKarpathyPrinciple(principle: KarpathyPrincipleId): string {
  const map: Record<KarpathyPrincipleId, string> = {
    [KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING]: THINK_BEFORE_CODING,
    [KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST]: SIMPLICITY_FIRST,
    [KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES]: SURGICAL_CHANGES,
    [KARPATHY_PRINCIPLE_IDS.GOAL_DRIVEN]: GOAL_DRIVEN_EXECUTION,
  };
  return map[principle] ?? "";
}

/** 获取 4 原则的中文名称 */
export function getKarpathyPrincipleName(principle: KarpathyPrincipleId): string {
  const names: Record<KarpathyPrincipleId, string> = {
    [KARPATHY_PRINCIPLE_IDS.THINK_BEFORE_CODING]: "Think Before Coding（三思而后行）",
    [KARPATHY_PRINCIPLE_IDS.SIMPLICITY_FIRST]: "Simplicity First（简单优先）",
    [KARPATHY_PRINCIPLE_IDS.SURGICAL_CHANGES]: "Surgical Changes（精准修改）",
    [KARPATHY_PRINCIPLE_IDS.GOAL_DRIVEN]: "Goal-Driven Execution（目标驱动执行）",
  };
  return names[principle] ?? principle;
}
