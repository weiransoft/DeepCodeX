# 快速开始

Deep Code 是一款开源的终端 AI 编程助手，专为 DeepSeek-V4 系列模型适配，支持深度思考、推理强度控制，并通过 Skills 和 MCP 扩展更多能力。

## 前置要求

使用前请确认本机已安装：

- Node.js `22` 或更高版本
- 一个可用的 DeepSeek API Key

## 安装

使用 npm 全局安装：

```bash
npm install -g @vegamo/deepcode-cli
```

安装后检查版本：

```bash
deepcode --version
```

## 配置 DeepSeek-V4

Deep Code 推荐使用 `deepseek-v4-pro`，也支持 `deepseek-v4-flash`。创建 `~/.deepcode/settings.json`，写入你的 DeepSeek 模型配置：

```json
{
  "env": {
    "MODEL": "deepseek-v4-pro",
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

把 `API_KEY` 替换成你的 DeepSeek API Key。

常用字段：

| 字段 | 说明 |
| ---- | ---- |
| `env.MODEL` | DeepSeek 模型名称，推荐 `deepseek-v4-pro` |
| `env.BASE_URL` | DeepSeek API 地址，默认 `https://api.deepseek.com` |
| `env.API_KEY` | DeepSeek API Key |
| `thinkingEnabled` | 是否启用思考模式 |
| `reasoningEffort` | 推理强度，常用 `"high"` 或 `"max"` |

也可以在项目目录中创建 `.deepcode/settings.json`，为当前项目单独设置模型、权限或 MCP。

## 使用 Anthropic Claude

Deep Code 也支持 Anthropic Claude 原生 API。将 `provider` 设为 `"anthropic"`，并填入你的 Claude API Key：

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

常用字段：

| 字段 | 说明 |
| ---- | ---- |
| `provider` | LLM 提供商，设为 `"anthropic"` 启用 Claude |
| `model` | Claude 模型名称，如 `claude-sonnet-4-6` |
| `env.API_KEY` | Claude API Key，需以 `sk-ant-` 开头 |
| `env.BASE_URL` | Claude API 地址，默认 `https://api.anthropic.com` |
| `env.ANTHROPIC_BETA` | beta 特性列表，如 `extended-thinking,prompt-caching` |

