# 共识收敛报告 —— better-harness-enhancement proposal v1 评审

> 四角色评审：架构师 6.5/10、产品经理 6/10、测试专家 6/10、独立开发者 6/10，均为「有条件通过」。
> 收敛规则：🔴 阻断问题 ≥2 角色同时提出 → 必须修改；🟡 建议 ≥3 角色 → 采纳。

## 一、共识问题清单（必须修改）

| # | 问题 | 提出角色 | 修法（已纳入 v2） |
|---|---|---|---|
| C1 | **路径/锚点全面失真**（4/4 角色提出）：`sedimentation-writer.ts` 实际在 `packages/core/src/agents/`（候选生成在 `eag/dynamic/sedimentation-suggester.ts`）；memory 体系在 `v2/memory/`（redaction.ts 为 `v2/memory/redaction.ts`）；execution-history 实为 `v2/memory/execution-history-store.ts`（数据落 `~/.deepcode/`）；`eag/verdict.ts`、`independent-evaluator.ts`、`session-runtime.ts` 均不存在；skills 为单文件 `skill-manager.ts`；评估器真实模型是 `eag/evaluator/types.ts` 的 `EvaluationVerdict`（PASS/FIX/HUMAN_CHECKPOINT 三值，非二值） | 全部 | v2 全部锚点重写为真实路径，P4 基于三值 verdict 重写 |
| C2 | **P3 与 T02 冲突**（架构师+开发者）：T02 已合并进 main 且非「在途」；`SedimentationWriter` 是白名单字段写入器，方案新增的 Finding 字段（evidence/impact/verifyRoute）会被白名单静默丢弃 | 架构师、开发者 | Finding 契约放在 suggester 输出侧；writer 白名单显式扩展新字段；方案改为「衔接已合并的 T02」 |
| C3 | **P1 Exercised 归因不可靠**（架构师+开发者+测试）：skill 内容被引用的归因是启发式，消息级匹配噪声大；P1 的 `/rules` 验收引用了不存在的 CLI 命令（PM+开发者） | 架构师、开发者、测试 | P1 首期 record-only（只记 Wired + 注入计数，Exercised 留扩展点）；证据查看载体统一为 P2 bundle + Web 审计页签 |
| C4 | **P4 缺评分结构**（架构师+开发者）：现有 EvaluationVerdict 无维度评分概念，天花板机制无处安放 | 架构师、开发者 | P4 拆两步：先定义 dimensionScores 结构（可选字段，向后兼容），再接七级证据状态与天花板常量表 |
| C5 | **P5 验收不可量化**（PM+测试）：「不产生误报风暴」无断言 | PM、测试 | 量化验收：已知重复流程样本检出率 100%、单次建议 ≤5 条、人工抽检精确率 ≥80%；目录改为 `eag/discovery/` |

## 二、建议采纳（≥3 角色）

- **目录约定统一**（PM+架构师）：仓库并存 `.deepcode` 与 `.deepcodeX`，P6 起新写统一 `.deepcodeX`，读取兼容旧路径（双读单写），不迁移存量。
- **P2 需 Web 暴露**（PM+测试）：bundle 结果经 API 同源暴露到 SettingsDrawer「审计」页签，Web/桌面用户才有证据入口。
- **P6 渲染器骨架先行**（测试+开发者）：先交付 schema 校验 + MD 渲染，HTML/趋势图后置。

## 三、分歧点

- **P1 是否首期就做 Exercised**：测试专家认为可先做（violationCount 已是 Exercised 信号），开发者认为消息级归因噪声大。**裁决**：规则侧采纳测试意见（violation 事件已有确定性来源，规则 Exercised 首期可做）；技能侧采纳开发者意见（record-only）。
- **P6 范围**：PM 建议 Web 趋势图进首期，架构师认为依赖台账数据积累、后置合理。**裁决**：趋势图后置为 P6.1。

## 四、结论

方案方向与价值获四角色一致认可（方法论移植正确、复用意识强、隐私设计严谨），阻断问题全部集中在「锚点失真」与「与已合并代码的衔接」两类工程事实问题，均可通过 v2 勘误解决。**共识达成：按 v2 修订后通过，可进入排期。**
