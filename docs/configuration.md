# Deep Code 配置

## 配置层级

配置按以下优先级顺序应用（数字较小的会被数字较大的覆盖）：

| 层级 | 配置来源     | 说明                                          |
| ---- | ------------ | ------------------------------------------- |
| 1    | 默认值       | 应用程序内硬编码的默认值                         |
| 2    | 用户设置文件 | 当前用户的全局设置                               |
| 3    | 项目设置文件 | 项目特定的设置                                   |
| 4    | 环境变量     | 系统范围或会话特定的变量                          |

## 设置文件

Deep Code 使用 `settings.json` 设置文件进行持久化配置，支持两个层级的存放位置：

| 文件类型     | 位置                                 | 作用范围                                              |
| ------------ | ---------------------------------- | ---------------------------------------------------- |
| 用户设置文件 | `~/.deepcode/settings.json`         | 适用于当前用户的所有 Deep Code 会话。                      |
| 项目设置文件 | `项目根目录/.deepcode/settings.json` | 仅在该特定项目中运行 Deep Code 时生效。项目设置会覆盖用户设置。 |

### `settings.json` 中的可用设置

以下是 `settings.json` 支持的全部顶层字段，以及 `env` 内部支持的子字段：

| 字段                 | 类型      | 说明                                                                |
| -------------------- | --------- | ------------------------------------------------------------------- |
| `env`                | object    | 环境变量分组（见下方子字段表）                                       |
| `contextWindow`      | number/string | 上下文窗口上限，可使用精确 token 数或 `128K`、`1M` 等格式          |
| `autoCompactWindow`  | number/string | 自动压缩阈值，默认取最终上下文窗口的 80%                           |
| `model`              | string    | 模型名称。优先级高于 `env.MODEL`                                    |
| `provider`           | string    | LLM 提供商声明，可选 `"openai"` 或 `"anthropic"`（详见 [provider 章节](#provider--llm-提供商)） |
| `thinkingEnabled`    | boolean   | 是否启用思考模式（DeepSeek V4 系列默认启用）                         |
| `reasoningEffort`    | string    | 推理强度，可选 `"low"`、`"medium"`、`"high"`、`"xhigh"` 或 `"max"`（默认 `"max"`） |
| `multimodal`         | string    | 多模态（图片）能力开关，可选 `"default"`、`"on"` 或 `"off"`（默认 `"default"`） |
| `filesApiEnabled`    | boolean   | 是否通过 DeepSeek Files API 发送图片（默认 `false`）                       |
| `filesApiTimeoutMs`  | number    | 单张图片 Files API 处理超时，默认 `60000`，最大 `600000` 毫秒              |
| `fileExpiresAfterSeconds` | number | 远端文件有效期，默认 `604800` 秒                                      |
| `fileRefreshMarginSeconds` | number | 剩余有效期低于该值时刷新缓存，默认 `3600` 秒                         |
| `fileQuotaCleanupBatch` | number | 配额不足时清理的最旧 Deep Code 文件数，默认 `100`                         |
| `maxRequestFilesBytes` | number | 单次请求内图片原始字节总上限，默认 `134217728`（128 MiB）                    |
| `debugLogEnabled`    | boolean   | 是否启用调试日志输出（默认 `false`）                                 |
| `telemetryEnabled`   | boolean   | 是否启用匿名使用数据上报（默认 `true`）                              |
| `notify`             | string    | 任务完成通知脚本的完整路径（如 Slack 通知脚本）                      |
| `webSearchTool`      | string    | 自定义联网搜索脚本的完整路径                                         |
| `mcpServers`         | object    | MCP 服务器配置（键为服务名，值为 McpServerConfig 对象）              |
| `temperature`        | number    | 模型采样温度，范围 `0` 到 `2`                           |
| `enabledSkills`      | object    | 按 skill 名称启用或禁用 skill 的配置                                 |
| `statusline`         | object    | 状态栏插件配置(参见 [statusline.md](./statusline.md))               |

#### `env` 子字段

| 字段       | 类型   | 说明                                                               |
| ---------- | ------ | ------------------------------------------------------------------ |
| `MODEL`    | string | 模型名称。例如 `"deepseek-v4-pro"`、`"deepseek-v4-flash"`、`"claude-sonnet-4-6"`、`"Qwen/Qwen3.6-27B"` |
| `BASE_URL` | string | API 请求的基础 URL。例如 `"https://api.deepseek.com"`              |
| `API_KEY`  | string | API 密钥                                                          |
| `PROVIDER` | string | LLM 提供商声明，可选 `"openai"` 或 `"anthropic"`（优先级低于 `provider` 顶层字段） |
| `LLM_PROVIDER` | string | `PROVIDER` 的别名（当 `PROVIDER` 未设置时生效） |
| `LLM_BASE_URL` | string | `BASE_URL` 的别名（当 `BASE_URL` 未设置时生效，便于 `LLM_` 前缀统一配置） |
| `LLM_API_KEY` | string | `API_KEY` 的别名（当 `API_KEY` 未设置时生效） |
| `LLM_MODEL` | string | `MODEL` 的别名（当 `MODEL` 未设置时生效） |
| `TIMEOUT` | string | LLM 请求超时（秒），默认 `600`（10 分钟）。无前缀优先于 `LLM_TIMEOUT` |
| `LLM_TIMEOUT` | string | `TIMEOUT` 的别名（当 `TIMEOUT` 未设置时生效） |
| `ANTHROPIC_BETA` | string | Anthropic beta 特性列表，逗号分隔（如 `"extended-thinking,prompt-caching"`） |
| `ANTHROPIC_MAX_TOKENS` | string | Claude 最大输出 token 数（默认 `8192`） |
| `ANTHROPIC_THINKING_BUDGET` | string | Claude extended thinking 预算 token 数（默认 `4096`） |
| `TEMPERATURE`  | string | Chat Completions 采样温度，范围 `"0"` 到 `"2"`（仅 openai provider 生效） |
| `THINKING_ENABLED`  | string | 是否启用思考模式                                         |
| `REASONING_EFFORT`  | string | 推理强度                                                |
| `MULTIMODAL`  | string | 多模态（图片）能力开关，可选 `"default"`、`"on"` 或 `"off"`         |
| `DEBUG_LOG_ENABLED`  | string | 是否启用调试日志输出                                     |
| `TELEMETRY_ENABLED`  | string | 是否启用匿名使用数据上报                                   |
| `<其他任意KEY>` | string | 自定义环境变量 |

> **LLM_ 前缀别名**：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT` 是对应无前缀字段的别名，仅在无前缀版本未设置时生效。这样用户可以使用统一的 `LLM_` 前缀配置所有 LLM 相关参数，降低配置心智成本。

> **TIMEOUT 配置**：`TIMEOUT` 和 `LLM_TIMEOUT` 控制 LLM HTTP 请求的超时时间（单位：秒），默认 `600` 秒。对于推理时间较长的模型（如 Qwen3 thinking 模式、DeepSeek V4），建议设置为 `1200` 或更高。

#### 上下文窗口

`contextWindow` 和 `autoCompactWindow` 是 `settings.json` 的顶层字段。number 必须是正整数，表示精确 token 数；string 使用大小写不敏感的 `K` 或 `M` 后缀，按 `1K = 1024`、`1M = 1024²` 换算：

```json
{
  "contextWindow": "1M",
  "autoCompactWindow": "512K"
}
```

普通模型的默认上下文窗口为 `256K`，DeepSeek V4 系列为 `1M`，Qwen3.8+ 系列为 `128K`。未设置自动压缩阈值时取最终上下文窗口的 80%（预留 20% 给模型输出与工具结果，对齐业界主流编码代理的 70%–92% 区间）；无效值会被忽略，自动压缩阈值超过上下文窗口时会限制为上下文窗口。

#### `provider` — LLM 提供商

Deep Code 支持多种 LLM 提供商，通过 `provider` 字段显式声明，或通过环境变量、模型名称前缀自动推断。

**支持的 provider**：

| provider 值 | 说明 | 默认模型 | 默认 baseURL |
| ------------ | ---- | -------- | ------------ |
| `"openai"` | OpenAI 兼容 API（默认，支持 DeepSeek 等） | `deepseek-v4-pro` | `https://api.deepseek.com` |
| `"anthropic"` | Anthropic Claude 原生 API | `claude-sonnet-4-6` | `https://api.anthropic.com` |

**解析优先级（高 → 低）**：

1. `settings.provider`（顶层字段显式声明）
2. `env.PROVIDER` / `env.LLM_PROVIDER`（环境变量）
3. 按 `model` 前缀推断：`claude-*` → `anthropic`；其余 → `openai`
4. 默认 `"openai"`（保持向后兼容）

**Anthropic Claude 配置示例**：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "env": {
    "API_KEY": "sk-ant-...",
    "BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_BETA": "extended-thinking,prompt-caching"
  }
}
```

**Anthropic 专属环境变量**：

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `ANTHROPIC_BETA` | beta 特性列表，逗号分隔（如 `extended-thinking,prompt-caching`） | 空 |
| `ANTHROPIC_MAX_TOKENS` | Claude 最大输出 token 数 | `8192` |
| `ANTHROPIC_THINKING_BUDGET` | extended thinking 预算 token 数 | `4096` |

**校验规则**：

- `provider=anthropic` 时，`env.API_KEY` 必须存在且以 `sk-ant-` 开头（格式校验，非密钥有效性校验）
- `MODEL` 未设置时，按 provider 给默认：`anthropic` → `claude-sonnet-4-6`；`openai` → `deepseek-v4-pro`
- `temperature` 仅在 `openai` provider 下生效；Claude 使用 `top_p`/`top_k`，配置 `temperature` 时告警并忽略
- 无自动降级：provider 由用户显式配置，故障时明确报错而非静默切换

**Qwen3 模型配置示例**：

Qwen3 系列模型通过 vLLM 部署，兼容 OpenAI API 格式。使用 `provider=openai`（默认），通过 `LLM_` 前缀环境变量统一配置：

```json
{
  "env": {
    "LLM_BASE_URL": "http://47.95.252.237:8003/v1",
    "LLM_API_KEY": "sk-your-api-key",
    "LLM_MODEL": "Qwen/Qwen3.6-27B",
    "LLM_TIMEOUT": "1200"
  }
}
```

Qwen3 thinking 参数格式说明：

| 模型系列 | 启用 thinking 参数格式 | reasoning 返回字段 |
|----------|----------------------|-------------------|
| Qwen3（<3.8） | `chat_template_kwargs: { enable_thinking: true }`（请求体顶层字段） | `reasoning_content` |
| Qwen3.8+ | `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` + 顶层 `reasoning_effort`（thinking 开启时） | `reasoning_content` 或 `reasoning` |
| DeepSeek V4 | `thinking: { type: "enabled" }` + `extra_body: { reasoning_effort }` | `reasoning_content` |
| Anthropic Claude | `thinking: { type: "enabled", budget_tokens: N }` | `thinking` 块 |

> Qwen3 的 `chat_template_kwargs` 是 vLLM 标准参数，必须作为请求体顶层字段传递（不包装在 `extra_body` 中）。

> Qwen3 模型名识别规则：大小写不敏感，以 `qwen3` 或 `qwen/qwen3` 开头。覆盖 Qwen3-8B / Qwen3-32B / Qwen3-30B-A3B / Qwen/Qwen3.6-27B / qwen3.6-plus / qwen3.7-max 等。

**Qwen3.8+ 专属参数**（v1.2 适配，如 `Qwen/Qwen3.8-27B-FP8` / `qwen3.8-plus` / `qwen3.9-70b`）：

| 参数 | 位置 | 说明 |
|------|------|------|
| `enable_thinking` | `chat_template_kwargs` | thinking 模式开关（thinking 开启/关闭均下发） |
| `preserve_thinking` | `chat_template_kwargs` | 保留历史消息思考块；CLI 在 thinking 模式下回放历史 `reasoning_content`，与此参数语义一致，故 thinking 开启时显式下发 `true`（thinking 关闭时不下发，沿用服务端默认） |
| `reasoning_effort` | 请求体顶层 | Qwen3.8 官方推理强度，仅 thinking 开启时下发，取值 `xhigh`（服务端默认）/ `medium` / `low`，由 CLI 五档映射而来（见下文 `reasoningEffort` 映射表） |

> 排查「模型忘记上文思考」类问题时需同时看两侧：CLI 侧历史 `reasoning_content` 的回放是无条件的，而历史思考块是否真正进入 prompt 还取决于服务端 `preserve_thinking` 的生效情况。

> 流式输出的思考增量字段因部署而异：主流 vLLM 使用 `delta.reasoning_content`，部分部署使用 `delta.reasoning`，Deep Code 两种字段均兼容。

#### `thinkingEnabled` — 思考模式

是否启用思考模式。设置为 `true` 启用、`false` 禁用。

- 对于 `deepseek-v4-pro` 和 `deepseek-v4-flash`，思考模式**默认启用**。
- 对于 Qwen3 系列模型（以 `qwen3` / `qwen/qwen3` 开头），思考模式**默认启用**。
- 对于其他模型，思考模式**默认关闭**。

> Qwen3 使用 `chat_template_kwargs.enable_thinking` 参数控制 thinking 模式，与 DeepSeek 的 `thinking.type` 格式不同。Deep Code 会根据模型名自动选择正确的参数格式。

#### `reasoningEffort` — 推理强度

当思考模式启用时，控制模型思考的深度：

| 值      | 说明                               |
| ------- | --------------------------------- |
| `max`   | 最大推理深度（默认值）              |
| `xhigh` | 极高推理深度（Qwen3.8 服务端默认档） |
| `high`  | 较高推理深度，token消耗相对较小      |
| `medium`| 中等推理深度                        |
| `low`   | 较低推理深度，token消耗更少          |

**Qwen3.8+ 顶层 `reasoning_effort` 映射**（模型官方仅定义 `xhigh` / `medium` / `low` 三档）：

| CLI 档位 | Qwen3.8 顶层值 | 说明 |
| -------- | -------------- | ---- |
| `low`    | `low`          | 直传 |
| `medium` | `medium`       | 直传 |
| `high`   | `medium`       | Qwen3.8 无 high 档，保守向下钳到次低档以控制 token 开销 |
| `xhigh`  | `xhigh`        | 直传（Qwen3.8 服务端默认档） |
| `max`    | `xhigh`        | 钳制到官方最高档 |

DeepSeek V4 的 `reasoning_effort` 经 `extra_body` 下发，档位语义由 DeepSeek 服务端定义。

#### `multimodal` — 多模态（图片）能力

控制是否将当前模型视为支持图片输入的多模态模型：

| 值         | 说明                                                         |
| ---------- | ------------------------------------------------------------ |
| `default`  | 按内置模型列表自动判定（默认值）                              |
| `on`       | 强制视为多模态模型，图片以 `image_url` 形式直接内联发送        |
| `off`      | 强制视为非多模态模型，由模型通过识图工具按需读取      |

当使用的模型未内置在已知模型列表中、或其实际能力与默认判定不符时，可通过该配置覆盖。

#### DeepSeek Files API

设置 `filesApiEnabled: true` 后，Deep Code 会将图片上传到固定的 `https://api.deepseek.com/files`，并在聊天请求中使用 `file_id`。上传或缓存刷新失败时，本次请求直接失败；关闭开关时图片处理逻辑保持不变。

