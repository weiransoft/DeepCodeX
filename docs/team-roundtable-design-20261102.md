# 多角色群聊协作（Roundtable）设计（2026-11-02）

- 目标：补上「群聊」形态——多角色在同一房间里讨论、达成共识、各自更新任务并执行，执行中遇疑问可回到群里再取得共识。
- 前序：`docs/team-wiring-audit-20261102.md` 第五节结论「群聊形态不存在」。
- 本文是**实现规格**，代码按此落地；文中「取舍」段落解释为什么不是另一种做法。

## 一、与既有能力的关系

| 能力 | 语义 | 轮次 | 有无台账 | 有无执行 |
| --- | --- | --- | --- | --- |
| `/team dispatch --role X` | 单角色干一件事 | 1 | 无 | 有（runner） |
| `/team dispatch --consensus` | 5 角色并行评审 + 一次 LLM 聚合 | 1 | 无 | 无（只出意见） |
| `/team auto` | 拆 DAG → 分层并行 → 聚合报告 | 按层 | 有（子任务） | 有 |
| **`/team roundtable`（本设计）** | **多轮讨论 → 规则判共识 → 分工 → 各角色自更新 → 并行执行 → 疑问回流** | 多轮 | 有（角色级） | 有 |

`--consensus` 不改：它是「一次快评」，输出可回归基线（golden 断言挂在它上面）。
Roundtable 是新增形态，不与它共用代码路径，避免把已验收行为拖进重构。

## 二、核心概念

| 概念 | 定义 |
| --- | --- |
| **Room** | 一次 roundtable 运行的全过程，含 transcript、决策、台账、执行报告 |
| **Round** | 一轮讨论。轮内所有参与者**并行**发言，各自基于「上一轮结束时的 transcript 快照」 |
| **Posture** | 每个角色每轮必须表态：`support`（同意当前草案）/ `refine`（方向认同但需补充）/ `object`（反对） |
| **Blocking** | `object` 是否属于阻断性反对（有它就不可能算共识） |
| **Decision** | 主持人基于最终 transcript 产出的决议草案：summary + 逐条 decisions + assignments |
| **Ledger** | 任务台账：每个角色一条 assignment，含 scope / deliverable / acceptance / dependsOn |
| **TaskUpdate** | 角色对「自己那条 assignment」的再表达：restated（我理解的任务）+ steps + acceptance |
| **Execution** | 按 taskUpdate 并行执行（带工具轮次），产出 ExecutionReport |
| **Amendment** | 疑问回流产生的「共识增量修订」，标注 affectedRoles |
| **Escalation** | 一次回流讨论（范围小、轮次少），产出 amendment |

## 三、状态机

```
opening ──▶ discussion(round 1..N) ──▶ judge
                ▲                       │
                │                ┌──────┴──────┐
                │                ▼             ▼
                │           consensus      unresolved
                │                │             │
                │                ▼             ▼
                │          assignment      (报告分歧，结束)
                │                │
                │                ▼
                │          task-update（各角色自表达，可提疑问）
                │                │
                │        ┌───────┴────────┐
                │        ▼                ▼
                │   has-question       no-question
                │        │                │
                │        ▼                ▼
                └── escalation ◀──┐   execution（并行）
                                  │        │
                                  └────────┘
                                  执行中提问 → escalation
```

终止条件（任一满足即结束）：
1. `judge` 判定 consensus 且执行全部结束；
2. `rounds > maxDiscussionRounds`（默认 3）→ `unresolved`；
3. `escalations > maxEscalations`（默认 1）→ 标记 `needs-human`（不再回流，把问题原样报给用户）；
4. 外部 `signal` 中止 → `aborted`；
5. LLM 不可用（无 key）→ `skipped`。

## 四、共识判定（关键：不让模型自己宣布共识）

模型倾向于说「我们已经达成一致」。如果直接信这句话，群聊会产出**假共识**：
文案漂亮但没有真实收敛，后续分工执行会各干各的。

因此判定完全由规则做，主持人只负责推进议程与起草决议：

```ts
function judgeConsensus(speeches: Speech[], participants: string[]): Verdict {
  const active = speeches.filter(s => s.posture !== undefined);   // 发言失败者不计
  const silent = participants.filter(id => !active.some(s => s.roleId === id));
  const objecting = active.filter(s => s.posture === "object");
  const blocking = objecting.filter(s => s.blocking);
  const refining = active.filter(s => s.posture === "refine");

  // 无阻断反对 + 无 refine 待办 → 共识
  const unanimous = active.length > 0 && blocking.length === 0 && refining.length === 0;
  // 无阻断但仍有 refine → 视为「可收敛」，下一轮把 refine 意见并进草案后复判
  const converging = active.length > 0 && blocking.length === 0;

  return {
    kind: unanimous ? "consensus" : converging ? "converging" : "diverging",
    blocking: blocking.map(toDissent),
    dissent: objecting.map(toDissent),
    silent,
    coverage: active.length / participants.length,   // 覆盖率，degraded 判定用
  };
}
```

三条硬规则：

