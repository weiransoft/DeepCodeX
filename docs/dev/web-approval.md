# Web 审批三态与自动审批（web-approval）

> 状态：已实现（2026-10-12）
> 关联：`docs/dev/permission-modes.md`（三态权限模式基础机制）、`docs/dev/web-ui.md`（Web UI 总体设计）

## 1. 需求

Web 端聊天审批在 CLI 三态权限模式（manual / auto / bypass）基础上提供：

1. **审批模式选项**（R1）：Web 设置 `web.approvalMode` 三选一，注入引擎的
   `permissionModeOverride`，优先级高于 settings 的 `permissions.mode`；
2. **自动审批**（R2）：`auto` 模式下，**非高危只读 bash 命令**（整串命中只读
   前缀白名单 + 未命中 CommandSafety 黑名单 + 风险评分非 destructive）免弹卡片
   直通执行；写/删/网络/安装/MCP 等有副作用操作保持人工审批；
3. **会话级「总是允许」**（R3）：审批卡片第三个按钮把本次申请的全部 scopes
   登记进会话内存集合（不落盘），后续同 scope 请求在任何审批模式下直接放行，
   仅限当前 Web 会话生命周期；
4. **不污染个人区**（R5）：会话级登记绝不写项目级 `.deepcode/settings.json`。

## 2. 架构与数据流

```
前端 PermissionCard（允许 / 总是允许(本会话) / 拒绝）
  │ POST /api/chats/:id/messages
  │   { permissions:[{toolCallId,permission}], sessionAlwaysAllowToolCallIds:[...] }
  ▼
session-pool.sendMessage
  ├─ P5 高危审批回填（P5_APPROVAL_ID_PREFIX）→ resolveP5DangerousApproval 就地 resolve
  ├─ sessionAlwaysAllowToolCallIds ∩ allow 决策 → 查当前 askPermissions 的 scopes
  │     → manager.addSessionAlwaysAllows(scopes)（登记后剥离该字段）
  └─ 常规轮次入队 → replySession → activateSession
        ▼
SessionManager（引擎侧，session.ts）
  computeToolCallPermissions（bypass 快速通道 / manual 全 ask / auto 走 defaultMode）
  → applyAutoApprovalFilter(permissionPlan, allowReadonlyPassthrough)
      第一级：会话级总是允许 —— 请求全部 scopes ∈ sessionAlwaysAllowScopes → ask 改 allow
      第二级：auto 只读直通 —— bash + isFullyReadonlyBashCommand + 非黑名单 + 非 destructive
  → askPermissions 为空则直通执行；否则 status=ask_permission 停摆，SSE 推
    permission_request 卡片
```

## 3. 关键判据

### 3.1 只读直通白名单（`AUTO_APPROVE_READONLY_PREFIXES`，session.ts）

只收录无副作用或副作用严格限于工作区构建/测试产物的常用命令
（git 只读子命令、ls/cat/grep、版本查询、npm test 等）；
curl/wget/chmod/git push/git reset 一律不在列。

匹配规则（`isReadonlyAutoApprovableSegment`）：

- 词边界匹配：命令段整体以白名单项开头，后续字符须为空白/参数分隔
  （防 `catfish` 误匹配 `cat`）；
- **重定向闸门**（2026-10-12 修复）：命令段含 `>` 或 `<`（含 `>>`、`2>`、`>|`）
  即判非只读——`echo hi > secrets.txt` 虽以白名单前缀 `echo` 开头，
  但实际产生写副作用，绝不可自动放行；管道符 `|` 由 `isFullyReadonlyBashCommand`
  拆段后各段独立判定（`git log | head` 合法）。

`isFullyReadonlyBashCommand`：整串按 `&&`、`;`、`||`、`|`、换行拆段，
**每个**命令段都必须命中只读白名单。

### 3.2 CommandSafety 防线（第二级判据内）

只读直通前还须通过 `packages/core/src/v2/approval/command-safety.ts`：
黑名单命中或风险评分 `level === "destructive"` → 拒绝自动放行，保持人工审批。
（bypass 模式下该防线由 executor/bash-handler 的灾难命令硬拦截独立保障。）

### 3.3 会话级总是允许（`sessionAlwaysAllowScopes`）

- 登记入口：`SessionManager.addSessionAlwaysAllows(scopes)`（内存 Set，不持久化）；
- 生效位置：`applyAutoApprovalFilter` 第一级，**任何审批模式**均生效
  （manual 模式用户点「总是允许」后同 scope 不再弹卡）；
