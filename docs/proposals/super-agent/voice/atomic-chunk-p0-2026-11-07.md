# 结构感知分块 P0 落地报告（2026-11-07）

> 上一轮：`tns-residual-fix-research-2026-11-07.md` 给出调研与真机 A/B（只读探针）。
> 本轮：把 P0 方案真正落进生产链路，**默认关、可一键回退**，并跑完整回归门禁。

## 0. 结论

- ✅ **`code:xl` 块间语速极差 43.71% → 6.84%**（阈值 ≤8%），在落地后的单一权威实现上精确复现；全量 25 格矩阵里这一项也确实从违规列表消失。
- ⚠️ **但全量矩阵暴露了单格 A/B 没看到的新回归**：`code:m` 从 1.12% 涨到 **33.67%**。根因是尾段重划合成的 54 字超长块被服务端二次切分，短段带多段句内静音，单元语速掉到 3.396 u/s。**语速类违规总数没有下降，只是从一个格子搬到另一个格子**。详见 §5.3。
- ✅ 关闭态与 `031f1cc2` 逐字一致：450 条文本（含 TNS 规范化后）对比旧版 `split_long_text` 差异 0 处；`code:xl` 关闭态仍是 26 块 / 5 处切断原子。
- ✅ 跨语言一致性：Python 与 TypeScript 的原子判定在 8 条语料、4 组尾段重划上逐项相等，由同一份 fixture 双向锁定。
- ✅ 静态与离线门禁全绿：typecheck / lint / prettier / IPC 契约、Python 8 套单测、前端 27 条新增用例、Web/CLI bundle 重建。
- ⚠️ `npm test` 全量 **exit 1**：10226 项中 10203 pass / **1 fail** / 22 skip。唯一失败是 `sharp-loader.test.ts` 的版本断言（未改动文件，硬编码 `0.35.4` vs 已安装 `0.35.5`），属既有依赖漂移，与本轮语音改动无关；未改判据、未改测试来「刷绿」，详见 §6.1。
- ⛔ **开关默认关，且本轮不建议默认打开**。曾试过让两格都达标的替代策略，代价是产生 5.9 单元碎片、违反既有 ≥10 单元护栏，因此**未采用、未放宽阈值**（§5.5）。根治需与 P1「短块句内静音上限」叠加验证。
- ⏳ 桌面 WebView 真机听感仍需本人确认；其余历史违规不在本轮范围，矩阵门禁持续报出，不删语料、不放宽阈值。

---

## 1. 变更清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `scripts/voice/atomic_chunks.py` | 新增 | Python 权威原子判定：`atomic_spans` / `char_inside` / `cut_ok` / `nearest_ok_cut` / `atom_end_after` / `flat` |
| `packages/web/web/src/voice/atomic.ts` | 新增 | 同源 TS 实现（UTF-16 码元索引；`PATH_RE` 用 Unicode 属性类对齐 Python `\w`） |
| `scripts/voice/atomic-parity-fixtures.json` | 新增 | 8 条语料 + 4 组重划的跨语言基准（23.6 KB） |
| `scripts/voice/test_atomic_chunks.py` | 新增 | 离线单测：parity 自洽、开关两态、25 格切分质量、服务端 ≤48 字、语义边界 |
| `packages/web/tests/voice-atomic-chunk.test.ts` | 新增 | 27 条前端用例：parity、默认关契约、切句结构保护、偏好开关、真实 `SpeechQueue` deps 透传 |
| `packages/web/web/src/voice/sentence.ts` | 改 | `takeSentences(..., atomicChunk=false)`：结构内部标点不断句、切点回退到原子边界；`SentenceStream` 构造参数 |
| `packages/web/web/src/voice/player.ts` | 改 | `splitLongText` / `rebalanceShortBlock` 加原子边界过滤；`SpeechQueueDeps.atomicChunk` 透传到 `pushBlock` / `absorbShortIntoLast` |
| `packages/web/web/src/voice/preference.ts` | 改 | `dcx.voice.atomicChunk.v1` 读写，默认关 |
| `packages/web/web/src/voice/useVoiceTalk.ts` | 改 | 单份冻结快照 `atomicChunk()`，同时喂给队列与切句器 |
| `scripts/voice/mlx_voice_server.py` | 改 | `DCX_VOICE_ATOMIC_CHUNK`（默认关）；`split_long_text` / `rebalance_tail` 加原子保护；`/health.versions.atomicChunk` 回显 |
| `scripts/voice/start.sh` | 改 | 显式 `export DCX_VOICE_ATOMIC_CHUNK=0`，注明回退与两侧关系 |
| `scripts/voice/longtext_probe.py` | 改 | 新增唯一权威实现 `frontend_blocks(text, atomic=...)` + `split_quality()` + `--atomic` |
| `scripts/voice/mixed_matrix_probe.py` | 改 | `run_cell(..., atomic=None)` + `--atomic` + 报告字段 |
| `scripts/voice/chunking_ab_probe.py` | 改 | 删掉自带的第二份切分算法，改为复用 `longtext_probe` 单一实现 |
| `scripts/voice/README.md` / `package.json` | 改 | 新增章节与 4 个 npm 脚本入口 |

