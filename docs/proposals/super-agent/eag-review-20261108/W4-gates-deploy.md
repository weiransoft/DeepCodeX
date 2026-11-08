# W4 只读代码审查报告：gate / devops / deploy / doc-driven / design

- 仓库根：`/Users/wangwei/Documents/VG/DeepCodeX-cli`
- 审查范围：`packages/core/src/eag/{gate,devops,deploy,doc-driven,design}/**/*.ts`，共 **45 个 .ts 文件**（gate 11 / devops 10 / deploy 8 / doc-driven 8 / design 8），逐文件各占一行，无合并省略。
- 方法：Glob 取全量清单 → `/tmp/dcx-eag-scan.json` 定位命中行 → **逐个读源码确认**（重点文件全文精读，其余用 `grep -rEn` + 关键段精读交叉验证）。所有结论均指到源码行号；仅凭注释/推断无法定性的标 ⚠️ 并写明缺什么。
- 只读约束：未修改仓库内任何文件，唯一写入本文件。

## 一、逐文件结论表

| # | 文件（相对路径） | 行数 | 职责 | 结论 | 证据（行号:代码片段） | 严重级 | 建议 |
|---|---|---|---|---|---|---|---|
| 1 | packages/core/src/eag/gate/gate-orchestrator.ts | 398 | 门禁编排/短路求值 | ❌ 确证问题 | L270-281 `if(!LOOP_GATE_STRATEGY[loopType]) return {...allPassed:true...}`（design/deploy 跳过门禁仍报全绿）；L311-318 G-6/G-7 `missing-context` 跳过且 L331 注释"missing-context 不计入未通过"；L332-334 `const coverageGap=this.strictGateCoverage&&...; const allPassed=firstFailedGate===null&&!coverageGap`，L221 `strictGateCoverage = options?.strictGateCoverage===true`（默认 false）；L214-220 默认检查器仅注册 G-1/2/3/6/7，而 L99 coding 启用 `G-1..G-5` → G-4/G-5 无检查器默认不算失败 | P1 | 默认 `strictGateCoverage=true` 或默认注册全部门禁；skippedGates 非空时 `allPassed` 不得为 true；design/deploy 的 `allPassed:true` 改明确"未执行"语义 |
| 2 | packages/core/src/eag/gate/gate-g1-checker.ts | 104 | G-1 spec/plan 批准 | ✅ 未发现同类问题 | 已检查信息不足分支：L75 `if(context.specStatus!=="approved")`→`passed:false`、L86 同 planStatus→`passed:false`（undefined 亦 failed）；L97-102 仅全部满足才 `passed:true`。无 catch/截断/循环/默认放行 | — | — |
| 3 | packages/core/src/eag/gate/gate-g2-checker.ts | 202 | G-2 多角色评审+用户批准 | ✅ 未发现同类问题 | L128/139/150/162/174 逐项 `passed:false`（records 空→size 0<min 即 failed；`userApproved` 未设→failed）；L185-200 `passed:true` 均在前置全通过之后；L56-77 辅助函数纯集合运算 | — | — |
| 4 | packages/core/src/eag/gate/gate-g3-checker.ts | 195 | G-3 方案偏离检测 | ⚠️ 疑似需复核 | L135-141 `if(changes.length===0){return {...passed:true,reason:"无实际变更，无方案偏离"}}`——"确认无变更"与"变更采集失败/未填充导致空数组"未区分，信息不足可被当作通过；L165-193 偏离数≥3 failed、<3 通过（阈值内，判定诚实）。缺变更采集器调用方证据，无法确证是否会被空集触发 | P2 | 区分"确认零变更"与"未采集到变更"，后者返回 failed 或需显式确认 |
| 5 | packages/core/src/eag/gate/gate-g4-checker.ts | 238 | G-4 进入门禁 | ✅ 未发现同类问题 | L127-225 7 项（tasksStatus/declaredSymbols/acceptanceCriteria/fileCluster/requiredTemplateKinds/techStack/outputDir）任一缺失/空/未注册即 `passed:false`；L228-236 全通过才 true。L124 类型断言仅在字段齐全后取值 | — | — |
| 6 | packages/core/src/eag/gate/gate-g5-checker.ts | 232 | G-5 退出门禁 | ✅ 未发现同类问题 | L137-145 allTaskCards 空→false；L161-168 `!evaluationReport||verdict非法`→false；L170-183 verdict!=="pass"→false；L186/197 `gitClean!==true`/`gitleaksPassed!==true`→false（undefined 亦 failed）；L208 全通过才 true | — | — |
| 7 | packages/core/src/eag/gate/gate-g6-checker.ts | 162 | G-6 TESTING 进入 | ✅ 未发现同类问题 | L122-139 4 项 `!==true`/`!=="approved"` 收集 failures；L142-150 `failures.length>0`→`passed:false`；L153-160 全通过才 true。信息不足一律 failed | — | — |
| 8 | packages/core/src/eag/gate/gate-g7-checker.ts | 449 | G-7 TESTING 退出 | ⚠️ 疑似需复核 | 判定诚实：L189-355 逐项收集 failures、L358-366 `failures.length>0`→`passed:false`（coverageReport 缺失 L189 即 failed）。P2 截断：L350 `complianceSection.slice(0,80)` 失败原因里 head-only 截断段内容、丢尾部证据；L369 `hasIcp` 与 L246 `icpEnabled` 重复计算（统计口径冗余，无判定后果）；L419 `for(i<lines.length)` 是行遍历非轮询（C1 误报） | P2 | 失败证据改 tail 优先或全量；合并重复 icp 判定 |
| 9 | packages/core/src/eag/gate/gate-g8-checker.ts | 183 | G-8 部署就绪门禁 | ❌ 确证问题 | L148-154 / L156-162 注释："批次 13 暂固定为 true，由 DevOpsOrchestrator 构造上下文时固定为 true"；checker 仅 L152 `if(!context.monitoringReady)`、L160 `if(!context.rollbackPlanExists)`，L165 `const passed=failures.length===0`。触发路径：上游 devops-orchestrator L278-279 `?? true` → 两项恒真 → 监控告警/回滚预案永远判通过，真实状态不校验 | P0 | 删除上游 `?? true`，未配置传 false/抛错；L152/160 之外补真实检查器调用（见 #15） |
| 10 | packages/core/src/eag/gate/gate-types.ts | 636 | 门禁数据模型 | ➖ 不适用（纯类型/模板/静态数据） | 纯 `type`/`interface` + 冻结常量：L77 `REVIEW_ROLES=Object.freeze([...])`、L235 `GATE_IDS`、L404/415/424 数值常量；Grep 无 `function`/`=>`/`return` 运行时逻辑。L28 的 Object.freeze 仅为注释 | — | — |
| 11 | packages/core/src/eag/gate/index.ts | 156 | barrel 导出 | ➖ 不适用（纯类型/模板/静态数据） | L65-88 `export type`/`export{}`，L103-156 逐模块 `export {}`；无逻辑 | — | — |
| 12 | packages/core/src/eag/devops/devops-orchestrator.ts | 452 | DevOps 角色编排 + G-8 装配 | ❌ 确证问题 | L278-279 `monitoringReady: context.monitoringReady ?? true` / `rollbackPlanExists: context.rollbackPlanExists ?? true`（默认放行，L267-268 注释"批次 13 暂固定为 true"）；L283-285 G-8 未通过"不抛错，继续构造结果"；L306-311 **G-8 失败(success=false)仍发 `type:"devops-completed"` 事件**，失败反馈在事件层被吞/误报完成；L344-350 catch 默认 gateResult 的 guidance 为泛化模板 `"请检查 errors 字段中的具体失败原因，修复后重试"` | P0 | 默认改 false/显式必填；G-8 失败改发 `devops-failed`；guidance 带 `gateResult.reason` 真实证据 |
| 13 | packages/core/src/eag/devops/rollback-manager.ts | 1490 | 快照/回滚/回滚验证（K8s+Helm） | ❌ 确证问题 | 成因 L825-827 `catch{return {availableReplicas:0,expectedReplicas:0}}`（parseDeploymentStatus JSON 解析失败返回 0/0）→ L504 `this.parseDeploymentStatus(result.stdout)` → L508 `if(availableReplicas>=expectedReplicas)` 即 `0>=0` 为真 → L510-515 `return {success:true,message:"回滚验证成功：0/0 副本可用"}`。JSON 解析失败被当成回滚成功。诚实部分：L489/494 轮询有 `maxAttempts` 硬上限、L526-531 超时 `success:false`；L383-390/L1015-1017 快照写失败留痕 `snapshotDataError`（2026-11-01 已修复）；L1136-1144 Helm history 失败 false；L1264 `slice(0,3)` 为倒序后取最新 3 条 revision，无害。次要⚠️：L659-661 `loadSnapshotLabels` catch 返回 `{}`（回退为不切换 selector）、L904-906/L1376-1378 文件生成失败返回 undefined——是否被上层当成功缺调用方证据 | P1 | 解析失败抛错或返回可区分 failure；`verifyRollback` 校验 `expectedReplicas>0` 且解析成功标志；复核空 labels/undefined 降级值 |
| 14 | packages/core/src/eag/devops/rollback-plan-writer.ts | 755 | 回滚预案读写/序列化 | ✅ 未发现同类问题 | 已检查循环：L332/374/407/418 `while(i<lines.length)` 各分支均 `i++`（L337/346/351/356/361/369/373/380/383/398/406/415/428/431），有自然上限，无死循环（C1 命中系 YAML 解析非重试轮询）；已检查 catch：L588/601 `throw new Error(...)`、L636/700 返回"校验失败结果"，均诚实；无门禁/默认放行 | — | — |
| 15 | packages/core/src/eag/devops/rollback-plan-checker.ts | 288 | 回滚预案真实文件校验 | ⚠️ 疑似需复核 | checker 本身诚实：L181-189 文件不存在 `valid:false`、L195-203 读取失败 catch→`valid:false`、L223-231 缺章节 `valid:false`、L234-239 全齐才 `valid:true`。但 L48-50 注释"禁用模式由 GateG8CheckerImpl 处理（`context.rollbackPlanExists=true` 时跳过真实校验）"——坐实 #9/#12 的默认放行会绕过本真实检查器；本文件是否为死代码取决于装配层，缺调用方证据 | P1 | 与 #9/#12 联动：禁用模式默认关闭，真实检查器必须可达 |
| 16 | packages/core/src/eag/devops/monitoring-readiness-checker.ts | 1119 | 监控就绪门禁 | ❌ 确证问题 | 成因 L546-553 `if(!context.prometheusConfigPath){return {...passed:true,detail:"...跳过 Prometheus 配置校验..."}}`——信息不足（未配置路径）返回 `passed:true` 静默放行；触发路径 L236-237 `if(!prometheusConfigResult.passed)` 不加 failure → L243 `const ready=checkedItems.every(item=>item.passed)` 计为通过。诚实部分：L392/559/572 catch 均 `passed:false`，L339/441 是真实检查(退出码0/HTTP200)通过的 true，L687 while 栈循环有 pop 收敛，L773/851 `slice(0,colonIdx)` 是 YAML key 解析非截断 | P1 | 未提供路径应 `passed:false` 或显式 `skipped` 状态且 `ready` 不计通过 |
| 17 | packages/core/src/eag/devops/types.ts | 1581 | DevOps 数据模型 | ➖ 不适用（纯类型/模板/静态数据） | 类型/接口 + L1414 `RollbackExecutionError` 异常类 + 冻结常量；L961 仅为"createSnapshot 的 catch 吞错已修复"注释文字，非运行时逻辑 | — | — |
| 18 | packages/core/src/eag/devops/index.ts | 410 | barrel 导出 | ➖ 不适用（纯类型/模板/静态数据） | 纯 `export` 语句，无逻辑 | — | — |
| 19 | packages/core/src/eag/devops/iac-generator/terraform-generator.ts | 579 | Terraform IaC 生成/校验 | ✅ 未发现同类问题 | 已检查 catch：L199-201 JSON 解析失败 `return{valid:false,errors:[...]}`（诚实）、L213-215 临时目录清理失败仅日志（无害）；L68 `export class TerraformGenerator`；无门禁判定/默认放行/截断/重试 | — | — |
| 20 | packages/core/src/eag/devops/iac-generator/k8s-manifest-generator.ts | 508 | K8s manifest 生成/校验 | ✅ 未发现同类问题 | L214-216 stderr 非 JSON → `errors.push(result.stderr||...)`（诚实）、L235-237 清理失败无害；L58 class；无默认放行 | — | — |
| 21 | packages/core/src/eag/devops/iac-generator/helm-chart-generator.ts | 627 | Helm Chart 生成/校验 | ✅ 未发现同类问题 | L275-277 清理失败"不影响校验结果"（临时目录，无害）；L65 class；C4 命中 L97/109/...为对象构造（误报）；无门禁/循环/失败反馈 | — | — |
| 22 | packages/core/src/eag/deploy/deploy-stage.ts | 505 | 四步部署阶段编排 | ⚠️ 疑似需复核 | 诚实：四步 try/catch 均 `errors.push` + `return buildResult(false,...)`（L179-194/246-304/320-349/388-445），异常视为失败并触发回滚。疑点：L236-243 快照创建失败仅 `console.warn`+`errors.push` 后**仍继续部署**（无回滚安全网）；**L386 `const healthyEndpoints=healthEndpoints.filter(e=>e.healthy).map(e=>e.url)`——若无健康端点则为 `[]` → L389 `smokeTestRunner.run([],case)` → 见 #23 空测试 `passed:true` → L390 不回滚 → L448 返回 `success:true`**，是「失败反馈被吞」的关键触发路径 | P1 | `healthyEndpoints` 为空时直接判失败/回滚；快照失败披露应进入 success 判定 |
| 23 | packages/core/src/eag/deploy/smoke-test-runner.ts | 388 | 烟雾测试执行 | ❌ 确证问题 | 成因 L171-173 `const passed=failedTests===0`（空集合视为通过）、L113-114 注释明确"endpoints 为空 / testCases 为空 → totalTests=0,failedTests=0,passed=true"、L150 `totalTests=tasks.length`（笛卡尔积，空数组为 0）；L176-183 返回 `passed:true`。触发路径：#22 deploy-stage L386 无健康端点 → 0 个测试 → `passed:true` → 部署误报成功 → 上层 G-8-3 亦通过 | P0 | `totalTests===0` 时 `passed=false` 或返回 `skipped` 且上层按失败处理 |
| 24 | packages/core/src/eag/deploy/pre-deploy-checker.ts | 297 | 部署前检查 | ✅ 未发现同类问题 | L122 `const passed=failures.length===0`；L165/209/244 `resolve(false)` 均对应具体失败并 push failures；L287/293 `resolve(true)` 是真实检查通过。信息不足（CLI 不可用/解析失败）一律 false | — | — |
| 25 | packages/core/src/eag/deploy/post-deploy-checker.ts | 517 | 部署后健康/端点检查 | ✅ 未发现同类问题 | L155 `const passed=failures.length===0`；L282-289 `getServiceInfo` 返回 null（Service 不存在/解析失败）→ `healthy:false`（诚实降级，非默认放行）；L242-244/389-391 JSON 解析失败 `resolve(false)`/`resolve(null)` 均被上层判不可达；L295-316 TCP connect/timeout/error 分别 true/false/false | — | — |
| 26 | packages/core/src/eag/deploy/blue-green-strategy.ts | 688 | 蓝绿部署策略 | ⚠️ 疑似需复核 | L384 `const success=true` 硬编码、L382-383 注释"即使 kubectl get 失败…也视为部署成功"，累积 `errors`（L371 清理失败、L379→L591 JSON 解析失败 push）虽随结果返回但不参与 success 判定；上层 devops-orchestrator L206 `if(!deployStageResult.success)` 只看 success、L208 仅失败时才 push errors → 这些错误在 success=true 时被丢弃。失败分支 L225-353 均提前 `return buildResult(false,...)`（诚实） | P2 | success 纳入 `errors.length===0` 或显式 `degraded` 标志并让上层消费 |
| 27 | packages/core/src/eag/deploy/canary-strategy.ts | 1074 | 灰度部署策略 | ⚠️ 疑似需复核 | L489 `const success=true` 硬编码、L487-488 注释同蓝绿；L942-944 JSON 解析失败"返回空数组，追加错误信息"、L965-967 单资源解析失败 `continue`；失败分支 L338-458 提前 return false。errors 不参与 success（同 #26） | P2 | 同 #26 |
| 28 | packages/core/src/eag/deploy/rolling-strategy.ts | 633 | 滚动部署策略 | ⚠️ 疑似需复核 | L290 `const success=errors.length===0 || resources.length>0`、L288-289 注释"即使 kubectl get 失败…视为部署成功"——只要解析出任一资源即忽略累积 errors 判成功（两套口径混合）；L496-498 JSON 解析失败返回空数组+errors、L524-526 单资源跳过；失败分支 L276 提前 return false | P2 | success 统一为 `errors.length===0`；解析失败独立披露 |
| 29 | packages/core/src/eag/deploy/index.ts | 89 | barrel 导出 | ➖ 不适用（纯类型/模板/静态数据） | 纯 `export` 语句，无逻辑 | — | — |
| 30 | packages/core/src/eag/doc-driven/document-state-machine.ts | 282 | 文档状态机 | ⚠️ 疑似需复核 | 转换表 L56-61：`rejected→["reviewing"]`（失败后回 reviewing，**非回起点 draft**）、`approved:[]` 为终态不可回退；L267-282 `createInitialDocument` 固定 `state:"draft",version:1`。若失败重试经工厂重建文档，会丢弃已有 version/审批状态（模式7 候选）——但状态机本身是纯函数（L159-182 返回新冻结对象、无内部持久化），是否"从零重跑"取决于调用方，缺调用方证据。L214-245 `validateWorkflow` 缺失即 `canStartCoding=false`（诚实） | P2 | 提供 `approved/rejected → reviewing` 的显式回退或保留 version 的重试构造，避免重建丢状态 |
| 31 | packages/core/src/eag/doc-driven/git-process-manager.ts | 392 | 分支/commit/PR 描述/待删清单 | ✅ 未发现同类问题 | 已检查：纯字符串生成 + `pendingDeletions:Set`（L126，C6 命中的是去重集合非失败指纹）；L365-371 `flushPendingDeletions` 清空状态属"一次性消费"设计（返回清单给上层）；L43-67 Error 类；无循环/门禁/失败反馈/默认放行/截断 | — | — |
| 32 | packages/core/src/eag/doc-driven/task-decomposition.ts | 610 | 任务 DAG 分解/拓扑 | ✅ 未发现同类问题 | 已检查循环：L335-352 Kahn `while(queue.length>0)` 每轮 `queue.shift()` 收敛、非重试轮询；L395-397 循环依赖检测 `if(visiting.has(id))return 0` 兜底；L458-480 `validateDag` 校验诚实；L388/468 `new Set`（C6 命中为集合，非失败指纹）。无门禁默认放行 | — | — |
| 33 | packages/core/src/eag/doc-driven/plan-generator.ts | 466 | plan.md 生成 | ✅ 未发现同类问题 | 已检查截断：L286/293 `slice(0,500)` 为 spec/宪法内容"摘要"（L284 注释"提取前 500 字符作为方案上下文"明确），**非失败报告/日志 head-only 丢尾部错误**，不属事故模式5；L66/78/92 C4 命中为对象构造（误报）；无门禁/循环/默认放行 | — | — |
| 34 | packages/core/src/eag/doc-driven/constitution-builder.ts | 318 | 宪法文档生成 | ✅ 未发现同类问题 | L78 `buildConstitution` 纯字符串拼接生成；L229 `for` 遍历条目（C1 命中为遍历非轮询，有自然上限）；L41 Error 类；无门禁/失败反馈/默认放行 | — | — |
| 35 | packages/core/src/eag/doc-driven/tasks-generator.ts | 349 | tasks.md 生成 | ✅ 未发现同类问题 | L95 `TasksGenerator` 文档生成器；L68/262 C11 命中为字段校验（guard）；L41 Error 类；无门禁判定/重试/默认放行/截断 | — | — |
| 36 | packages/core/src/eag/doc-driven/types.ts | 668 | doc-driven 数据模型 | ➖ 不适用（纯类型/模板/静态数据） | 类型/接口 + L319 `GitProcessConfigError` + L349 `createDefaultGitProcessConfig` 工厂；C11/C12 命中为类型字段/注释，无门禁/循环运行时逻辑 | — | — |
| 37 | packages/core/src/eag/doc-driven/index.ts | 109 | barrel 导出 | ➖ 不适用（纯类型/模板/静态数据） | 纯 `export` 语句，无逻辑 | — | — |
| 38 | packages/core/src/eag/design/design-orchestrator.ts | 319 | DESIGN Loop 编排/评估失败重试 | ⚠️ 疑似需复核 | L137 `while(true)` 重试：有 `maxIterations` 上限（L167，默认3，L515）但**无「确定性失败/无进展」提前熔断**；L141-142 注释"ArchitectProtocol 接口未定义接收上轮失败原因"、L143-147 每轮以**相同 3 参**重调 `designArchitecture`、L172-173 承认 `verdict.reason` 未使用——编排器层仍是裸重放。**修复在集成层**：design-roles-llm.ts L780-867 提供 `FeedbackAwareArchitect`/`FeedbackCapturingEvaluator`，design/index.ts L24 说明经 `eag-orchestrator-assembly.ts buildDesignOrchestrator()` 装配注入；但 orchestrator 自身不强制，未走装配的路径仍裸重试（模式10 残留，缺调用方全覆盖证据）。另 L186 `void response` + L313-317 HUMAN_CHECKPOINT 默认 `approved:true,abort:false` 自动放行 | P1 | orchestrator 接口增加 `previousVerdict` 参数；增加重复 verdict 指纹熔断；检查点结果不得忽略 |
| 39 | packages/core/src/eag/design/design-roles-llm.ts | 867 | LLM 角色 + 重试反馈闭环包装器 | ⚠️ 疑似需复核 | P2 截断：L165 `trimmed.slice(0,300)`、L183 `JSON.stringify(value)?.slice(0,100)` 错误信息 head-only 截断、丢尾部诊断（不影响 fail-closed 正确性）。整体诚实：L15-18 "诚实失败(fail-closed)…绝不伪造降级设计文档"、L332/L540 client 不可用抛 `DesignRoleError`、L344-351/L550-556 catch 抛错、L159-161 候选解析 catch 为正常重试。修复贡献：L780-821 `FeedbackAwareArchitect`（`lastFeedback` 经 L819 注入 `previousVerdict`）、L833-867 `FeedbackCapturingEvaluator`（L862-865 旁路 `recordVerdict`） | P2 | 失败原因改 tail 优先或全量；将反馈闭环下沉到 orchestrator 强制路径 |
| 40 | packages/core/src/eag/design/design-evaluator.ts | 776 | 静态设计评估器 | ✅ 未发现同类问题 | 已检查默认放行：L383 `constructor(mode:DesignEvaluationMode="strict"...)` 默认严格、L733-739 strict `passed=findingsWithSeverity.length===0`（任一 finding 即 failed）/lenient 仅 blocker 使 failed（显式配置）、L744-751 `passed=true` 时仍 `findings.join` 全量披露（诚实降级）。C4 L103/141（SEVERITY_RANK/常量表）、C6 L484/536（`new Set`）均为常量/集合，非状态重建/失败指纹（误报） | — | — |
| 41 | packages/core/src/eag/design/design-models.ts | 574 | 设计数据模型/默认配置 | ✅ 未发现同类问题 | L508-515 `DEFAULT_DESIGN_LOOP_CONFIG`（`maxIterations:3`、`triggerHumanCheckpoint`）、L555-564 `createDefaultDesignLoopConfig` 含 L563 `maxIterations>=1` 校验、L525 Error 类；C1 命中 L489-563 为配置校验非循环；无门禁/失败反馈/默认放行 | — | — |
| 42 | packages/core/src/eag/design/design-role-prompts.ts | 319 | PM/架构师 prompt 模板 | ➖ 不适用（纯类型/模板/静态数据） | 纯 prompt 文本构造函数（L80 `buildProductManagerPrompt`、L240 `buildArchitectPrompt`）返回静态消息数组；C5 L269/308、C6 L197 命中为 prompt 文案中"失败反馈/指纹"字样，非运行时逻辑 | — | — |
| 43 | packages/core/src/eag/design/design-artifacts-schema.ts | 351 | 文档章节渲染/校验 | ➖ 不适用（纯类型/模板/静态数据） | 模板渲染 + 静态章节校验：L107/211 `renderArchitectureMd`/`renderDomainModelMd`、L316/339 `validateArchitectureMd`/`validateDomainModelMd`（返回 `{valid,missingSections}`，纯字符串匹配，无门禁/循环/失败反馈） | — | — |
| 44 | packages/core/src/eag/design/design-protocols.ts | 154 | 三角色协议接口 | ➖ 不适用（纯类型/模板/静态数据） | 纯 `interface`/`type` 协议声明，无实现逻辑 | — | — |
| 45 | packages/core/src/eag/design/index.ts | 121 | barrel 导出 + 接线状态注释 | ➖ 不适用（纯类型/模板/静态数据） | L48-121 纯 `export`；L19-28 为接线状态注释（含 `buildDesignOrchestrator()` 装配说明，作为 #38 的旁证）；C5 L23/117/118 命中为 `Feedback*` 导出名，非失败反馈逻辑 | — | — |

