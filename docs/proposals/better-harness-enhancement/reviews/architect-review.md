# 架构师评审 —— proposal-v1

**总体评分：6.5/10 ｜ 结论：有条件通过**

## 维度简评
- 架构可行性：P2 证据包单命令、P3 finding-bound 建议与 EAG 既有 gate/evaluator 架构同构，方向正确；方法论移植而非代码照搬，判断准确。
- 集成路径：**多处锚点失真**（见阻断问题）。
- Ponytail 合规：无多余子系统，六项全落在 eag/ 内，合规。

## 🔴 阻断性问题
1. **B1 锚点失真**：`packages/core/src/eag/verdict.ts`、`independent-evaluator.ts` 不存在；真实模型是 `eag/evaluator/types.ts` 的 `EvaluationVerdict`（PASS/FIX/HUMAN_CHECKPOINT 三值，非二值 pass/fail）。P4 需基于三值重写。
2. **B2**：`sedimentation-writer.ts` 在 `packages/core/src/agents/`（非 eag/）；候选生成在 `eag/dynamic/sedimentation-suggester.ts`。P3 需改锚点。
3. **B3**：memory 体系在 `v2/memory/`，redaction.ts 为 `v2/memory/redaction.ts`。
4. **B4**：`session-runtime.ts` 不存在，主循环在 `session.ts`。
5. **B5**：execution-history 实为 `v2/memory/execution-history-store.ts`，数据落 `~/.deepcode/`（方案写 `.deepcodeX`）；仓库 `.deepcode` 与 `.deepcodeX` 并存，需先统一目录约定。

## 🟡 建议
- P1 skill Exercised 归因是启发式，消息级匹配噪声大，建议首期 record-only。
- P4 建议先定义 dimensionScores 结构再接天花板。
- P5 建议落 `eag/discovery/` 子域，避免 dynamic/ 职责膨胀。

## 🟢 亮点
- 对照矩阵的第 5 行（重复工作发现：数据已有、只差检测层）和第 8 行（纵向验证）识别精准，是真实的高价值空白。
- 隐私红线（脱敏失败宁可 Unobserved）与 BH 的 Unobserved 语义一致，方向正确。