> 如果 `model` 以 `claude-` 开头，即使不设 `provider` 也会自动推断为 `anthropic`。详见 [configuration.md](configuration.md#provider--llm-提供商)。

### 目录命名差异说明

Deep Code 存在两套并存的目录命名约定，请勿混淆：

- **`.deepcode/`**（无 x）：Deep Code CLI 主配置目录，存放 `settings.json`、`skills/`、`plugins/` 等
  - 用户级：`~/.deepcode/settings.json`
  - 项目级：`./.deepcode/settings.json`
- **`.deepcodex/`**（带 x）：Team 模块 autonomous 编排专用目录，存放 `autonomous.yml`、`runs/`、`notes.md`
  - 用户级：`~/.deepcodex/autonomous.yml`
  - 项目级：`./.deepcodex/autonomous.yml`、`./.deepcodex/runs/`、`./.deepcodex/notes.md`

更多 DeepSeek 官方配置说明可参考 [Deep Code 集成指南](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/deepcode)。

更多配置项请参考 [configuration.md](configuration.md)。

## 启动

进入你的项目目录：

```bash
cd path/to/your/project
deepcode
```

Deep Code 会在当前目录中启动交互式界面。你可以直接输入任务，然后按 `Enter` 发送。

如果想带着初始问题启动：

```bash
deepcode -p "总结这个项目"
```

## 第一次可以这样问

可以先从只读任务开始：

```text
总结这个仓库，并说明如何运行它。
```

```text
找出主要入口文件，并解释请求流程。
```

然后尝试让 Deep Code 修改代码：

```text
为登录校验逻辑添加一个单元测试。
```

```text
运行测试用例，并修复失败的测试。
```

也可以让它先给出计划：

```text
在修改文件前，先给出一个为用户列表添加分页的计划。
```

## 常用操作

| 操作 | 用法 |
| ---- | ---- |
| 发送消息 | `Enter` |
| 输入多行 | `Shift+Enter` 或 `Ctrl+J` |
| 中断当前回复 | `Esc` |
| 粘贴图片 | `Ctrl+V` |
| 退出 | 连续按两次 `Ctrl+D`，或使用 `/exit` |

## 斜杠命令

在输入框中输入 `/` 可以打开命令菜单。

| 命令 | 作用 |
| ---- | ---- |
| `/new` | 开始新对话 |
| `/resume` | 选择历史对话继续 |
| `/continue` | 继续当前对话，或恢复最近的对话 |
| `/model` | 切换模型、思考模式和推理强度 |
| `/init` | 为当前项目生成 `AGENTS.md` 指令文件 |
| `/skills` | 查看可用 Agent Skills |
| `/mcp` | 查看 MCP 服务状态和可用工具 |
| `/undo` | 将代码和/或对话恢复到之前的状态 |
| `/raw` | 切换显示模式 |
| `/exit` | 退出 Deep Code |

## 为项目添加说明

在项目中运行：

```text
/init
```

Deep Code 会帮助你创建 `AGENTS.md`。这个文件适合记录项目约定，例如：

- 项目如何安装依赖和运行测试
- 代码风格和提交要求
- 重要目录说明
- 修改代码前后需要执行的检查

之后 Deep Code 在该项目中工作时会自动参考这些说明。

## 使用 Skills

Agent Skills 适合保存可复用工作流，例如代码审查、发布检查、文档生成或某个框架的固定开发流程。

查看可用 skills：

```text
/skills
```

也可以输入 `/`，在菜单中选择某个 skill。

更多说明请参考 [agent-skills.md](agent-skills.md)。

## 连接外部工具

如果你想让 Deep Code 连接 GitHub、浏览器、数据库或其他服务，可以配置 MCP。

配置后，在 Deep Code 中运行：

```text
/mcp
```

即可查看已连接的 MCP 服务和可用工具。

更多说明请参考 [mcp.md](mcp.md)。

## 权限与安全

Deep Code 可能会读取文件、修改代码或运行命令。你可以通过权限配置控制哪些操作自动允许、哪些操作需要确认、哪些操作直接拒绝。

Deep Code 默认支持 YOLO 模式，可以更流畅地执行读写文件、运行命令等操作。如果你希望更谨慎，可以使用严格模式，让 Deep Code 在执行较高风险操作前询问你。

更多说明请参考 [permission.md](permission.md)。

## 任务完成通知

如果希望 Deep Code 完成任务后通知你，可以配置通知脚本，例如发送 Slack、飞书、系统通知或终端提示。

更多说明请参考 [notify.md](notify.md)。

## Team Autonomous（可选）

Deep Code CLI 内置 Team 模块，支持 Ralph 风格的 autonomous 自主编排模式（plan → dev → verify → fix 循环直到完成）。

### 启动 autonomous run

```bash
deepcodex team autonomous --goal "为登录逻辑添加单元测试" --max-iter 10
```

### autonomous 4 阶段流程

| 阶段    | 说明                                    |
| :------ | :-------------------------------------- |
| Plan    | 规划阶段：根据 goal 拆解任务，生成实施计划       |
| Dev     | 开发阶段：按计划执行实施，调用 LLM 完成代码变更   |
| Verify  | 验证阶段：运行测试或检查点，确认实施成果         |
| Fix     | 修复阶段：根据验证结果修复问题，进入下一轮迭代     |

LLM 在每个阶段输出时使用以下标题前缀作为 stage 识别契约：`# Plan 阶段` / `# Dev 阶段` / `# Verify 阶段` / `# Fix 阶段`。

### 配置与状态文件路径

| 路径                                  | 用途                              | 层级     |
| :------------------------------------ | :-------------------------------- | :------- |
| `~/.deepcode/settings.json`           | Deep Code 主配置（含 `env.API_KEY`） | 用户级   |
| `./.deepcode/settings.json`           | Deep Code 项目级配置                | 项目级   |
| `~/.deepcodex/autonomous.yml`         | autonomous 编排配置                 | 用户级   |
| `./.deepcodex/autonomous.yml`         | autonomous 编排配置                 | 项目级   |
| `./.deepcodex/runs/<runId>/state.json` | 单次运行状态持久化                  | 项目级   |
| `./.deepcodex/notes.md`               | 跨轮记忆（多个 run 共享）           | 项目级   |

启动前请确保 `~/.deepcode/settings.json` 的 `env.API_KEY` 字段已配置，否则 autonomous 模式会因缺少 API Key 直接退出。

支持通过 `--resume-run <runId>` 断点续跑历史 run。

## 下一步

- 阅读完整配置说明：[configuration.md](configuration.md)
- 配置权限策略：[permission.md](permission.md)
- 编写 Agent Skills：[agent-skills.md](agent-skills.md)
- 配置 MCP 外部工具：[mcp.md](mcp.md)
- 配置任务完成通知：[notify.md](notify.md)