**四档计数**：❌ 确证问题 **6** / ⚠️ 疑似需复核 **10** / ✅ 未发现同类问题 **18** / ➖ 不适用 **11** = **45**。

## 二、门禁诚实性矩阵（信息不足 / 工具不可用 / 解析失败时返回什么）

| 门禁 / 检查器 | 信息不足时返回 | 行号 | 是否静默放行 |
|---|---|---|---|
| G-1 GateG1Checker | `passed:false`（specStatus/planStatus `!=="approved"`，undefined 亦算未批准） | gate-g1-checker.ts:75,86 | 否（诚实） |
| G-2 GateG2Checker | `passed:false`（records 空/角色缺/reject/userApproved 非 true） | gate-g2-checker.ts:128,139,150,162,174 | 否（诚实） |
| G-3 GateG3Checker | `passed:true`（`actualChanges.length===0`→"无实际变更，无方案偏离"）；采集失败致空与确认零变更不分 | gate-g3-checker.ts:135-141 | **条件性是**（⚠️，缺采集方证据） |
| G-4 GateG4Checker | `passed:false`（7 项扩展字段任一缺失/空/未注册） | gate-g4-checker.ts:127-225 | 否（诚实） |
| G-5 GateG5Checker | `passed:false`（finalEvaluationReport 缺失/verdict 非 pass/gitClean 非 true/gitleaks 非 true） | gate-g5-checker.ts:161,170,186,197 | 否（诚实） |
| G-6 GateG6Checker | `passed:false`（4 项 `!==true`/`!=="approved"` 收集 failures） | gate-g6-checker.ts:122-139,142 | 否（诚实） |
| G-7 GateG7Checker | `passed:false`（coverageReport 缺失/列表空/合规证据结构错/PR 段缺失） | gate-g7-checker.ts:189,199,217,256,325 | 否（诚实） |
| G-8 GateG8CheckerImpl | G-8-1/2/3 缺数据→`passed:false`；**G-8-4 `monitoringReady` / G-8-5 `rollbackPlanExists` 由上游 `?? true` 恒真 → 永判通过** | gate-g8-checker.ts:132,138,144,152,160；devops-orchestrator.ts:278-279 | **是（❌，P0）** |
| GateOrchestrator | 跳过门禁(LOOP_GATE_STRATEGY=false)→`allPassed:true`；缺检查器(strict 默认 false)/缺上下文→不计入未通过→`allPassed:true` | gate-orchestrator.ts:270-281,311-334,221 | **是（❌，P1）** |
| MonitoringReadinessCheckerImpl | `prometheusConfigPath` 未提供→该 item `passed:true`→`ready=every(passed)` 通过 | monitoring-readiness-checker.ts:546-553,243 | **是（❌，P1）** |
| SmokeTestRunnerImpl | endpoints/testCases 为空→totalTests=0→`passed:failedTests===0`→`passed:true` | smoke-test-runner.ts:113-114,150,171-173 | **是（❌，P0）** |
| PreDeployChecker / PostDeployChecker | 解析失败/CLI 不可用→`resolve(false)`/`healthy:false`→`passed=failures.length===0` 为 false | pre-deploy-checker.ts:122,165；post-deploy-checker.ts:155,282-289 | 否（诚实） |
| 回滚验证 verifyRollback(K8s) | JSON 解析失败→`0/0`→`0>=0`→`success:true` | rollback-manager.ts:825-827,504,508-515 | **是（❌，P1）** |