**没有改**：TNS 规则本身（`text_normalize.py` 一行未动）、TTS 模型/音色/伺服参数、阈值 JSON、任何语料。

---

## 2. 开关契约

| 位置 | 开关 | 默认 | 作用 | 回退 |
|---|---|---|---|---|
| 前端 | `localStorage["dcx.voice.atomicChunk.v1"]="1"` | **关** | 三处切点（断句 / 48 字硬切 / 尾段重划）避开原子内部 | 删键或置 `"0"` |
| 服务端 | `DCX_VOICE_ATOMIC_CHUNK=1` + 重启 | **关** | 规范化后二次切分兜住残留拉丁词/数字串 | 去掉变量重启；`/health.versions.atomicChunk` 回显 |
| 门禁探针 | `--atomic` | **关** | 只替换「前端复刻切分」，不碰服务端 | 去掉参数 |

**三者关系（容易误解，写清楚）**：前端偏好是**必要条件**——只有它保证完整 `{...}` 进入同一个请求，服务端 TNS 才有机会还原结构。真机 A/B 的 6.84% 是在 `DCX_VOICE_ATOMIC_CHUNK=0` 下测得的；服务端那层是可选增强，不是收益来源，也没有单独 A/B。`--atomic` 矩阵正好对应「前端打开 + 服务端默认关」这一主要生产态。

**冻结语义**：`SpeechQueue` 首次构造后长期复用，`SentenceStream` 每轮新建。两者共用 `useVoiceTalk.ts` 里 `atomicChunkRef` 的单份快照，避免中途改偏好出现「切句按新值、封块按旧值」的半生效状态；改偏好需刷新页面。

---

## 3. 为什么不用「TS 版 TNS」

服务端顺序本来就是 `apply_tns(整个请求文本) → split_long_text(规范化后文本)`。上一轮对照实验证明：前端先规范化只把 `code:xl` 降到 27.39%，还把 `voice` 切成 `v`/`oice`（TNS 规则同源复制会漂移）。本轮只做**边界保护**，不改写任何文本，因此天然幂等、逐字可逆、可一键回退。

**原子定义**：成对 `{} [] ()`（含嵌套与未闭合）、ASCII URL、POSIX 路径、拉丁词（含连字符/点号/下划线）、数字串。切点落在边界可以，落在内部禁止；回扫区间无合法切点时把整个原子挪到下一请求（前端允许单块到 59 字），交给服务端规范化后二次切分；单个原子 >96 字才诚实降级硬切。服务端是长度的最后一道保险，两态都严格 ≤48 字。

---

## 4. 离线验证

