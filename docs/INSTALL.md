# DeepCodeX CLI 安装手册

本手册说明如何安装、配置和验证 DeepCodeX CLI（命令行工具 `deepcode`）。

## 1. 环境要求

| 组件 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 22.x | 使用 `node --version` 检查；CLI 的 TUI 依赖 Node 22+ 的实验特性 |
| npm | 10.x | 通常随 Node.js 一起安装，建议使用 `npm --version` 确认 |
| Git | 2.20+ | 用于自主迭代模式（Ralph / full-lifecycle）的提交与回滚 |
| 操作系统 | macOS / Linux / WSL | Windows 原生环境建议通过 WSL2 运行 |

> 注意：部分可选能力（如 SQLite 持久化）依赖 `better-sqlite3`，需要本地 C++ 编译工具链；macOS 用户需安装 Xcode Command Line Tools。

## 2. 安装方式

### 2.1 npm 全局安装（推荐最终用户）

```bash
npm install -g @vegamo/deepcode-cli
```

安装完成后验证：

```bash
deepcode --version
```

### 2.2 源码构建（推荐开发者）

```bash
git clone https://github.com/lessweb/deepcode-cli.git
cd deepcode-cli
npm install
npm run build
```

构建产物位于 `packages/cli/dist/cli.js`。可以通过以下方式之一使用：

```bash
# 方式 A：直接调用 dist 产物
node packages/cli/dist/cli.js --version

# 方式 B：通过 npm link 创建全局命令
npm link -w packages/cli
deepcode --version
```

### 2.3 开发调试模式（global link）

在源码目录执行：

```bash
npm link -w packages/cli
```

这会把 `packages/cli` 链接到全局 npm 前缀的 `deepcode` 命令。后续修改源码后重新执行 `npm run build` 即可生效。

如需取消链接：

```bash
npm unlink -g @vegamo/deepcode-cli
```

## 3. LLM 配置

DeepCodeX CLI 需要至少一个 LLM Provider 才能工作。配置按优先级读取：

1. 命令行参数（如 `--api-key`）
2. 环境变量（`OPENAI_API_KEY`、`OPENAI_BASE_URL` 等）
3. 项目级配置：`./.deepcode/settings.json`
4. 用户级配置：`~/.deepcode/settings.json`

### 3.1 settings.json 示例

```json
{
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "thinkingEnabled": false,
  "reasoningEffort": "medium"
}
```

### 3.2 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 兼容 API Key |
| `OPENAI_BASE_URL` | 自定义 API 基础地址 |
| `DEEPCode_LOG_LEVEL` | 日志级别：`debug`、`info`、`warn`、`error` |
| `DEEPCode_LOG_DIR` | 日志输出目录，默认 `~/.deepcode/logs` |

## 4. 技能系统扫描路径

CLI 启动时会扫描以下路径加载技能（SKILL.md）：

| 路径 | 类型 |
|------|------|
| `~/.deepcode/skills/*/` | 用户级原生技能 |
| `~/.agents/skills/*/` | 用户级可互操作技能 |
| `./.deepcode/skills/*/` | 项目级原生技能 |
| `./.agents/skills/*/` | 项目级可互操作技能 |
| `~/.trae-cn/builtin_skills/` | 内置技能复用目录（TRAE-code-review / TRAE-security-review） |

## 5. 内置命令

安装完成后，可通过 `deepcode /help` 或在 TUI 中输入 `/` 查看全部命令。常用命令：

| 命令 | 说明 |
|------|------|
| `/team` | 自动分派任务到最匹配的多角色团队成员 |
| `/architect` / `/pm` / `/coder` / `/tester` / `/ui` | 强制分派到指定角色 |
| `/review` | 代码审查（支持 typecheck / lint / format / full 子命令） |
| `/quality-check` | 质量门禁（codemap / uiux / visual / all） |
| `/rules` | RLIS 规则管理 |
| `/memory` | 记忆管理 |
| `/bg` / `/tasks` / `/cancel` | 后台子任务管理 |
| `/exit` | 退出 CLI |

### 退出码约定

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 执行失败（如任务文件读取失败、LLM 调用失败） |
| 2 | 参数错误 / fatal abort（如缺少必填参数、连续失败超限） |
| 3 | 命中 `stop_when` 条件 |

## 6. 日志系统

默认日志目录：`~/.deepcode/logs`

- 主日志：`deepcode-YYYY-MM-DD.log`
- 调试日志：`debug-YYYY-MM-DD.log`（设置 `DEEPCode_LOG_LEVEL=debug` 开启）

查看最近日志：

```bash
tail -n 100 ~/.deepcode/logs/deepcode-$(date +%Y-%m-%d).log
```

## 7. 开发构建

```bash
# 类型检查
npm run typecheck

# 代码检查与格式化
npm run lint
npm run format

# 运行测试
npm test

# 构建 CLI 产物
npm run build

# 打包单文件 bundle
npm run bundle
```

## 8. 安装验证

执行以下命令验证安装是否完整：

```bash
deepcode --version
deepcode --help
deepcode team list
deepcode review help
```

如能正常输出版本号、帮助信息、角色列表和 review 帮助，则安装成功。

## 9. 常见问题

### Q1: `deepcode: command not found`

- 确认是否已全局安装或执行了 `npm link`
- 检查 npm 全局 bin 目录是否在 `PATH` 中：`npm bin -g`

### Q2: 启动 TUI 后无法连接 LLM

- 检查 `~/.deepcode/settings.json` 或 `./.deepcode/settings.json` 是否包含正确的 `apiKey` 和 `baseURL`
- 确认网络可以访问配置的 API 地址
- 查看 `~/.deepcode/logs/` 中的错误日志

### Q3: `better-sqlite3` 安装失败

- macOS：`xcode-select --install`
- Debian/Ubuntu：`sudo apt-get install build-essential`
- 该依赖为可选，失败不会阻塞 CLI 主流程

### Q4: 构建时报类型错误

- 确保 Node.js 版本 >= 22
- 删除 `node_modules` 和 `tsconfig.tsbuildinfo` 后重新安装：`npm run clean && npm install && npm run build`

## 10. 获取帮助

- GitHub Issues：`https://github.com/lessweb/deepcode-cli/issues`
- 文档首页：`docs/quickstart.md`
- 架构说明：`docs/architecture.md`