结论：**G-1/G-2/G-4/G-5/G-6/G-7 及 pre/post-deploy-checker 在信息不足时一律 failed（诚实）**；静默放行集中在 **部署/监控/回滚链路**（G-8 两项恒真、监控 prometheusConfigPath 缺失、烟雾测试空集合、回滚 0/0）与 **编排层**（GateOrchestrator 缺检查器/缺上下文 allPassed:true）——这与本次事故「把真失败说成通过」是同一红线。

## 三、Top 发现（按 P0/P1/P2 分级）

### P0 — 把真失败说成通过 / 门禁默认放行（核心红线）

1. **G-8 监控告警 + 回滚预案恒真放行**
   - 位置：`devops/devops-orchestrator.ts:278-279`、`gate/gate-g8-checker.ts:148-162`、`devops/rollback-plan-checker.ts:48-50`
   - 成因：装配 GateG8Context 时用 `context.monitoringReady ?? true` / `context.rollbackPlanExists ?? true` 兜底为 true；G-8 仅判 `if(!context.monitoringReady)` / `if(!context.rollbackPlanExists)`、`passed=failures.length===0`。批次 14 虽已实现 `RollbackPlanCheckerImpl` / `MonitoringReadinessCheckerImpl` 真实校验，但 L48-50 注释确认 `rollbackPlanExists=true` 即"跳过真实校验"，真实检查器被绕过。
   - 后果：监控告警未就位、回滚预案不存在时，G-8 仍判通过 → `devops-completed`、`success=true` → 无监控/无回滚预案的部署被报为生产就绪。
   - 最小修复：去掉 `?? true`，未配置时传 `false` 或抛错；让 G-8 调用真实检查器并以 `valid`/`ready` 为准。