1. **`support` 必须显式**。没解析出 posture 的发言按 `refine` 处理（保守——不当成同意）。
2. **`object` + `blocking: true` 一票否决**。哪怕 4/5 同意，也不算共识，只算「待收敛」。
3. **覆盖率不足半数 → `degraded`**。结果照出，但必须写清「基于 x/N 角色」，不能伪装成全员共识。

### 四之一、`refine` 稳定性（实现时补充）

真实模型很少直接给 `support`，多数用 `refine` 表达「同意 + 一点补充」。若「只要有 refine 就不算共识」，
3 轮几乎永远收敛不了——这是第一版实现跑用例时暴露的问题。

因此判定要求「refine 已稳定」，满足任一即算收敛：

- 本轮 `keyPoints` 为空（没有提出新的补充）；
- 本轮 `keyPoints` 与上一轮同角色的 `keyPoints` 集合完全相同（话已经说完）。

这是确定性规则（可单独用例覆盖：C3 / C4 / C5），不是让模型自评「我满意了」。

## 五、发言协议（结构化输出）

每个角色每轮输出**一个 JSON 对象**（允许包在 ```json 代码块里，也允许裸对象）：

```json
{
  "posture": "support | refine | object",
  "blocking": false,
  "replyTo": "m3",
  "keyPoints": ["一句话要点", "..."],
  "questions": ["我还不确定、需要群里回答的点"],
  "content": "面向其他角色的发言正文（可多段）"
}
```

- `replyTo` 指向具体消息 id：强制角色回应上一轮的**具体分歧**，而不是各说各话。
- `questions` 有两个用途：讨论期由主持人收集进 `openQuestions`；执行期若角色仍不确定，
  走回流通道（见第七节）。
- 解析器容错（`parseSpeech`）：
  1. 先找 ```json 围栏；
  2. 再找首个平衡 `{...}`；
  3. 都不成 → `posture: "refine"`、`content` 用原文、标记 `unparsed: true`，
     并在最终报告里统计「未结构化发言数」——这是质量指标，不吞掉。

**为什么不让模型直接输出自然语言、再让一个 LLM 去抽取立场**：多一次调用、多一次幻觉机会，
且抽取失败时无法回溯。让每个角色在发言里自带结构，解析成本几乎为零。

## 六、任务台账与「各自更新」

共识成立后，主持人输出：

```json
{
  "summary": "共识正文（3-6 行）",
  "decisions": ["逐条决议"],
  "assignments": [
    {
      "roleId": "solo-coder",
      "scope": "只改 src/auth/**",
      "deliverable": "JWT 校验中间件",
      "acceptance": "现有 12 个用例转绿 + 新增 3 个",
      "dependsOn": ["architect"]
    }
  ]
}
```

然后**每个角色自己更新自己的任务**（这是用户明确要求的环节）：

```json
{
  "restated": "我理解我的任务是……",
  "steps": ["步骤1", "步骤2"],
  "acceptance": "我如何自证完成",
  "needDiscussion": false,
  "question": ""
}
```

为什么多这一步而不是直接拿主持人的 assignment 去执行：

- assignment 是**别人**对「你该干什么」的描述，必然有理解偏差；
- 让角色先用自己话复述一遍，偏差在这 200 字里暴露（而不是在改了 5 个文件之后）；
- `needDiscussion: true` 就是「还没开工就发现共识有洞」，比执行到一半再回流便宜得多。

`restated` 与 assignment 的 `scope` 会被一起注入执行 prompt，作为执行边界。

## 七、疑问回流（执行中提问）

执行阶段每个角色的产出物里带 `questions`（来自工具执行后的自我评估）。

回流触发条件：任一执行报告 `questions.length > 0` 或 `status === "blocked"`。

一次 escalation 的构成：

| 项 | 取值 |
| --- | --- |
| 参与者 | 提问角色 + 主持人 + `dependsOn` 里被引用的角色（去重，最多 5 人） |
| 轮次 | 固定 1 轮（不是完整讨论，只解决具体问题） |
| 输入 | 原共识 + 提问角色的执行摘要 + 问题原文 + 相关角色的台账 |
| 产出 | `Amendment { question, change, affectedRoles }` |
| 之后 | `affectedRoles` 用 amendment 重跑执行；未受影响的不重跑 |

防失控：

- `maxEscalations` 默认 1；超出后状态记为 `needs-human`，把未解问题原样交给用户，
  **不再自动重试**（自动重试会把一个模糊需求烧成 20 次 LLM 调用）。
- 同一 `roleId + 问题签名（去空白前 80 字）`只回流一次，避免复读。
- 回流不重置已完成角色的执行结果。

## 八、预算与并发

| 参数 | 默认 | 理由 |
| --- | --- | --- |
| `maxDiscussionRounds` | 3 | 3 轮内收不敛，通常是需求本身模糊，加轮次只是烧钱 |
| `maxEscalations` | 1 | 同上 |
| `speakTimeoutMs` | 120s | 单次发言；超时记 `silent`，不拖垮整轮 |
| `maxToolRounds` | 8 | 沿用 dispatch 默认，执行阶段单角色上限 |
| 单轮并发 | 全部参与者并行 | 串行 N 倍延迟不可接受；轮间串行已保证「能回应」 |