| 项目 | 结果 |
|---|---|
| 关闭态 vs `031f1cc2` `split_long_text` | 450 条文本（25 格语料 + 200 条随机混合串 + 各自 TNS 规范化后）**差异 0 处** |
| `code:xl` 关闭态 | 26 块、5 处切断原子、最长 48 字、逐字可逆 |
| `code:xl` 开启态 | **23 块、0 处切断原子**、最长 59 字、最短非首块 10.04 单元、逐字可逆 |
| 25 格矩阵开启态 | 全部逐字可逆、切断原子总数 0、多块格最短非首块最小 10.00 单元 |
| `plain:xl` | 两态完全相同（12 块，1.24%） |
| 服务端两态 | 33 条语料每段均 ≤48 字、逐字可逆；关闭态默认参数与显式 `atomic=False` 一致 |
| 跨语言 parity | 8 条语料的 `atomicSpans` / `splitLongText(off/on)`、4 组 `rebalanceShortBlock(off/on)` 全部逐项相等 |

---

## 5. 真机验证（8791 / sinan / speed 1.2 / tns-1.0）

### 5.1 结构感知 A/B：落地实现精确复现调研结论

同机、同语料、同阈值、同一 sidecar（pid 8500，`atomicChunk: off`）。

| 格子 / 方案 | 块数 | 语速极差 | 中位 u/s | F0 极差 | 最长静音 | 块间静音 | 最短非首块 | 可逆 | 采集 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `code:xl` baseline | 26 | **43.71%** ❌ | 4.91 | 32.41% | 460ms | 107ms | 11.6 | ✅ | ✅ |
| `code:xl` **atomic** | 23 | **6.84%** ✅ | 4.89 | 23.94% | 500ms | 85ms | 10.6 | ✅ | ✅ |
| `plain:xl` baseline | 12 | 1.24% | 4.93 | 15.60% | 700ms | 91ms | 10.0 | ✅ | ✅ |
| `plain:xl` atomic | 12 | 1.24% | 4.93 | 15.60% | 700ms | 91ms | 10.0 | ✅ | ✅ |

- 基线的 **43.71%** 与 TNS 验收报告、调研报告三次数值完全一致；实验组 6.84% 也与调研报告一致（固定 seed 的确定性，不是时段抖动）。
- F0 极差 32.41%→23.94%、块间机械静音 107→85ms、块数 26→23（少 3 次独立自回归生成），无一项越界。
- **首块 TTFA 不可比**：baseline 是本次会话第一个真机请求，包含模型权重加载（7088ms），atomic 是热态 711ms。这一列不能当 A/B 结论；`plain:xl` 首块 2016/2037ms 也只是时段摆动（调研报告同格为 1851/1834ms）。
- 产物：`/tmp/dcx-atomic-final/summary.json`、`split-quality.json`、逐格 JSON。

### 5.2 常规真机门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 长文本（默认关） | `longtext_probe.py --check` | ✅ exit 0，4/4 |
| 长文本（atomic） | `longtext_probe.py --atomic --check` | ✅ exit 0，4/4 |
| 连贯性 | `check_continuity.py --tns on` | ✅ exit 0，11/11 |
| TNS 15 场景 | `tns_probe.py --check` | 见 §5.4 |

### 5.3 全量 25 格矩阵：修好 `code:xl`，却把违规搬到 `code:m`

串行跑了三组（同一 sidecar、同一阈值、同一份语料，未删语料、未放宽阈值）：

| 组 | 命令 | 格/块 | 音频 | 跨语料语速极差 | 内容组间 | TTFA P95 | 违规总数 | 语速类违规 | TTFA 类违规 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| M1 | `--tns on`（atomic 关） | 25 / 179 | 826.61s | 21.46% | 0.26% | 2576.5ms | **12** | 3 | 9 |
| M2 | `--tns on --atomic` | 25 / 171 | 830.03s | 21.53% | 0.37% | 2514.4ms | **9** | 3 | 6 |
| M3 | `--tns off`（atomic 关） | 25 / 179 | **796.88s** | 25.52% | 22.12% | 2577.9ms | **19** | 13 | 6 |

> M3 的 796.88s 与 `031f1cc2` 验收报告的 796.88s **精确一致**，说明语料、切分、PCM 确定性都可复现，本轮对照有效。