2. **烟雾测试空集合静默放行（无健康端点也判部署成功）**
   - 位置：`deploy/smoke-test-runner.ts:113-114,150,171-173`；触发路径 `deploy/deploy-stage.ts:386,389-390,448`
   - 成因：`passed = failedTests === 0`，`totalTests = tasks.length`（endpoints×cases 笛卡尔积）；deploy-stage 用 `healthEndpoints.filter(healthy)` 作入参，当 post-deploy 后无任何健康端点时为 `[]` → 0 个测试 → `failedTests=0` → `passed:true`。
   - 后果：烟雾测试根本没执行却判通过 → deploy-stage 4 步"全成功" → G-8-3 通过 → 整条链把"无健康服务的部署"误报成功，且不触发回滚。
   - 最小修复：`totalTests===0` 时 `passed=false`（或返回 `skipped` 且 orchestrator 按失败处理）；deploy-stage 在 `healthyEndpoints` 为空时直接失败/回滚。

3. **监控就绪门禁「信息不足即通过」**
   - 位置：`devops/monitoring-readiness-checker.ts:546-553,236-237,243`
   - 成因：`prometheusConfigPath` 未提供时直接返回 `passed:true`（注释"K-4 决策简化…视为通过"），L237 不加 failure，L243 `ready=checkedItems.every(passed)` 计为通过。
   - 后果：未配置 Prometheus 配置路径（无法校验 scrape 规则）时监控就绪判 `ready:true`，与 G-8-4 默认放行叠加。
   - 最小修复：缺失路径返回 `passed:false` 或显式 `skipped` 状态且不计入 `ready`。

