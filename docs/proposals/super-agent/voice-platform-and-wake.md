# 语音默认值按平台区分 + 语音唤醒

> 2026-11-05 · `packages/core/src/super-agent/soul/{platform,config}.ts`、`packages/web/web/src/voice/{wake,wake-listener,preference}.ts`、`packages/web/src/api/soul-api.ts`

## 一、为什么要按平台分默认值

语音链路依赖**本机**的 MLX sidecar（`mlx_whisper` / `mlx_audio`），这两个包只有 Apple Silicon 的 Metal 后端能跑。Windows 上装不起来。

原来的默认值是三平台一致：`voice.enabled = false`。这在 Mac 上是「让用户自己去开」的多余一步，在 Windows 上则是「给了一个永远点不通的入口」——用户点麦克风，等到超时，才被告知 sidecar 未就绪。**一个默认值不该制造一次注定失败的等待。**

现在：

| 字段 | macOS | Windows / Linux |
| --- | --- | --- |
| `voice.enabled`（麦克风入口） | 默认 **开** | 默认 **关** |
| `voice.speakReplies`（自动朗读） | 默认 **开** | 默认 **关** |
| `handsFree`（免按住，设备级） | 默认 **开** | 默认 **关** |
| `voice.wakeEnabled`（语音唤醒） | 默认 **关** | 默认 **关** |

最后一行是故意的例外：唤醒要麦克风**常驻监听**，这是隐私选择，只能用户自己点开，不该跟平台走。

Linux 也按「关」处理，因为 MLX 是 Apple 的框架，当前 sidecar 在 Linux 上同样跑不起来。等真做了 faster-whisper + piper 那条链路再放开。

## 二、判定放在哪一侧

两边各判一半，理由不同：

- **服务端**用 `process.platform`（`soul/platform.ts`）。desktop 版服务端与客户端同机，这个值就是用户的操作系统。放到浏览器嗅探 UA 反而不稳：Web 部署时"谁没有模型"取决于**服务器**，不是浏览器。
- **客户端**只在 `handsFree` 上用 UA（`preference.ts` 的 `isAppleClient()`）。它存在 localStorage，是「这台设备上的交互习惯」，本来就不该问服务端。

## 三、只影响「没配过的人」

规范化逻辑从「布尔判断」改成「显式值优先，缺失才取平台默认」：

```ts
// 之前：enabled: record.enabled === true
enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
```

显式写过 `enabled: false` 的配置一律保持 false。**升级不该把用户手动关掉的语音又打开**——那比默认值错更严重。代价是：老配置里如果是早期版本默认写进去的 `false`，升级后不会自动变成 `true`。无法区分「用户关的」和「旧默认写的」，只能选保守的那一边。

## 四、语音唤醒

### 4.1 怎么做的

```
常驻分段录音 → 静音收尾切段 → 空段丢弃 → 送 ASR → 匹配唤醒词 → 命中则开录
```

- **连续分段，不是「先检测人声再开录」**。直觉做法先用能量检测确认有人说话，但那要 300ms 才能确认（`VAD_MIN_SPEECH_MS`），**头一个字必然被切掉**——喊「司南」只剩「南」，唤醒率直接对半砍。所以录音一直在跑，靠静音收尾切段，只在静音时短暂断开。
- **空段不进识别**。`Endpointer` 新增 `idleMs`：从头到尾一帧人声都没有、连续静音到点就收尾，这类段直接丢弃。否则一段纯静音会录到 60s 上限，再把整分钟静音送去跑一次 Whisper。
- **命中即开录**，走的是 `startTalk()` 那条老路——唤醒只是「替用户点一下麦克风」，后续静音收尾、识别、提交全复用同一条路径。

### 4.2 匹配：精确 + 受限近似

ASR 不会把「司南」稳定写成「司南」。实测同一段音频出现过「语音 → 雨音」这种同音替换，唤醒词同样会被写成「思南」「司楠」。只做字符串包含，等于要求用户每次被识别得一模一样。

所以分两档（`voice/wake.ts`）：

| 档 | 条件 | 位置限制 |
| --- | --- | --- |
| 精确 | 归一化后直接包含 | 不限 |
| 近似 | 编辑距离 ≤ 1（错一字/漏一字） | **只在开头前 6 个字内** |