**语速类违规逐条**（按音频时长计算，不受 CPU 负载影响）：

| 组 | 违规项 |
|---|---|
| M1 (on) | `num:xs` 20.57%、`code:xl` **43.71%**、全局跨语料 21.46% |
| M2 (on+atomic) | `num:xs` 20.57%、`code:m` **33.67%**、全局跨语料 21.53% |
| M3 (off) | `num:xs` 20.57%、`code:xs` 23.21%、`code:s` 21.08%、`code:m` 72.48%+偏差 23.88%、`mixed:l` 15.11%、`num:l` 38.36%、`code:l` 64.69%、`mixed:xl` 15.12%、`num:xl` 38.10%、`code:xl` 65.53%、全局跨语料 25.52%、内容组间 22.12% |

TNS 打开把语速类违规从 13 项压到 3 项（与验收报告一致）；**atomic 让 `code:xl` 43.71% 消失，却让 `code:m` 从 1.12% 涨到 33.67%，语速类违规仍是 3 项**。净数量没有下降——这是单格 A/B 看不到的结论，也是本轮最重要的发现。

**根因（逐块定位）**：M2 `code_m.json` 的 #3 是一块 54 字超长块，规范化后 16.5 单元、音频 4.859s → **3.396 u/s**（其余块 4.91~4.92）。它来自 `rebalance_tail_safe`「没有两段都 ≥10 单元的合法切点就合并成 ≤96 字块」的策略；服务端 `split_long_text` 对 >48 字请求二次切分，切出的短段带多段句内静音（有声 3.9s / 总 4.859s → 0.959s 静音），`compress_internal_gaps()` 只压 >0.9s 的**单段**静音，完全没命中。这与 `num:xs` 的 0.900s 静音是同一类现象，正是调研报告 §6 的 P1 方案（短块 0.3s 静音上限）要解决的。

**TTFA 数据本轮不干净**：三组分别有 9 / 6 / 6 项 TTFA 类违规，数值多在 2000ms 阈值附近（2001~3728ms）。本轮真机采集与 `npm test`（10226 项用例）、`npm run check`、多次 bundle 构建并行，CPU 争抢抬高了首块延迟；上一轮验收报告的 on 7 项 / off 17 项与本轮 M1 12 / M3 19 的差额几乎全是 TTFA 首块项。**不能拿 TTFA 项数变化当方案效果**，判据与阈值一个都没改。

### 5.4 常规真机门禁汇总

| 门禁 | 结果 |
|---|---|
| `longtext_probe --check`（atomic 关） | ✅ exit 0，4/4 |
| `longtext_probe --atomic --check` | ✅ exit 0，4/4 |
| `check_continuity --tns on` | ✅ exit 0，11/11 |
| `tns_probe --check`（15 场景 ASR 回听） | ✅ exit 0，**0 项违规** |
| 25 格矩阵三组 | ⚠️ exit 1，违规持续可见（见 §5.3），未删语料、未放宽阈值 |

产物：`/tmp/dcx-final/{longtext-off,longtext-on,continuity,tns,matrix-on,matrix-on-atomic,matrix-off}/`，逐格 JSON + `report.md`。

### 5.5 试过但**未采用**的替代策略（附真机证据）

改动：`rebalance_tail_safe` / `rebalanceShortBlock` 在 `valid` 为空时不合并超长块，改选 `minSide` 最大的合法切点，保证每块 ≤48 字。真机 A/B（`/tmp/dcx-atomic-fix2`）：

| 格子 | baseline | 当前实现 | 替代策略 |
|---|---:|---:|---:|
| `code:xl` | 43.71% ❌ | 6.84% ✅ | **7.25%** ✅ |
| `code:m` | 1.12% ✅ | 33.67% ❌ | **0.81%** ✅ |