4. **回滚验证把 JSON 解析失败当成回滚成功**
   - 位置：`devops/rollback-manager.ts:825-827`（成因）、`:504,508-515`（后果）
   - 成因：`parseDeploymentStatus` 的 `catch` 返回 `{availableReplicas:0,expectedReplicas:0}`；`verifyRollback` 在 `result.success` 时调它，`if(availableReplicas>=expectedReplicas)` 即 `0>=0` 为真 → `success:true`（"0/0 副本可用"）。
   - 后果：kubectl 输出非合法 JSON（解析失败）时，把"状态无法确认"报成"回滚验证成功"，回滚可能实际未生效。与事故「dev 连续多轮输出相同但工作区不变 / 把失败说成通过」同源。
   - 最小修复：解析失败抛错或返回带 `parseOk:false` 的结果；`verifyRollback` 要求 `expectedReplicas>0 && parseOk` 才可能 success。

5. **门禁编排层缺检查器/缺上下文仍报全绿**
   - 位置：`gate/gate-orchestrator.ts:270-281,311-334,214-220,221`
   - 成因：`strictGateCoverage` 默认 false；coding 默认启用 G-1..G-5 但默认只注册 G-1/2/3/6/7（G-4/G-5 无检查器）；G-6/G-7 `missing-context` 跳过且不计入未通过；design/deploy 跳过门禁直接 `allPassed:true`。`allPassed = firstFailedGate===null && !coverageGap`，coverageGap 只在 strict 模式下才算 no-checker。
   - 后果："少跑两道门禁 / 门禁根本没执行"被 `allPassed:true` 掩盖（skippedGates 虽披露但调用方多只看 allPassed）。
   - 最小修复：默认 `strictGateCoverage=true` 或默认注册全部门禁；skippedGates 非空（非显式确认）时 `allPassed=false`；跳过门禁的结果用明确 `notExecuted` 语义而非 `allPassed:true`。