```json
{
  "filesApiEnabled": true,
  "filesApiTimeoutMs": 60000,
  "fileExpiresAfterSeconds": 604800,
  "fileRefreshMarginSeconds": 3600,
  "fileQuotaCleanupBatch": 100,
  "maxRequestFilesBytes": 134217728
}
```

单个文件最大 64 MiB，上传超时不能超过 DeepSeek 规定的 10 分钟。远端文件 ID 会缓存在 `~/.deepcode/files-api-cache.json`；缓存不保存明文 API Key。遇到远端存储配额错误时，只会清理文件名以 `deepcode-` 开头的最旧文件，然后重试一次。

#### `notify` — 任务完成通知

设置一个 Shell 脚本的完整路径。当 AI 助手完成一轮任务后，会自动执行该脚本，可用于发送通知（如 Slack 消息）。

通知脚本执行时，会通过环境变量注入以下上下文信息：

| 环境变量 | 说明 |
|----------|------|
| `DURATION` | 会话耗时，单位秒（整数） |
| `STATUS` | 会话状态：`"completed"` 或 `"failed"` |
| `FAIL_REASON` | 失败原因（仅失败时设置） |
| `BODY` | 最后一条 AI 助手回复的文本内容 |
| `TITLE` | 会话标题（对应 resume 列表中的标题） |