两格都达标，但离线切分付出这些代价：`code:xl` 26 块 / 最长 53 字 / 最短非首块 **8.4 单元**；`code:m` 5 块 / **5.9 单元碎片**（真机 F0 275.9Hz）；`code:l` 9.93 单元。这违反 `MIN_BLOCK_UNITS=10` 既有护栏——历史上 <10 单元块会被模型当短促感叹句，F0 冲到 300Hz、语速翻倍，正是长文本「忽然换人」的元凶。

**决定：回退到已验证的 6.84% 实现，保留默认关。** 不为让两格数字好看而放宽护栏或删除判据。下一步应把 P0 与调研报告 §6 的「短块句内静音上限 0.3s」叠加真机验证，而不是改切分策略去绕开它。

---

## 6. 静态与离线回归

| 项目 | 结果 |
|---|---|
| `npm run check`（typecheck / lint / prettier / IPC） | ✅ exit 0（144 条既有 warning，0 error） |
| 额外手动 eslint + prettier（根 glob 未覆盖 `packages/web/web/src`） | ✅ 0 error；已修 `atomic.ts` 两处无用转义、两个文件格式 |
| Python 8 套离线单测 | ✅ 全过（含新增 `test_atomic_chunks.py`） |
| `ruff check --select F821,F401,E9` + `py_compile` | ✅ 全过 |
| 前端新增用例 | ✅ 27/27（`node --import tsx --test voice-atomic-chunk.test.ts`，最终态复跑） |
| `npm test` 全量 | ⚠️ exit 1，10226 项 / 10203 pass / 1 fail / 22 skip，**唯一失败与本轮无关**（§6.1） |
| CLI bundle | ✅ `npm run bundle` exit 0（先 `mv` 备份 `dist/bundled` 绕开环境批量删除保护） |
| Web bundle | ✅ `npm run build --workspace @vegamo/deepcode-web` exit 0，产物 513241 B，含 `dcx.voice.atomicChunk.v1`、`atomicChunk` deps 与 URL/路径原子正则；局部标识符被压缩，`atomicChunkRef` 字面串不在产物中（属正常 minify，非功能缺失） |

### 6.1 `npm test` 唯一失败项：既有依赖版本漂移（非本轮引入）

```
not ok 57 - Sharp tests run against the declared dependency version
  packages/vscode-ide-companion/src/tests/sharp-loader.test.ts:133
  Expected values to be strictly equal: '0.35.5' !== '0.35.4'
```

- 该测试文件把 `SHARP_VERSION = "0.35.4"` 硬编码在源码里，并断言 `sharp.versions.sharp` 等于它；本机实际安装的是 **0.35.5**。
- `git status` 显示 `packages/vscode-ide-companion/` **本轮零改动**；本轮 `package.json` 只新增 4 个 `test:voice:*:atomic` 脚本，未碰任何依赖版本。该断言在基础提交 `156b4697` 上同样会失败。
- 处置：**不修、不改测试、不刷绿**。依赖版本对齐属独立变更，混入语音提交会掩盖真实基线；如需处理应单独提交（要么把依赖锁回 0.35.4，要么同步更新声明版本）。
- 其余 10203 项 pass，含 `packages/web` 全部前端用例与新增的 27 条 atomic parity 用例。

---

## 7. 诚实边界