### P1

6. **G-8 失败仍发射 `devops-completed`（失败反馈在事件层被吞）**
   - `devops/devops-orchestrator.ts:282-285,306-311`：G-8 未通过"不抛错，继续构造结果"，`success=gateResult.passed&&errors.length===0` 为 false，但仍发 `type:"devops-completed"` 事件而非 `devops-failed`。订阅方会把失败 run 当成完成。修复：按 `success` 选择事件类型；L344-350 catch 的默认 `guidance` 泛化模板应带 `gateResult.reason` 真实证据（对应事故「阻塞报告只给泛化模板」）。

7. **DESIGN Loop 裸重试 + 无「确定性失败」提前熔断（部分修复）**
   - `design/design-orchestrator.ts:137-174`：`while(true)` 每轮以相同 3 参重调 `designArchitecture`，`verdict.reason` 未传给架构师（L141-142/172-173 注释自认）；仅有 `maxIterations=3` 上限，无"重复失败指纹一致即 abort"的提前熔断。修复在集成层（`design-roles-llm.ts:780-867` 的 `FeedbackAwareArchitect`/`FeedbackCapturingEvaluator` + `design/index.ts:24` 装配），但 orchestrator 自身不强制——未走 `buildDesignOrchestrator()` 装配的路径仍是裸重放（对应事故「逃生门裸重放不带失败原因」），缺调用方全覆盖证据。另 L186 `void response` + L313-317 HUMAN_CHECKPOINT 默认 `approved:true` 自动放行。修复：接口增加 `previousVerdict` 参数、加重复 verdict 指纹熔断、检查点结果不得忽略。