```json
{
  "notify": "/path/to/notify-script.sh"
}
```

> 详细的 Slack、飞书、终端通知、系统通知等配置示例，请参阅 [notify.md](notify.md)。

#### `webSearchTool` — 自定义联网搜索

未配置 `webSearchTool` 时，如果 `BASE_URL` 是 `https://api.deepseek.com`，Deep Code 会调用 DeepSeek Responses API 的 `web_search` 工具，并固定使用 `deepseek-v4-flash`，不受 `MODEL` 配置影响。其他 API 地址仍使用 Deep Code Web Search API。

如果需要自定义搜索逻辑，可将 `webSearchTool` 设为一个可执行脚本的完整路径。自定义脚本始终优先于内置搜索：

```json
{
  "webSearchTool": "/path/to/my-search-script.sh"
}
```

脚本接收一个搜索查询参数，输出 JSON 格式的结果供 AI 使用。

#### `enabledSkills` — Skill 启用配置

控制 skill 扫描时是否包含指定 skill。键是解析后的 skill 名称，值必须是布尔值：

```json
{
  "enabledSkills": {
    "skill-writer": false,
    "code-review": true
  }
}
```

- 未配置的 skill 默认启用。
- 将某个 skill 设置为 `false` 后，所有项目级和用户级目录中解析名称相同的 skill 都会被隐藏。
- 项目设置会按 skill 覆盖用户设置。如果项目设置没有配置某个 skill，则使用用户设置。