调用量上界：`participants × (maxRounds + 1) + moderator × (maxRounds + 2) + escalations 相关`，
默认 5 人 3 轮 ≈ 5×4 + 4 + 3 ≈ 27 次短调用 + 最多 5 次带工具执行。

## 九、失败与降级

| 情况 | 行为 | 用户看到 |
| --- | --- | --- |
| 无 API Key | 立即返回 `skipped` | 「缺少模型凭据，未执行」 |
| 某角色发言超时/报错 | 该轮记 `silent`，继续 | 报告里列出「未发言角色」 |
| 发言非 JSON | `posture=refine` + `unparsed` | 报告统计「未结构化发言 n 条」 |
| 主持人起草失败 | 用最后一轮 transcript 本地拼装 summary | 标注「决议由本地拼装，未经主持人整理」 |
| 执行中工具被自动拒绝 | 沿用 D2 的 `deniedTools` | 报告列出卡点（不伪装成功） |
| 执行失败 | 该角色 `failed`，其他继续 | 最终退出码 1 |
| 共识未达成 | `unresolved` + dissent 列表 | 明确「未达成共识」，不给假建议 |

## 十、模块边界

```
commands/team-command.ts            （接线：子命令解析 + 输出编排）
        │
        ▼
team/roundtable/room.ts             （编排：状态机）
        ├── protocol.ts             （纯函数：prompt 构建 + JSON 解析）
        ├── consensus.ts            （纯函数：立场聚合 + 判定）
        └── types.ts                （领域类型）
        │
        ├── team/orchestrator/llm-once.ts   （讨论发言：单次文本补全）
        └── team/team-adapter.ts            （执行：executeDispatch + composeSystemPrompt）
```

硬约束：

- roundtable **不 import `session/`**（依赖方向：宿主 → commands → team）。
- 讨论阶段不产生工具调用（无 runner）；执行阶段才注入 runner。
- 所有对外可见文本由 `room.ts` 通过 `onMessage` / `onProgress` 推送，宿主决定渲染方式
  （Web 走 system 消息 → 团队卡片，CLI 走 stdout）。

## 十一、输出格式（CLI / system 消息）

```
🧠 Roundtable · 4 角色 · 目标：实现登录限流

[round 1]
  architect   refine · 需要明确"限流粒度"是 IP 还是用户
  solo-coder  support
  test-expert object · blocking：没有测试环境无法验证
  ui-designer refine · 429 的交互没定义

[round 2] 聚焦：限流粒度 / 429 交互
  architect   support
  solo-coder  support
  test-expert support · 已用 mock 时钟替代真实环境
  ui-designer support

━━━ 共识（round 2，4/4 支持）━━━
1. 限流粒度按用户 + IP 双维度 …
2. 429 返回 Retry-After …

━━━ 任务台账 ━━━
- architect   定义双维度限流规则（依赖：无）
- solo-coder  实现中间件（依赖：architect）
- test-expert 补充并发用例（依赖：solo-coder）
- ui-designer 429 交互（依赖：无）

━━━ 执行 ━━━
- architect   completed · 摘要…
- solo-coder  completed · 改动 3 个文件
- test-expert failed · 缺依赖

━━━ 回流（1 次）━━━
test-expert 提问：并发用例需要 Redis，环境没有
修订：改用内存计数器做单测，Redis 只在集成测试…
影响：solo-coder, test-expert → 已重跑
```

## 十二、测试计划

| 层 | 用例 | 说明 |
| --- | --- | --- |
| 纯函数 | `parseSpeech` 6 项 | 围栏 JSON / 裸 JSON / 前后夹文字 / 非法 / 空 / posture 非法值 |
| 纯函数 | `judgeConsensus` 8 项 | 全 support / 有 refine / 阻断 object / 非阻断 object / 半数 silent / 全 silent / 覆盖率 / 空输入 |
| 编排 | `room.ts` 8 项（桩 LLM + 桩 runner） | 两轮收敛 / 未收敛 / 发言失败降级 / 无 key skipped / 分工执行 / 执行失败 / 疑问回流 / 回流超限 needs-human |
| 接线 | `team-command` 3 项 | 子命令解析 / 帮助文本 / 输出含关键段落 |

反向验证要求：至少对「共识判定」做一次反向（把判定改成「有 object 也算共识」，
对应用例必红），防止假绿。

## 十三、取舍记录

1. **不做真正的「实时对话流」**（角色之间逐条接话、可见打字）。成本是 N 倍串行延迟，
   收益只是"更像聊天"。轮内并行 + `replyTo` 回应机制已经满足「讨论并收敛」的实质需求。
2. **不让主持人宣布共识**（见第四节）。规则判定可以解释、可以测；模型宣布不可测。
3. **不把 roundtable 做成 `/team auto` 的一个 flag**。auto 是"拆解-执行"的流水线，
   roundtable 是"协商-分工"的会议；混在一个命令里会让两者都没法演化。
4. **回流只做 1 轮**。第二轮的边际收益远低于成本，且真实场景里"两轮还不清楚"应回到人。