8. **G-3 空变更集无条件通过**
   - `gate/gate-g3-checker.ts:135-141`：`actualChanges.length===0` 直接 `passed:true`。若变更采集失败/未填充导致空数组（而非确认零变更），方案偏离门禁被绕过。修复：区分两种空集语义。

### P2

9. **错误信息 / 报告字段 head-only 截断（丢尾部证据）**
   - `design/design-roles-llm.ts:165`（`trimmed.slice(0,300)`）、`:183`（`slice(0,100)`）、`gate/g7-checker.ts:350`（`complianceSection.slice(0,80)`）：失败原因只保留前 N 字符。JSON 尾部错误/段尾证据被截。修复：tail 优先或全量（配合日志防爆用专门字段）。
   - 说明：`plan-generator.ts:286/293` 的 `slice(0,500)` 是文档"摘要"（非失败报告），`rollback-manager.ts:1264` `slice(0,3)` 是倒序后取最新 3 条 revision，`monitoring-readiness-checker.ts:773/851` `slice(0,colonIdx)` 是 YAML key 解析——均非事故模式5，不计入。

10. **部署策略成功路径忽略累积 errors（errors 被上层丢弃）**
    - `deploy/blue-green-strategy.ts:384`（`const success=true`）、`deploy/canary-strategy.ts:489`（同）、`deploy/rolling-strategy.ts:290`（`errors.length===0||resources.length>0`）：`kubectl get` 解析失败/清理失败等 push 进 `errors`，但 success 判定恒为 true 或被资源数掩盖；上层 `devops-orchestrator.ts:206/208` 仅在 `!success` 时才消费 `deployStageResult.errors`，success=true 时这些错误被吞。修复：success 纳入 `errors.length===0` 或返回 `degraded` 标志并让上层消费。
    - 相关：`deploy/deploy-stage.ts:236-243` 快照创建失败仅 warn 仍继续部署（无回滚安全网），errors 在 success=true 时同样不进上层结果。

