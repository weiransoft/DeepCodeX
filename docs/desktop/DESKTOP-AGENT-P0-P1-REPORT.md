# desktop-agent P0 探针 + P1 主干切片：执行报告

- 分支：`feat/desktop-agent-p0-p1`（基于 `c3ecefd`）
- 日期：2026-11-06
- 方案：[DESKTOP-COMPUTER-USE-PROPOSAL.md](./DESKTOP-COMPUTER-USE-PROPOSAL.md)
- 实现说明：[desktop/desktop-agent/README.md](../../desktop/desktop-agent/README.md)
- 原始探针数据：[desktop/desktop-agent/reports/p0-probe.json](../../desktop/desktop-agent/reports/p0-probe.json)

---

## 1. 结论

**判定：`continue-with-adjustment`（路线成立，但需调整投入顺序）。**

P0 探针在真实 Windows 会话采到了可用数据：无需提权的 `tasklist /v /fo csv`
可枚举 34 个可见窗口，应用分类与三级降级链能产出真实通道矩阵。
但 a11y 树 / 截图 / 元素 invoke / 坐标输入 / 前台控制 **全部不可用**——
UIA 桥需要交互式桌面会话，当前执行环境不满足。因此：

- P1 按计划交付了「与 OS 解耦的主干」：策略、感知、验证、预算、审计、MCP 协议、壳侧授权接线；
- 全链路只由 mock 后端验证，**不宣称已能操作真实 GUI**；
- P2 的视觉兜底投入必须先通过 §7 的准入条件，否则会出现「只有截图能用、树不可用」的高成本路径。

这个取舍正是方案里「树优先、视觉仅兜底」的价值：主干不依赖 UIA，可以在不具备
桌面权限的 CI 里完整回归，平台桥就绪后只需替换 L4 后端。

---

## 2. P0 探针实测数据

运行：`node desktop/desktop-agent/scripts/probe.mjs`
（`generatedAt=2026-11-06T03:44:16Z`，`platform=win32`，`session=Console`）

### 2.1 平台能力矩阵

| 能力 | 可用 | 说明 |
| --- | --- | --- |
| 应用/窗口枚举 | ✅ | `tasklist /v /fo csv /nh`，纯 Win32 命令，无需提权 |
| a11y 语义树 | ❌ | UIA 桥未启用（`DEEPCODE_AGENT_UIA_BRIDGE=1` + 交互式会话） |
| 截图 | ❌ | 同上 |
| 元素 invoke | ❌ | 同上 |
| 坐标输入 | ❌ | 同上 |
| 前台控制 | ❌ | 同上 |
| UAC 感知 | ❌ | Secure Desktop / 完整性级别检测超出 P1 范围，一律 `HANDOFF_REQUIRED` |

能力矩阵探测耗时 `0.08ms`——能力声明是显式查表，不做运行时猜测。

### 2.2 真实枚举与分类

| 指标 | 值 |
| --- | --- |
| 可见窗口 | 34 |
| 冷枚举耗时 | **14,805.38 ms** |
| 分类分布 | `unknown` 23 / `browser` 7 / `selfdrawn-likely` 3 / `productivity` 1 |
| 通道分布 | `gui-a11y` 23 / `browser` 7 / `gui-visual` 3 / `interface-or-gui` 1 |
| 缓存命中 | **0.01 ms** |
| 单次 `desktop_list_apps` | **0.4 ms**（34 次调用共用一次快照） |
| mock 逻辑基线 | snapshot `1.39ms`；Observe→Act→Verify 单步 `1.11ms`、`verified`、`attempts=1` |

隐私：窗口标题**不落盘**，报告只保留 `hasTitle` 与 `titleLength`。

### 2.3 探针暴露的三个问题及修复

| # | 问题 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | `tasklist /v` 冷枚举约 15s，最初每次工具调用都重取 | 单步 GUI 任务退化到十几秒，编排不可用 | `AppRegistry` 加 TTL 缓存；`desktop_list_apps` 基于**一次快照**算通道矩阵；`refresh` 仅显式传 true 才触发 |
| 2 | 34 个窗口里 23 个分类为 `unknown`，早期默认落到 `gui-visual` | 全量挤进一个默认关闭的视觉通道，等于「什么都做不了」 | `unknown` 归入 `gui-a11y` 待观察；`selfdrawn-likely` 才落 `gui-visual`；通道矩阵单次快照复用 |
| 3 | 壳写了策略文件，但 sidecar 默认只读仓库内 `policy.default.json` | 授权契约断点：UI 开关改了不生效 | 新增 `policy-load.mjs`：优先级 `DEEPCODE_AGENT_POLICY` > `~/.deepcode/desktop-agent.json` > 仓库默认；解析失败回落「默认关闭」；并对外部策略做**二次硬化** |