#### `mcpServers` — MCP 服务器

MCP（Model Context Protocol）服务器配置。值是键值对，键为服务名称，值为服务器配置对象。

```json
{
  "mcpServers": {
    "<服务名>": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

| McpServerConfig 字段 | 类型     | 必填 | 说明                                                                 |
| -------------------- | -------- | ---- | -------------------------------------------------------------------- |
| `command`            | string   | 是   | 可执行文件路径或命令（如 `npx`、`node`、`python`）                   |
| `args`               | string[] | 否   | 传递给命令的参数列表                                                  |
| `env`                | object   | 否   | 传递给 MCP 服务器进程的环境变量                                       |

> 当 `command` 为 `npx` 时，Deep Code 会自动在参数前补充 `-y`。

详细 MCP 使用说明请参考 [mcp.md](mcp.md)。


#### `debugLogEnabled` — 调试日志

设为 `true` 可让程序输出详细的调试日志（默认 `false`），用于排查 API 调用和工具执行的问题。

#### `telemetryEnabled` — 匿名使用数据上报

设为 `false` 可关闭匿名使用数据上报（默认 `true`）。上报仅包含匿名的机器标识，不包含对话内容、代码或 API 密钥。

也可以通过环境变量关闭：

```bash
DEEPCODE_TELEMETRY_ENABLED=0 deepcode
```

## 环境变量优先级

环境变量是配置应用程序的常用方式，尤其适用于敏感信息（如 api-key）或可能在不同环境之间更改的设置。

### 优先级原则

环境变量优先级遵循“越具体、越局部的配置，优先级越高”和“env文件默认保护现有环境，系统变量高于env文件”的覆盖逻辑。(settings.json的env对象可以认为是一种env文件)

优先级层级 (由低到高)
1. settings.json 外层的 env：这是针对整个工具及其所有子进程的通用配置（全局变量）。可被外层环境变量覆盖，但环境变量KEY会移除`DEEPCODE_`前缀。
2. settings.json mcpServers 内定义的 env：这是针对特定 MCP 服务的最具体配置（局部变量）。可被外层环境变量覆盖，但环境变量KEY会移除`MCP_`前缀。
3. Shell 环境系统变量：操作系统层面的环境变量。

### 场景

#### 一、设置模型的api_key, base_url

按以下优先级顺序应用（数字较小的会被数字较大的覆盖）(以api_key为例)：

1. 硬编码默认值: `""`
2. 用户级settings.json: `{"env": {"API_KEY": "abc123"}}`
3. 项目级settings.json: `{"env": {"API_KEY": "abc123"}}`
4. 系统环境变量: `DEEPCODE_API_KEY=abc123 deepcode`

#### 二、设置模型的model, thinkingEnabled, reasoningEffort

按以下优先级顺序应用（数字较小的会被数字较大的覆盖）(以thinkingEnabled为例)：

1. 硬编码默认值: `true`
2. 用户级settings.json: `{"env": {"THINKING_ENABLED": "true"}}`
3. 用户级settings.json: `{"thinkingEnabled": true}`
4. 项目级settings.json: `{"env": {"THINKING_ENABLED": "true"}}`
5. 项目级settings.json: `{"thinkingEnabled": true}`
6. 系统环境变量: `DEEPCODE_THINKING_ENABLED=true deepcode`

#### 三、设置启动notify, webSearchTool等外挂脚本的环境变量

按以下优先级顺序应用（数字较小的会被数字较大的覆盖）(以notify为例)：

1. 硬编码默认值：`os.environ.get('WEBHOOK', '...')  # notify脚本代码`
2. 用户级settings.json: `{"env": {"WEBHOOK": "..."}}`
3. 项目级settings.json: `{"env": {"WEBHOOK": "true"}}`
4. 系统环境变量: `DEEPCODE_WEBHOOK=... deepcode`

#### 四、设置MCP Service的环境变量

按以下优先级顺序应用（数字较小的会被数字较大的覆盖）(以github MCP server为例)：

1. 用户级settings.json: `{"mcpServers":{"github":{"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}}}`
2. 用户级settings.json: `{"env": {"MCP_GITHUB_PERSONAL_ACCESS_TOKEN": "..."}}`
3. 项目级settings.json: `{"mcpServers":{"github":{"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}}}`
4. 项目级settings.json: `{"env": {"MCP_GITHUB_PERSONAL_ACCESS_TOKEN": "..."}}`
5. 系统环境变量: `DEEPCODE_MCP_GITHUB_PERSONAL_ACCESS_TOKEN=... deepcode`