11. **文档状态机 approved 终态 + 重建丢已有状态**
    - `doc-driven/document-state-machine.ts:56-61`（`approved:[]` 终态不可回退、`rejected→reviewing` 非回 draft）、`:267-282`（`createInitialDocument` 固定 `draft/version=1`）：失败后若经工厂重建文档会丢 version/审批历史。状态机本身无"失败回退起点"分支（诚实），是否"从零重跑"缺调用方证据。修复：提供显式回退转换或保留 version 的重试构造。

12. **回滚/监控旁路降级值是否误判成功缺证据**
    - `devops/rollback-manager.ts:659-661`（`loadSnapshotLabels` catch 返回 `{}` → "回退为不切换 selector"）、`:904-906/:1376-1378`（文件生成失败返回 undefined）、`devops/rollback-plan-checker.ts:48-50`（禁用模式）：这些降级值是否被上层当成功/就绪，需装配层与调用方证据，标 ⚠️ 待复核。

---

**给 team-lead 的汇总**：45 文件 / ❌6 ⚠️10 ✅18 ➖11；P0 主线为「部署/监控/回滚链路的静默放行」（G-8 两项 `?? true`、烟雾测试空集合 `passed:true`、监控 `passed:true`、回滚 0/0 `success:true`、GateOrchestrator `allPassed:true`），与本次事故「把真失败说成通过」完全同源；DESIGN Loop 裸重试已在集成层用 `FeedbackAwareArchitect` 修复但编排器层仍非强制、且缺确定性失败提前熔断。G-1/G-2/G-4/G-5/G-6/G-7 六个静态门禁在信息不足时一律 failed，是本组最诚实的参照实现。输出文件：`/tmp/dcx-eag-review-W4.md`。