问题 3 是收尾复查时发现的接线缺陷，已补测锁死。另补齐 `package.json` 中悬空的
`register:mcp` 脚本引用——现在有真实实现（dry-run / 写入 / 移除 / 幂等 / 备份）。

---

## 3. P1 交付清单

### 3.1 sidecar（`desktop/desktop-agent/`，零新增 npm 依赖）

| 层 | 模块 | 职责 |
| --- | --- | --- |
| L1 协议 | `mcp-server.mjs` | stdio JSON-RPC 2.0；`initialize` / `tools/list` / `tools/call` / `ping` / 空 resources & prompts；stdout 仅协议帧 |
| L2 编排 | `agent.mjs` | 11 个工具定义与分发、三级降级通道决策、策略热更新接口 |
| L3 护栏 | `policy-guard.mjs` / `policy-load.mjs` / `budget.mjs` / `telemetry.mjs` | 白名单 + 注入扫描 + 一次性确认令牌、外部策略硬化、步数/截图/token 原子预扣熔断、脱敏事件流 |
| L3 感知 | `perception.mjs` / `app-registry.mjs` | 稳定 ref / 骨架树 / `rootRef` 下钻、TTL 缓存、通道矩阵 |
| L3 验证 | `verifier.mjs` | Observe→Act→Verify；旧 ref 硬返回 `STALE_REF`；有界重试 |
| L4 后端 | `contract.mjs` / `mock.mjs` / `windows.mjs` / `windows-uia.ps1` | 可插拔契约；mock 可注入故障；Windows 真枚举（`tasklist` GBK 解码）；UIA 桥为产品代码、当前环境不可运行 |

### 3.2 壳侧接线（只加「配置面」，不加执行面）

- `desktop/src-tauri/src/desktop_agent.rs`：策略落盘 `~/.deepcode/desktop-agent.json`；
  `harden()` 复位不可写字段、拒绝 `bypass`、严格校验 appId/scope；含 3 个 Rust 单测。
- `desktop/src-tauri/src/ipc.rs` / `lib.rs`：新增 4 条命令
  `desktop_agent_status` / `desktop_agent_toggle` / `desktop_agent_permissions_get` /
  `desktop_agent_permissions_set`。
- `desktop/src-tauri/permissions/app-ipc.toml`：ACL 同步（22=22）。
- `packages/web/web/src/desktop-bridge.ts`：TypeScript invoke 包装与类型定义。
- `desktop/src-tauri/src/engine/manager.rs`：给 Unix-only 的 SIGKILL 崩溃重启测试加
  `#[cfg(unix)]`，使 MinGW GNU 工具链能编译测试目标。

**壳不注册任何窗口枚举 / 截图 / 输入注入命令**，WebView 保持零系统特权；
动作权限由 sidecar 的 PolicyGuard 二次裁决（纵深防御）。

### 3.3 文档

- `DESKTOP-COMPUTER-USE-PROPOSAL.md`（方案，357 行）
- `desktop/desktop-agent/README.md`（运行、契约、工具、限制）
- 本报告

---

## 4. 验证结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Node 单测 | `cd desktop/desktop-agent && npm test` | **44/44 通过**（5 个测试文件，约 14s） |
| MCP stdio 冒烟 | `printf … \| node src/index.mjs` | `initialize` 返回 `2025-03-26`；`tools/list` 返回 11 个工具；`desktop_status` 返回 `enabled:false`；stderr 日志与 stdout 协议帧分离 |
| 外部策略硬化（运行时） | 注入含 `bypass` / `allowScreenshot:true` / `maxSteps:9999` 的策略 | 生效值 `manual` / `false` / `false` / `deniedCategories` 5 项 / `maxSteps=100`；`enabled` 与白名单保留 |
| 全仓类型检查 | `npm run typecheck` | 5 个 workspace 全过，exit 0 |
| IPC 四方契约 | `npm run check:ipc` | 定义 22 = 注册 22 = ACL 22；前端调用点 21（`window_new` 未使用，历史既有）；校验通过 |
| Rust 编译 | `cargo check` | exit 0；仅既有 `PASSWORD_ENV` dead_code 警告 |
| Rust 测试编译 | `cargo test --lib --no-run` | exit 0，产物 `deepcode_desktop_lib-*.exe` |

