# Deep Code Configuration

## Configuration Hierarchy

Configuration is applied in the following priority order (lower-numbered sources are overridden by higher-numbered ones):

| Layer | Configuration Source | Description                                    |
| ----- | -------------------- | ---------------------------------------------- |
| 1     | Defaults             | Hardcoded defaults within the application      |
| 2     | User settings file   | Global settings for the current user           |
| 3     | Project settings file| Project-specific settings                      |
| 4     | Environment variables| System-wide or session-specific variables      |

## Settings File

Deep Code uses the `settings.json` file for persistent configuration, supporting two storage locations:

| File Type           | Location                                  | Scope                                                                 |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| User settings file  | `~/.deepcode/settings.json`               | Applies to all Deep Code sessions for the current user.               |
| Project settings file | `<project root>/.deepcode/settings.json` | Takes effect only when running Deep Code in that specific project. Project settings override user settings. |

### Available Settings in `settings.json`

The following are all the top-level fields supported in `settings.json`, along with the sub-fields inside `env`:

| Field              | Type    | Description                                                                 |
| ------------------ | ------- | --------------------------------------------------------------------------- |
| `env`              | object  | Group of environment variables (see sub-field table below)                 |
| `contextWindow`   | number/string | Context-window limit as an exact token count or `128K`/`1M` value   |
| `autoCompactWindow` | number/string | Auto-compaction threshold; defaults to 80% of the final context window |
| `model`            | string  | Model name. Takes precedence over `env.MODEL`                              |
| `provider`         | string  | LLM provider declaration, either `"openai"` or `"anthropic"` (see [provider section](#provider--llm-provider)) |
| `thinkingEnabled`  | boolean | Whether to enable thinking mode (enabled by default for DeepSeek V4 series)|
| `reasoningEffort`  | string  | Reasoning intensity: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"` (default `"max"`) |
| `multimodal`       | string  | Multimodal (image) capability override: `"default"`, `"on"`, or `"off"` (default `"default"`) |
| `filesApiEnabled`  | boolean | Send images through the DeepSeek Files API (default `false`)               |
| `filesApiTimeoutMs` | number | Per-image Files API timeout; defaults to `60000`, maximum `600000` ms       |
| `fileExpiresAfterSeconds` | number | Remote file lifetime, default `604800` seconds                       |
| `fileRefreshMarginSeconds` | number | Refresh cached IDs below this remaining lifetime, default `3600` seconds |
| `fileQuotaCleanupBatch` | number | Oldest Deep Code files removed during quota recovery, default `100`    |
| `maxRequestFilesBytes` | number | Raw image byte limit per request, default `134217728` (128 MiB)          |
| `debugLogEnabled`  | boolean | Enable debug log output (default `false`)                                   |
| `telemetryEnabled` | boolean | Enable anonymous usage reporting (default `true`)                           |
| `notify`           | string  | Full path to a task-completion notification script (e.g., Slack notification script) |
| `webSearchTool`    | string  | Full path to a custom web search script                                     |
| `mcpServers`       | object  | MCP server configurations (keys are service names, values are McpServerConfig objects) |
| `temperature`      | number  | Sampling temperature for LLM, from `0` to `2`                 |
| `enabledSkills`    | object  | Per-skill enable/disable map, keyed by skill name                           |
| `statusline`       | object  | Status line plugins (see [statusline_en.md](./statusline_en.md))            |

#### `env` Sub-fields

| Field             | Type   | Description                                                      |
| ----------------- | ------ | ---------------------------------------------------------------- |
| `MODEL`           | string | Model name, e.g. `"deepseek-v4-pro"`, `"deepseek-v4-flash"`, `"claude-sonnet-4-6"`, `"Qwen/Qwen3.6-27B"` |
| `BASE_URL`        | string | Base URL for API requests, e.g. `"https://api.deepseek.com"`    |
| `API_KEY`         | string | API key                                                         |
| `PROVIDER`              | string | LLM provider declaration, either `"openai"` or `"anthropic"` (lower priority than `provider` top-level field) |
| `LLM_PROVIDER`          | string | Alias for `PROVIDER` (used when `PROVIDER` is not set) |
| `LLM_BASE_URL`          | string | Alias for `BASE_URL` (used when `BASE_URL` is not set, for unified `LLM_` prefix config) |
| `LLM_API_KEY`           | string | Alias for `API_KEY` (used when `API_KEY` is not set) |
| `LLM_MODEL`             | string | Alias for `MODEL` (used when `MODEL` is not set) |
| `TIMEOUT`               | string | LLM request timeout in seconds, default `600` (10 min). Takes priority over `LLM_TIMEOUT` |
| `LLM_TIMEOUT`           | string | Alias for `TIMEOUT` (used when `TIMEOUT` is not set) |
| `ANTHROPIC_BETA`        | string | Anthropic beta features, comma-separated (e.g., `"extended-thinking,prompt-caching"`) |
| `ANTHROPIC_MAX_TOKENS`  | string | Claude max output tokens (default `8192`) |
| `ANTHROPIC_THINKING_BUDGET` | string | Claude extended thinking budget tokens (default `4096`) |
| `TEMPERATURE`     | string | Sampling temperature for chat completions, from `"0"` to `"2"` (only effective for openai provider) |
| `THINKING_ENABLED`| string | Enable thinking mode                                            |
| `REASONING_EFFORT`| string | Reasoning intensity                                             |
| `MULTIMODAL`      | string | Multimodal (image) capability override: `"default"`, `"on"`, or `"off"` |
| `DEBUG_LOG_ENABLED`| string| Enable debug log output                                         |
| `TELEMETRY_ENABLED`| string| Enable anonymous usage reporting                                |
| `<any other KEY>` | string | Custom environment variable                                     |

> **LLM_ Prefix Aliases**: `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT` are aliases for their non-prefixed counterparts, only effective when the non-prefixed version is not set. This allows users to configure all LLM-related parameters with a unified `LLM_` prefix.

> **TIMEOUT Configuration**: `TIMEOUT` and `LLM_TIMEOUT` control the LLM HTTP request timeout (in seconds), default `600` seconds. For models with long reasoning times (e.g., Qwen3 thinking mode, DeepSeek V4), it is recommended to set `1200` or higher.

#### Context Windows

`contextWindow` and `autoCompactWindow` are top-level `settings.json` fields. A number must be a positive integer and represents an exact token count. A string uses a case-insensitive `K` or `M` suffix, with `1K = 1024` and `1M = 1024²`:

```json
{
  "contextWindow": "1M",
  "autoCompactWindow": "512K"
}
```

The default context window is `256K` for regular models, `1M` for DeepSeek V4 models, and `128K` for the Qwen3.8+ series. If the auto-compaction threshold is omitted, it is 80% of the final context window (reserving 20% for model output and tool results, aligned with the 70%–92% range of mainstream coding agents). Invalid values are ignored, and an auto-compaction threshold larger than the context window is capped at the context window.

#### `provider` — LLM Provider

Deep Code supports multiple LLM providers, declared explicitly via the `provider` field, or automatically inferred from environment variables or model name prefixes.

**Supported providers**:

| provider value | Description | Default model | Default baseURL |
| -------------- | ----------- | -------------- | --------------- |
| `"openai"` | OpenAI-compatible API (default, supports DeepSeek etc.) | `deepseek-v4-pro` | `https://api.deepseek.com` |
| `"anthropic"` | Anthropic Claude native API | `claude-sonnet-4-6` | `https://api.anthropic.com` |

**Resolution priority (high → low)**:

1. `settings.provider` (explicit top-level field declaration)
2. `env.PROVIDER` / `env.LLM_PROVIDER` (environment variables)
3. Inferred from `model` prefix: `claude-*` → `anthropic`; otherwise → `openai`
4. Default `"openai"` (backward compatible)

**Anthropic Claude configuration example**:

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

**Anthropic-specific environment variables**:

| Environment variable | Description | Default value |
|----------------------|-------------|---------------|
| `ANTHROPIC_BETA` | Beta feature list, comma-separated (e.g. `extended-thinking,prompt-caching`) | empty |
| `ANTHROPIC_MAX_TOKENS` | Claude max output tokens | `8192` |
| `ANTHROPIC_THINKING_BUDGET` | Extended thinking budget tokens | `4096` |

**Validation rules**:

- When `provider=anthropic`, `env.API_KEY` must exist and start with `sk-ant-` (format validation, not key validity validation)
- When `MODEL` is not set, a default is chosen by provider: `anthropic` → `claude-sonnet-4-6`; `openai` → `deepseek-v4-pro`
- `temperature` only takes effect under the `openai` provider; Claude uses `top_p`/`top_k`, so configuring `temperature` triggers a warning and is ignored
- No automatic fallback: the provider is explicitly configured by the user, and failures produce explicit errors rather than silent switching

**Qwen3 Model Configuration Example**:

Qwen3 series models are deployed via vLLM and are compatible with the OpenAI API format. Use `provider=openai` (default) and configure via `LLM_` prefix environment variables:

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

Qwen3 thinking parameter format:

| Model Series | Thinking Enable Parameter Format | Reasoning Return Field |
|--------------|----------------------------------|----------------------|
| Qwen3 (<3.8) | `chat_template_kwargs: { enable_thinking: true }` (top-level request body field) | `reasoning_content` |
| Qwen3.8+ | `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` + top-level `reasoning_effort` (when thinking is on) | `reasoning_content` or `reasoning` |
| DeepSeek V4 | `thinking: { type: "enabled" }` + `extra_body: { reasoning_effort }` | `reasoning_content` |
| Anthropic Claude | `thinking: { type: "enabled", budget_tokens: N }` | `thinking` block |

> Qwen3's `chat_template_kwargs` is a vLLM standard parameter that must be passed as a top-level request body field (not wrapped in `extra_body`).

> Qwen3 model name identification: case-insensitive, starts with `qwen3` or `qwen/qwen3`. Covers Qwen3-8B / Qwen3-32B / Qwen3-30B-A3B / Qwen/Qwen3.6-27B / qwen3.6-plus / qwen3.7-max, etc.

**Qwen3.8+ specific parameters** (v1.2 adaptation, e.g. `Qwen/Qwen3.8-27B-FP8` / `qwen3.8-plus` / `qwen3.9-70b`):

| Parameter | Location | Description |
|-----------|----------|-------------|
| `enable_thinking` | `chat_template_kwargs` | Thinking mode switch (sent whether thinking is on or off) |
| `preserve_thinking` | `chat_template_kwargs` | Keep thinking blocks in history messages; the CLI replays historical `reasoning_content` in thinking mode, matching this parameter's semantics, so it is explicitly sent as `true` when thinking is on (not sent when thinking is off, server default applies) |
| `reasoning_effort` | Top-level request body | Official Qwen3.8 reasoning effort, sent only when thinking is on; values are `xhigh` (server default) / `medium` / `low`, mapped from the CLI's five levels (see the `reasoningEffort` mapping table below) |

> When debugging "model forgets earlier thinking" issues, inspect both sides: the CLI's replay of historical `reasoning_content` is unconditional, while whether the thinking block actually enters the prompt also depends on the server-side `preserve_thinking` behavior.

> Streaming thinking-delta fields vary by deployment: mainstream vLLM uses `delta.reasoning_content`, some deployments use `delta.reasoning`; Deep Code supports both.

#### `thinkingEnabled` — Thinking Mode

Whether to enable thinking mode. Set to `true` to enable, `false` to disable.

- For `deepseek-v4-pro` and `deepseek-v4-flash`, thinking mode is **enabled by default**.
- For Qwen3 series models (starting with `qwen3` / `qwen/qwen3`), thinking mode is **enabled by default**.
- For other models, thinking mode is **disabled by default**.

> Qwen3 uses the `chat_template_kwargs.enable_thinking` parameter to control thinking mode, which differs from DeepSeek's `thinking.type` format. Deep Code automatically selects the correct parameter format based on the model name.

#### `reasoningEffort` — Reasoning Intensity

When thinking mode is enabled, controls the depth of the model’s reasoning:

| Value   | Description                                                |
| ------- | ---------------------------------------------------------- |
| `max`   | Maximum reasoning depth (default)                          |
| `xhigh` | Very high reasoning depth (Qwen3.8 server-side default)    |
| `high`  | Higher reasoning depth with relatively lower token usage   |
| `medium`| Medium reasoning depth                                     |
| `low`   | Lower reasoning depth with lower token usage               |

**Qwen3.8+ top-level `reasoning_effort` mapping** (the model officially defines only `xhigh` / `medium` / `low`):

| CLI level | Qwen3.8 top-level value | Note |
| --------- | ----------------------- | ---- |
| `low`     | `low`                   | pass-through |
| `medium`  | `medium`                | pass-through |
| `high`    | `medium`                | Qwen3.8 has no high level; clamped down conservatively to control token cost |
| `xhigh`   | `xhigh`                 | pass-through (Qwen3.8 server-side default) |
| `max`     | `xhigh`                 | clamped to the official top level |

DeepSeek V4's `reasoning_effort` is sent via `extra_body`, with level semantics defined by the DeepSeek server.

#### `multimodal` — Multimodal (Image) Capability

Controls whether the current model is treated as a multimodal model that accepts image input:

| Value     | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `default` | Inferred from the built-in known-model list (default)                       |
| `on`      | Always treat the model as multimodal, images are sent inline as `image_url` |
| `off`     | Always treat the model as non-multimodal, images are read on demand via UnderstandImage tool |

Use this to override the default detection when your model is not in the known-model list, or when its actual capability differs from the default.

#### DeepSeek Files API

With `filesApiEnabled: true`, Deep Code uploads images to the fixed `https://api.deepseek.com/files` endpoint and sends `file_id` references in chat requests. An upload or cache-refresh failure fails the request; disabling the setting preserves the existing image path.

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

Each file is limited to 64 MiB, and the upload timeout cannot exceed DeepSeek's 10-minute limit. Remote IDs are cached in `~/.deepcode/files-api-cache.json` without storing the plaintext API key. On a remote storage-quota error, only the oldest files whose names start with `deepcode-` are removed before one retry.

#### `notify` — Task Completion Notification

Set a full path to a shell script. When the AI assistant finishes a round of tasks, the script is executed automatically, which can be used to send notifications (e.g., a Slack message).

The following context is injected as environment variables when the notify script runs:

| Variable | Description |
|----------|-------------|
| `DURATION` | Session duration in seconds (integer) |
| `STATUS` | Session status: `"completed"` or `"failed"` |
| `FAIL_REASON` | Failure reason (only set on failure) |
| `BODY` | The text content of the last AI assistant reply |
| `TITLE` | Session title (matches the resume list title) |

```json
{
  "notify": "/path/to/notify-script.sh"
}
```

> For detailed configuration examples (Slack, Feishu, terminal notifications, system notifications, etc.), see [notify_en.md](notify_en.md).

#### `webSearchTool` — Custom Web Search

When `webSearchTool` is not configured and `BASE_URL` is `https://api.deepseek.com`, Deep Code calls the `web_search` tool through the DeepSeek Responses API with the fixed `deepseek-v4-flash` model, regardless of the `MODEL` setting. Other API endpoints continue to use the Deep Code Web Search API.

For custom search logic, set `webSearchTool` to the full path of an executable script. A custom script always takes precedence over the built-in search:

```json
{
  "webSearchTool": "/path/to/my-search-script.sh"
}
```

The script receives a search query as an argument and outputs results in JSON format for the AI.

#### `enabledSkills` — Skill Enablement

Controls whether skills are included during skill scanning. Keys are resolved skill names, and values must be booleans:

```json
{
  "enabledSkills": {
    "skill-writer": false,
    "code-review": true
  }
}
```

- Missing entries are enabled by default.
- Setting a skill to `false` hides every skill with that resolved `name`, across project and user skill roots.
- Project settings override user settings per skill. If the project setting omits a skill, the user setting is used.

#### `mcpServers` — MCP Servers

Configuration for MCP (Model Context Protocol) servers. The value is a key-value pair, where the key is the service name and the value is a server configuration object.

```json
{
  "mcpServers": {
    "<service name>": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    }
  }
}
```

| McpServerConfig field | Type     | Required | Description                                                              |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `command`             | string   | Yes      | Executable path or command (e.g. `npx`, `node`, `python`)                |
| `args`                | string[] | No       | List of arguments passed to the command                                  |
| `env`                 | object   | No       | Environment variables passed to the MCP server process                   |

> When `command` is `npx`, Deep Code automatically prepends `-y` to the arguments.

For detailed MCP usage instructions, refer to [mcp.md](mcp.md).

#### `debugLogEnabled` — Debug Log

Set to `true` to enable detailed debug logging (default `false`), useful for troubleshooting API calls and tool execution.

#### `telemetryEnabled` — Anonymous Usage Reporting

Set to `false` to disable anonymous usage reporting (default `true`). The report only includes an anonymous machine identifier and does not contain conversation content, code, or API keys.

You can also disable it via environment variable:

```bash
DEEPCODE_TELEMETRY_ENABLED=0 deepcode
```

## Environment Variable Priority

Environment variables are a common way to configure applications, especially for sensitive information (such as api-key) or settings that may change between environments.

### Priority Principle

Environment variable priority follows the logic of “the more specific and localized the configuration, the higher the priority”, and the override rule of “env files protect existing environment by default, system variables override env files”. (The `env` object in settings.json can be thought of as a type of env file.)

Priority levels (from lowest to highest):
1. `env` defined at the top level of `settings.json` – this is a general configuration for the entire tool and all its subprocesses (global variables). Can be overridden by outer environment variables, but the environment variable KEY has the `DEEPCODE_` prefix removed.
2. `env` defined inside `mcpServers` in `settings.json` – this is the most specific configuration for a particular MCP service (local variables). Can be overridden by outer environment variables, but the KEY has the `MCP_` prefix removed.
3. Shell/system environment variables – operating system level.

### Scenarios

#### 1. Setting the model’s api_key and base_url

Applied in the following priority order (lower-numbered sources are overridden by higher-numbered ones) – using api_key as an example:

1. Hardcoded default: `""`
2. User-level settings.json: `{"env": {"API_KEY": "abc123"}}`
3. Project-level settings.json: `{"env": {"API_KEY": "abc123"}}`
4. System environment variable: `DEEPCODE_API_KEY=abc123 deepcode`

#### 2. Setting model, thinkingEnabled, and reasoningEffort

Applied in the following priority order (lower-numbered overridden by higher-numbered) – using thinkingEnabled as an example:

1. Hardcoded default: `true`
2. User-level settings.json: `{"env": {"THINKING_ENABLED": "true"}}`
3. User-level settings.json: `{"thinkingEnabled": true}`
4. Project-level settings.json: `{"env": {"THINKING_ENABLED": "true"}}`
5. Project-level settings.json: `{"thinkingEnabled": true}`
6. System environment variable: `DEEPCODE_THINKING_ENABLED=true deepcode`

#### 3. Setting environment variables for external scripts like notify and webSearchTool

Applied in the following priority order (lower-numbered overridden by higher-numbered) – using notify as an example:

1. Hardcoded default: `os.environ.get('WEBHOOK', '...')  # notify script code`
2. User-level settings.json: `{"env": {"WEBHOOK": "..."}}`
3. Project-level settings.json: `{"env": {"WEBHOOK": "true"}}`
4. System environment variable: `DEEPCODE_WEBHOOK=... deepcode`

#### 4. Setting environment variables for an MCP Service

Applied in the following priority order (lower-numbered overridden by higher-numbered) – using a GitHub MCP server as an example:

1. User-level settings.json: `{"mcpServers":{"github":{"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}}}`
2. User-level settings.json: `{"env": {"MCP_GITHUB_PERSONAL_ACCESS_TOKEN": "..."}}`
3. Project-level settings.json: `{"mcpServers":{"github":{"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}}}`
4. Project-level settings.json: `{"env": {"MCP_GITHUB_PERSONAL_ACCESS_TOKEN": "..."}}`
5. System environment variable: `DEEPCODE_MCP_GITHUB_PERSONAL_ACCESS_TOKEN=... deepcode`