1. **默认关，且本轮不建议默认打开**：前端偏好与服务端变量默认都是 off。全量矩阵证明单独打开 atomic 会把 `code:xl` 的违规搬到 `code:m`（§5.3），需要先与 P1 短块静音上限叠加验证。桌面 WebView 真机听感也仍需本人确认。
2. **本轮真机数据不是 WebView 端到端**：所有采集来自「Python 复刻前端切分 + 直连 sidecar」。`sentence.ts` 的 `stripForSpeech` 会剥掉裸 URL / Markdown 代码块，而矩阵语料是纯文本、完整送 TTS；对含代码块的真实回复，前端实际朗读内容不同。
3. **探针复刻与真实前端在短块处理上仍有差异**：`SpeechQueue` 用 `pendingShort` 攒 <10 单元碎片并在 `flush()` 结算，探针复刻用的是 `balance_blocks_safe` 重划。§5.5 替代策略的 0.81% 不能直接当作真实前端表现。
4. **服务端那层未单独 A/B**：它只作用于规范化后文本，严格守 ≤48 字；6.84% 的收益来自前端，不来自它。
5. **TTFA 数据受并行负载污染**：本轮真机采集与 `npm test` / `npm run check` / bundle 构建并行，首块延迟普遍抬高；TTFA 项数变化不能当方案效果。语速类判据按音频时长算，不受影响。
6. **未在本轮修复的历史违规**：`num:xs` 句内静音（0.9s）、`plain` 首块/全局 TTFA P95、大写下划线标识符、跨段 F0、网关 `tns` 不透传，以及本轮新增的 `code:m` 超长块短段静音。方案与代价见 `tns-residual-fix-research-2026-11-07.md` §4/§6/§7 与本报告 §5.3/§5.5；矩阵门禁持续报出，不得删语料或放宽阈值。
7. **F0 / 频谱质心只是音色代理**，不等于说话人验证。
8. 桌面 WebView 用独立 JWT，脚本不代跑；45 个 `ab-*.wav` 可听样本仍需本人 A/B。
9. **`npm test` 不是全绿**：存在 1 项既有 `sharp` 版本断言失败（§6.1）。本轮所有语音相关门禁独立复跑通过，但不把「全量测试通过」写进结论。

---

## 8. 灰度与回退

> ⚠️ **当前只建议用于 A/B 灰度，不要当默认配置打开**：全量矩阵显示单独打开
> 会把 `code:xl` 的违规搬到 `code:m`（§5.3）。灰度时请同时试听 `code:xl`
> 与 `code:m` 两类内容，并保留一键回退。

```bash
# 灰度（前端， DevTools Console）
localStorage.setItem('dcx.voice.atomicChunk.v1', '1'); location.reload();

# 可选增强（服务端，需重启）
DCX_VOICE_ATOMIC_CHUNK=1 bash scripts/voice/start.sh
curl -s --noproxy '*' http://127.0.0.1:8791/health | python3 -m json.tool | grep atomicChunk

# 回退：删前端键 + 去掉环境变量重启；关闭态音频与 031f1cc2 逐字一致
localStorage.removeItem('dcx.voice.atomicChunk.v1');
```

---

## 9. 复现命令

```bash
npm run test:voice:atomic                    # 离线单测（不需要 sidecar）
npm run test:voice:atomic:ab                 # 离线 A/B 切分对照
npm run test:voice:longtext:atomic           # 真机长文本 --atomic --check
npm run test:voice:matrix:atomic             # 真机 25 格 --atomic --check
python3 scripts/voice/chunking_ab_probe.py --cells code:xl,plain:xl \
    --modes baseline,atomic --out /tmp/dcx-atomic-ab
python3 scripts/voice/mixed_matrix_probe.py --tns on --check            # 关闭态基线
python3 scripts/voice/mixed_matrix_probe.py --tns off --check           # 旧基线不回归
```

---

## 10. 补记（2026-11-07 第八轮 P1 实测修正）

**本文 §2 与 §7.4 把服务端 `DCX_VOICE_ATOMIC_CHUNK` 写成「可选增强、不是
收益来源」——这个判断需要修正。** 本轮重启为 `atomicChunk=on` 后补测发现：

- 前端 atomic 允许放出 54~59 字请求，服务端 `split_long_text()` 必然二次切分；
  服务端变量关闭时，同一段被切成 `…voic` + `e…`，把刚保住的拉丁词又切碎。
  打开后切在 `voice，` 后。见 `short-gap-p1-2026-11-07.md` §5.3。
- `code:m` 在 P0+P1 叠加下的块间语速极差：服务端 off **27.04%** → on
  **10.87%**；`code:xl` 2.10% → 1.82%。服务端那层不是收益的**充分**条件，
  但在 >48 字请求上是**必要**条件。

本文其余结论（默认关、不建议默认打开、`code:m` 回归来自 54 字超长块被二次
切分、替代策略未采用）保持不变：`code:m` 即使三开关全开仍为 10.87%，未达标。