**已知环境限制**：`cargo test --lib` 的**运行**在本机报 `STATUS_ENTRYPOINT_NOT_FOUND`
（MinGW GNU 测试二进制与 WebView2 DLL 加载环境），复制 `WebView2Loader.dll` 亦无效。
这是工具链/DLL 环境问题，不是用例失败；已用 `--no-run` 证明全部 Rust 用例可编译，
Rust 侧策略单测的逻辑等价项另由 Node 测试覆盖。CI 若用 MSVC 工具链应能直接跑全量。

---

## 5. 安全 / 稳定性护栏落地对照

| 方案风险 | 本切片对应实现 |
| --- | --- |
| R1 提示注入（界面文本当指令） | 观察结果标记 `untrusted`；`detectInjection` 命中即拦写动作，且不回灌原文 |
| R2 敏感应用 | 5 类敏感分类**先于只读分支**硬拦截；探针不落盘窗口标题；审计脱敏 |
| R3 越权 / 提权 | 双侧 `harden()` 锁定字段、`bypass` 降级、壳 ACL 只含 4 条配置命令 |
| R4 不可逆动作 | 一次性 5 分钟确认令牌（内存态），不受「始终允许」豁免 |
| R8 成本失控 | 步数 / 截图 / token 原子预扣 + 熔断，任务内后续动作全拒 |
| R9/R10 平台能力差异 / 陈旧 ref | `capabilities()` 显式矩阵；`STALE_REF` 硬失败而非带着旧坐标继续点 |
| UAC / 验证码 / 锁屏 | 统一 `HANDOFF_REQUIRED`，不做绕过 |

---

## 6. 未解决与边界

1. **真机 GUI 动作未通**：UIA 桥需交互式桌面会话；当前能力矩阵 6 项为 `false`。
   `windows-uia.ps1` 是产品代码但未经真机验证，不能作为已交付能力对外表述。
2. **冷枚举 14.8s**：缓存只解决重复调用；`refresh:true` 仍慢。P2 需增量枚举或 UIA 事件订阅。
3. **分类粗糙**：23/34 为 `unknown`，靠进程名启发式；误分会把目标送进错误通道。
4. **策略不热更新**：改开关/授权需重启引擎，UI 已有 `restartHint` 文案。
5. **仅 Windows 真后端**：macOS AX / Linux AT-SPI 未实现，回落 mock。
6. **未接线引擎生命周期**：P1 是「配置即生效」的最小接线；`AgentLifecycle`
   （随壳启停、崩溃重启上限、健康检查）属 P2。
7. **交叉工作区提示**：同一工作区里 `desktop/build/*` 的 Windows 分发打包脚本是另一条
   工作流，其「能力排除守卫」明确不打包本切片。若在该分支上打分发包，需用
   `-BaselineRef` 固定到不含本切片的提交，否则默认 `HEAD` 快照会带上 IPC 并触发守卫中止。

---

## 7. P2 准入条件与下一步

**准入（全部满足才投入视觉兜底 / 真机动作）：**

1. 在交互式桌面会话以 `DEEPCODE_AGENT_UIA_BRIDGE=1` 复跑 `npm run probe`，
   a11y 树覆盖率 ≥ 80% 的目标应用集合、单步观察 < 3s；
2. `windows-uia.ps1` 真机跑通 `snapshot / invokeRef / screenshot / clickXY / typeText / sendKey`
   并补齐契约测试（可用故障注入覆盖权限拒绝、窗口关闭、STALE_REF）；
3. 冷枚举换成增量或事件订阅，`refresh:true` 的 P95 < 1s；
4. 在 MSVC CI 上跑通 `cargo test --lib`，闭环 Rust 用例运行验证。

**随后：**

- 接 `AgentLifecycle`（壳管 sidecar 启停 / 崩溃上限 / 热更新）；
- 视觉兜底与坐标吸附（P2），默认仍关闭；
- 配置页 UI 落地 4 条 IPC（当前只有 TS 包装，无界面）；
- 按方案 §8 补端到端度量：任务成功率、单步耗时、人工接管率、token/步数成本。

---

## 8. 复现命令

```bash
# 以下命令均以仓库根目录为起点（每行独立执行）
(cd desktop/desktop-agent && npm test && npm run probe)
npm run typecheck && npm run check:ipc

# Rust（需用户级 Rust GNU + MinGW 在 PATH）
(cd desktop/src-tauri && cargo check && cargo test --lib --no-run)

# 登记 sidecar（默认 dry-run，不改文件）
(cd desktop/desktop-agent && npm run register:mcp)
```
