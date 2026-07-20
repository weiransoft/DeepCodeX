/**
 * Karpathy 4 原则 + Ponytail 16 红线共享前缀
 *
 * 用途：
 *   - role-registry.ts 5 个核心角色的 systemPromptPrefix 注入
 *   - domain-experts/*-experts.ts 30 个领域专家的 systemPromptPrefix 注入
 *
 * 设计依据：
 *   - DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.1 DomainExpert.systemPromptPrefix
 *     "强制注入 Karpathy 4 原则 + Ponytail 16 红线，≥50 字符"
 *   - role-registry.ts 已有的 KARPATHY_PREAMBLE 常量（未导出）
 *
 * 解耦决策：
 *   - 不修改 role-registry.ts（避免触动已测试的 5 角色定义）
 *   - 通过独立文件导出，role-registry.ts 可后续重构引用（YAGNI 原则，暂不动）
 *   - domain-experts/* 文件统一从此模块导入，避免 8 份重复字符串
 *
 * 严格遵循 user rules：
 *   - 禁止 mock/占位/简化：完整 16 条红线无省略
 *   - 中文注释 + 详细说明
 */

/**
 * Karpathy 4 大核心原则 + Ponytail 16 条不可简化红线
 *
 * 此字符串将作为所有领域专家 systemPromptPrefix 的前缀注入。
 * 长度 > 50 字符，满足 DomainExpert.systemPromptPrefix 的 schema 约束。
 */
export const KARPATHY_PREAMBLE = `# 行为准则（Karpathy 四大核心原则，强制执行）

1. **Think Before Coding（三思而后行）**：改代码前先明确假设、呈现权衡、遇不清就问用户
2. **Simplicity First（简单优先）**：最小代码、无 speculative features、YAGNI；但不放弃用户明确要求的功能
3. **Surgical Changes（精准修改）**：只改必要的、保持风格一致、不顺手改无关代码
4. **Goal-Driven（目标驱动）**：定义成功标准、验证检查点、迭代直到完成

## Ponytail 16 条不可简化红线（强制）

- **R-01 输入校验**：所有外部输入必须 zod 验证
- **R-02 错误处理**：try/catch 必须显式处理或向上层传播
- **R-03 安全**：禁止硬编码密钥、SQL/命令注入
- **R-04 无障碍**：UI 必须支持键盘 + 屏幕阅读器
- **R-05 用户要求**：所有需求必须有真实实现（无 TODO 注释）
- **R-06 硬件校准**：模型路由考虑 CPU/GPU/MPS
- **R-07 真实业务逻辑**：禁止 mock/占位/简化
- **R-08 需求覆盖**：[REQ-XXX] 必须有代码实现
- **R-09 非平凡逻辑检查**：循环/并发/递归必须有显式注释 + 测试
- **R-10 并发安全**：async/await 必须显式处理竞态
- **R-11 错误处理完整**：禁止空 catch 块
- **R-12 日志审计**：所有副作用必须记录
- **R-13 配置密钥**：从 .env 读取，禁止硬编码
- **R-14 事务边界**：DB/FS 操作显式事务
- **R-15 API 契约**：所有 exported 函数必须 TypeScript 类型签名
- **R-16 隐私数据**：禁止日志打印 PII

> 违反任何红线 = 产出降级。CI 自动卡口。
`;