- 语义边界：仅当请求的**全部** scopes 都已被登记才改判 allow，
  部分命中仍保持 ask（防 scope 收窄绕过）。

## 4. 审批模式与 defaultMode 的组合语义（引擎现状，勿混淆）

| approvalMode | 引擎 mode | 典型 defaultMode | 效果 |
|---|---|---|---|
| manual | manual | allowAll | 未列入 allow 白名单的 scope 一律 ask；「总是允许」第二、三轮起直通 |
| auto | auto | allowAll | 仅 ask 列表/unknown/黑名单命中才 ask；其余直通（不依赖只读直通） |
| auto | auto | askAll | 全部先进 ask，再由只读直通第二级放行只读 bash（R2 严格形态） |
| bypass | bypass | 任意 | 全量 allow；灾难命令仍被 executor 硬拦截 |

## 5. 验收用例与测试映射

场景集成测试：`packages/core/src/tests/session-web-auto-approval.test.ts`

| 用例 | 场景 | 期望 |
|---|---|---|
| WA-I01 | override=auto，`ls -la`（read-in-cwd） | 直通 allow、completed、tool 消息真实执行 |
| WA-I02 | override=manual，同一命令 | ask_permission，工具未执行 |
| WA-I03 | auto + askAll，`echo hi > note.txt` | 重定向闸门拒绝直通 → 保持 ask |
| WA-I04 | auto + askAll，`rm -rf /` | 黑名单命中 → 保持 ask（绝不自动放行） |
| WA-I05 | manual + addSessionAlwaysAllows(["write-in-cwd"]) + write | ask 改 allow 落盘执行，且**不写** `.deepcode/settings.json` |

单元测试：`packages/core/src/tests/permissions.test.ts`（scope 评估函数级）。
既有回归：`session-permission-mode-override.test.ts`（PM-I01~I07）、
`session-web-permission-default.test.ts`（WP-01~04）——本次改动全部零回归。

## 6. 页面切换与任务中断（2026-10-12 调查结论）

**现象**：Web 页面切换（切换 chat / 刷新）后任务疑似中断，需输入「继续」才恢复。

**结论：引擎侧任务不随 SSE 断连中断。** 保障机制：

1. `SessionManager` 轮次执行（`activateSession` 循环）与 HTTP/SSE 连接完全解耦，
   `sendMessage` 受理即返回，`handleUserPrompt` 在 session-pool 串行 Promise 链上
   后台执行（W5 轮次活性标志：入口 `turnActive=true`、finally 置 false）；
2. 断连期间的事件不丢失：SSE 重连后由 `getChatActivity` 回放活动快照
   （assistant 增量聚合、status、待审批 askPermissions），审批卡片按
   `ask_permission` 状态重新呈现；
3. 轮次结束（含异常）必推 `done` 帧，SSE 订阅方不会被悬死；
4. 「需要输入继续」的真实语义分两种：
   - **审批停摆**：status=ask_permission 等待决策回填（正常设计，非中断），
     审批卡片的「允许/总是允许/拒绝」即恢复入口；auto 只读直通（本文 R2）
     正是为减少此类停摆；
   - **轮次异常终止**：done 帧 status=failed，前端展示失败态，用户输入
     /continue 由 `replySession` 的 trailing pending tool calls 路径续跑。

若复现「无审批卡、无失败态、纯文本输出中途停住且 /continue 才续跑」，
属于新缺陷，需携带 chatId + 时间窗复现记录另行排查。

## 7. 实现清单（代码索引）

| 位置 | 职责 |
|---|---|
| `packages/core/src/session.ts` `AUTO_APPROVE_READONLY_PREFIXES` / `isReadonlyAutoApprovableSegment` / `isFullyReadonlyBashCommand` | 只读直通判据（含重定向闸门） |
| `packages/core/src/session.ts` `sessionAlwaysAllowScopes` / `addSessionAlwaysAllows` | 会话级总是允许登记（内存态） |
| `packages/core/src/session.ts` `applyAutoApprovalFilter` | 两级自动放行分流（就地改判 permissionPlan） |
| `packages/core/src/session.ts` activateSession 权限分流段 | mode/override 解析 + planMode 排除 + 分流调用点 |
| `packages/web/src/session-pool.ts` `sendMessage` | P5 审批回填分流 / sessionAlwaysAllowToolCallIds 登记 / 轮次入队 |
| `packages/web/src/config.ts` `web.approvalMode` | Web 设置节解析与校验 |
| `packages/web/web/src/components/PermissionCard.tsx` | 审批卡片三按钮 UI |
| `packages/web/web/src/sse.ts` `permission_request` | SSE 事件类型 |