近似必须限制在句首：短唤醒词距离 1 意味着允许一半字符不同——「思念」「四年」都可能落到「司南」附近。真在长句中间模糊匹配，误唤醒会多到没法用；而人喊唤醒词几乎总是开口第一句。单字唤醒词不做近似（一个字错一个字，就是另一个词了）。

归一化做三件事：NFKC（全角转半角）、去掉标点空白、转小写。「司南，」和「司南」必须等价。

### 4.3 代价（写在明处）

- **麦克风常开**：唤醒的固有代价。所以默认关、UI 上写明「开启后麦克风会常驻监听」。
- **每段人声都要过一次 ASR**：热态约 287ms/段。比专用唤醒词模型贵一个量级（后者本地跑几十 KB 的模型，常驻功耗可以忽略）。
- 真要省电，下一步是接 openWakeWord 之类的专用检测器。`WakeListener` 的 `transcribe` 是可注入的，替换检测方式不需要改编排。

## 五、顺手修掉的一个真 bug

加唤醒字段时发现：**前端保存语音设置只发改动的那几个字段，服务端却是整体替换 `voice`**，而 `normalizeSoulConfig` 只做规范化、不做字段级合并——没传的字段一律落到默认值。

实测复现（改之前）：

| 操作 | 结果 |
| --- | --- |
| `PUT {voice:{engine:"kokoro",speed:1.3}}` | `enabled` 从 **true 翻成 false**——切换引擎顺手把语音关了 |
| `PUT {voice:{speakReplies:false}}` | `engine` 从 kokoro 回退 **qwen3-voicedesign**，`speed` 从 1.3 回退 **1** |

之所以一直没被发现，是因为首次安装时这些字段刚好都等于默认值，重置了也看不出来。

修法：`soul-api.ts` 对 `voice` / `companion` 做**字段级合并**（`{...current, ...patch}`），非对象补丁一律忽略。修后实测：

| 操作 | 结果 |
| --- | --- |
| 只改 `speakReplies` | engine / speed 保住 |
| 只改 `engine` | `enabled: true` 保住（不再被翻） |
| 改 `wakeEnabled` / `wakeWord` | 只动这两个字段；`"  小 南  "` → `"小南"`，空值回落「司南」 |

## 六、验证

| 项 | 结果 |
| --- | --- |
| `super-agent-soul-platform.test.ts` | 5/5（P1 平台能力、P2 默认值跟随、P3 缺省配置、P4 显式值优先、P5 唤醒词规范化） |
| `voice-wake.test.ts` | 10/10（归一化、精确、句中精确、同音、漏字、句中近似不命中、单字不近似、空输入、编辑距离） |
| `voice-wake-listener.test.ts` | 4/4（空段不识别 + 命中即停、未命中续听、识别失败即停不重试、stop 幂等） |
| `voice-endpointing.test.ts` | 9/9（新增 E7 空段超时、E8 有声段不走 idle、E9 未开 idleMs 时纯静音永不触发） |
| 接口实测 | 字段级合并的三条断言全部通过（见 §五 修后表）；配置往返后 `token` 保留、其余字段未被冲掉 |
| typecheck / lint / format | 5 workspace 0 error；lint 0 error（144 warning 均为既有）；prettier 通过 |

## 七、没做什么

| 没做的 | 为什么 |
| --- | --- |
| **专用唤醒词模型** | 现在用通用 ASR 做唤醒，代价是每段都过一次识别。openWakeWord / Porcupine 才是正解，但要引新依赖（ONNX Runtime 或 WASM 包），本次没扩这个面 |
| **真人唤醒率 / 误唤醒率** | 没有真人对着麦克风喊的测试条件。匹配逻辑只有单测覆盖，**真实唤醒率未知**——这是这条链路上最大的未验证项 |
| **长时功耗** | 麦克风常开 + 每秒一次 VAD 的耗电没测。笔记本上连续几小时的实际影响未知 |
| **Windows 端实测** | 本机是 macOS。Windows 的「默认关」只有单测覆盖（注入 `win32`），没有真机验证 |
| **模式随对话动态切换** | 陪伴模式仍由对话内容动态触发，本次没有动它的默认值——按需求确认，它不属于「按平台默认开关」这一类 |
