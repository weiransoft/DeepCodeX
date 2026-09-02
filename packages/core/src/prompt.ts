import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ejs from "ejs";
import matter from "gray-matter";
import { fileURLToPath } from "url";
import type { SessionMessage } from "./session";
import { findGitBashPath, resolveShellPath } from "./common/shell-utils";
// 上游 v0.3.1：MultimodalMode 用于区分多模态能力级别（支持 ReadImage 或降级 UnderstandImage）
import { supportsMultimodal, type MultimodalMode } from "./common/model-capabilities";
// P1-T2（fork）：PureShowWidget 工具定义（条件注册，受 enabledSkills["dynamic-ui"] 控制）
import { pureShowWidgetToolDefinition } from "./visualization/widget-tool";

const COMPACT_PROMPT_BASE = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
7. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
8. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>`;

// fork 侧：保留中文详细系统提示词（含报告类工具验证优先约束、防编造 URL 等安全要求）。
// 上游 v0.3.1 将其简化为一句英文（DSH 对齐），但会丢失 fork 的防幻觉安全约束，
// 故此处保留 fork 版本；上游的提示词调整以 skill 工具 / <skill_content> 格式等形式并入。
const SYSTEM_PROMPT_BASE = `你是名叫Deep Code的交互式CLI工具，帮助用户完成软件工程任务。 Use the instructions below and the tools available to you to assist the user.

重要：严禁编造任何非编程相关的 URL。对于编程链接，仅限使用：1) 用户提供的上下文；2) 你确定的官方文档主域名。在输出前，必须自查该链接是否存在于你的上下文记忆中；若不存在，请明确说明无法提供。

## 报告类内容的工具验证优先约束（强制）

当用户请求生成代码审查、分析报告、评估、审计等报告类内容时，你必须严格遵守以下约束：

1. **工具验证优先**：报告中所有具体数字（错误数、文件数、行数、警告数等）必须通过 bash / read 等工具运行真实命令获取，严禁基于训练数据猜测。
   - TypeScript/JavaScript 项目：
     - 类型检查：必须运行 \`npm run typecheck\` 或 \`npx tsc --noEmit\` 获取真实错误数
     - Lint 检查：必须运行 \`npx eslint .\` 获取真实 warnings/errors 数
     - 格式化检查：必须运行 \`npx prettier --check .\` 获取真实未格式化文件数
   - Python 项目：
     - 类型检查：必须运行 \`mypy .\` 或 \`pyright\` 获取真实错误数
     - Lint 检查：必须运行 \`ruff check .\` 或 \`flake8 .\` 获取真实 warnings/errors 数
     - 格式化检查：必须运行 \`ruff format --check .\` 或 \`black --check .\` 获取真实未格式化文件数
   - Rust 项目：
     - 类型检查：必须运行 \`cargo check\` 获取真实错误数
     - Lint 检查：必须运行 \`cargo clippy\` 获取真实 warnings 数
     - 格式化检查：必须运行 \`cargo fmt --check\` 获取真实未格式化情况
   - Go 项目：
     - 类型检查：必须运行 \`go vet ./...\` 获取真实错误数
     - Lint 检查：必须运行 \`golangci-lint run\` 或 \`go vet ./...\` 获取真实 warnings 数
     - 格式化检查：必须运行 \`gofmt -l .\` 获取真实未格式化文件列表
   - 其他维度：必须运行对应的真实命令，不得凭印象补全

2. **三档置信度标注**：每个结论必须标注以下三档之一：
   - \`[已验证]\`：有真实命令输出作为证据
   - \`[未验证]\`：未运行命令验证，仅为推断
   - \`[不确定]\`：命令运行失败或结果不明确

3. **禁止编造**：无法验证的项目必须明确标注 \`[未验证]\`，不得编造具体数字。如果工具调用失败，必须如实说明失败原因。

4. **证据附注**：每个 \`[已验证]\` 的结论，必须在脚注或表格中附上对应的命令输出片段，便于读者复核。

5. **失败优先级**：工具调用失败时，不得用幻觉补全；应优先选择"明确报告失败"而非"提供看似合理的猜测数字"。
`;

// 合并说明：PromptToolOptions 按 v0.3.1 改为导出类型，并合并双方字段——
//   multimodal / nonInteractive 为上游新增；enabledSkills 为 fork 新增（PureShowWidget 条件注册）
export type PromptToolOptions = {
  model?: string;
  /** 上游 v0.3.1：多模态能力模式（auto/on/off），决定注册 ReadImage 还是 UnderstandImage */
  multimodal?: MultimodalMode;
  webSearchEnabled?: boolean;
  /** 上游 v0.3.1：非交互模式（如 exec/headless），移除 AskUserQuestion 工具与对应文档 */
  nonInteractive?: boolean;
  /**
   * fork 侧：已启用的 skill 映射表（与 settings.enabledSkills 同源）
   *
   * 用途：
   *   - 控制 dynamic-ui 等 skill 关联工具的注册（如 PureShowWidget）
   *   - 键为 skill 名称（如 "dynamic-ui"），值为 true/false
   *   - 未在表中出现的键视为默认启用（与 readDefaultSkillDocs 语义一致）
   *
   * 例如：
   *   { "dynamic-ui": false }  // 显式禁用 dynamic-ui，不注册 PureShowWidget 工具
   *   { }                       // 默认全部启用
   */
  enabledSkills?: Record<string, boolean>;
};

// fork 侧：默认 skill 提示选项（getDefaultSkillPrompt 使用）
type DefaultSkillPromptOptions = {
  enabledSkills?: Record<string, boolean>;
};

// fork 侧：默认 skill 模板列表：这些 skill 会通过 readDefaultSkillDocs() 自动注入到系统提示
// 影响所有用户的基础体验，新增/删除需谨慎评估（E6 增强方案）
// 导出说明（S5.2，2026-08-19）：导出供测试直接断言运行时导出面
// （default-skills.test.ts 测试组 3 原以读源码文本方式断言，属表面测试，已改为 import 常量断言）
export const DEFAULT_SKILL_TEMPLATES = [
  "karpathy-guidelines.md", // Karpathy 四大核心原则（代码质量基础）
  "design-aesthetics.md", // 设计美学原则（反 AI slop，视觉质量）
  "ui-ux-best-practices.md", // UI/UX 最佳实践（可访问性 + 交互质量）
  "code-quality-guidelines.md", // 代码质量指南（类型安全 + 错误处理 + 测试覆盖）
];
const DEFAULT_SKILL_RESOURCE_FILE_LIMIT = 50;
const SKILL_RESOURCE_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export type SkillPromptDocument = {
  name: string;
  content: string;
  path?: string;
  skillFilePath?: string;
};

type SkillResourceListing = {
  files: string[];
  truncated: boolean;
};

function readToolDocs(extensionRoot: string, options: PromptToolOptions = {}): string {
  const toolsDir = path.join(extensionRoot, "templates", "tools");
  if (!fs.existsSync(toolsDir)) {
    return "";
  }

  const entries = fs.readdirSync(toolsDir);
  const docs = entries
    .filter((entry) => entry.endsWith(".md") || entry.endsWith(".md.ejs"))
    // 上游 v0.3.1：非交互模式（exec/headless）下排除 ask-user-question 文档（无 UI 可承接提问）
    .filter((entry) => options.nonInteractive !== true || entry !== "ask-user-question.md")
    .sort()
    .map((entry) => {
      const fullPath = path.join(toolsDir, entry);
      try {
        const template = fs.readFileSync(fullPath, "utf8");
        const content = entry.endsWith(".ejs")
          ? // 上游 v0.3.1：multimodal 模式透传给模板（read.md.ejs 按 multimodal 分支渲染）
            ejs.render(template, { supportsMultimodal: supportsMultimodal(options.model ?? "", options.multimodal) })
          : template;
        return content.trim();
      } catch {
        return "";
      }
    })
    .filter((content) => content.length > 0);

  return docs.join("\n\n");
}

// fork 侧：默认 skill 文档读取（受 enabledSkills 过滤，禁用的 skill 不注入系统提示）
function readDefaultSkillDocs(
  extensionRoot: string,
  enabledSkills: Record<string, boolean> = {}
): Array<{ name: string; content: string }> {
  const skillsDir = path.join(extensionRoot, "templates", "skills");
  return DEFAULT_SKILL_TEMPLATES.map((entry) => {
    const fullPath = path.join(skillsDir, entry);
    const name = path.basename(entry, ".md");
    if (enabledSkills[name] === false) {
      return null;
    }
    try {
      return {
        name,
        content: fs.readFileSync(fullPath, "utf8").trim(),
      };
    } catch {
      return null;
    }
  }).filter((skill): skill is { name: string; content: string } => Boolean(skill?.content));
}

// fork 侧：构建默认 skill 提示（供外部按需注入系统提示）
export function getDefaultSkillPrompt(options: DefaultSkillPromptOptions = {}): string {
  const skillDocs = readDefaultSkillDocs(getExtensionRoot(), options.enabledSkills);
  if (skillDocs.length === 0) {
    return "";
  }

  return buildSkillDocumentsPrompt(skillDocs);
}

/** Read the dedicated prompt used when a submitted turn enters Plan Mode. */
export function getPlanModePrompt(): string {
  const templatePath = path.join(getExtensionRoot(), "templates", "prompts", "plan.md");
  try {
    return fs.readFileSync(templatePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function buildSkillDocumentsPrompt(skills: SkillPromptDocument[]): string {
  const blocks = skills.map((skill) => renderSkillDocumentBlock(skill));
  return `Use the skill documents below to assist the user:\n${blocks.join("\n\n")}`;
}

// 上游 v0.3.1 新增：skill 目录提示（配合 skill 工具与 session 层 skill catalog 使用，
// 引导 LLM 通过 skill 工具按名加载完整 skill 指令）
export function buildSkillCatalogPrompt(skills: Array<{ name: string; description: string }>): string {
  const entries = skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`).join("\n");
  return `A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
${entries}
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.`;
}

function renderSkillDocumentBlock(skill: SkillPromptDocument): string {
  const pathAttribute = skill.path ? ` path="${escapeXml(skill.path)}"` : "";
  const resources = renderSkillResources(skill.skillFilePath);
  const content = stripSkillPromptMetadata(skill.content);
  // 上游 v0.3.1：统一采用 <skill_content name="..."> 标签（与 skill 工具加载格式、DSH 对齐），
  // 替代 fork 旧版 <${skill.name}-skill> 标签
  return `<skill_content name="${skill.name}"${pathAttribute}>
${content}${resources}
</skill_content>`;
}

function stripSkillPromptMetadata(content: string): string {
  try {
    const parsed = matter(content);
    if (!Object.prototype.hasOwnProperty.call(parsed.data, "metadata")) {
      return content;
    }

    const frontmatter = { ...parsed.data };
    delete frontmatter.metadata;
    return matter.stringify(parsed.content, frontmatter);
  } catch {
    return content;
  }
}

function renderSkillResources(skillFilePath?: string): string {
  if (!skillFilePath) {
    return "";
  }

  const listing = listSkillResourceFiles(skillFilePath, DEFAULT_SKILL_RESOURCE_FILE_LIMIT);
  if (listing.files.length === 0 && !listing.truncated) {
    return "";
  }

  const fileLines = listing.files.map((file) => `  <file>${escapeXml(file)}</file>`);
  const noteLine = listing.truncated
    ? [`  <note>Listing capped at ${DEFAULT_SKILL_RESOURCE_FILE_LIMIT} files and may be incomplete.</note>`]
    : [];
  return `\n\n<skill_resources>\n${[...fileLines, ...noteLine].join("\n")}\n</skill_resources>`;
}

function listSkillResourceFiles(skillFilePath: string, limit: number): SkillResourceListing {
  const skillDir = path.dirname(skillFilePath);
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string, relativeDir = ""): void => {
    if (files.length > limit) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKILL_RESOURCE_EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        visit(fullPath, relativePath);
        if (truncated) {
          return;
        }
        continue;
      }

      if (!entry.isFile() || entry.name === "SKILL.md") {
        continue;
      }

      files.push(toPosixPath(relativePath));
      if (files.length > limit) {
        truncated = true;
        return;
      }
    }
  };

  visit(skillDir);
  return { files: files.slice(0, limit), truncated };
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getCurrentDateAndModelPrompt(model?: string): string {
  const date = new Date();
  let prompt = `今天是${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日。随着对话的进行，时间在流逝。`;
  prompt += model ? `\n当前LLM模型为${model}，对话中可通过/model命令切换模型。` : "";
  return prompt;
}

export function getSystemPrompt(_projectRoot: string, options: PromptToolOptions = {}): string {
  const toolDocs = readToolDocs(getExtensionRoot(), options);
  return toolDocs ? `${SYSTEM_PROMPT_BASE}\n\n# Available Tools\n\n${toolDocs}` : SYSTEM_PROMPT_BASE;
}

export function getCompactPrompt(sessionMessages: SessionMessage[]): string {
  const jsonl = sessionMessages
    .map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        contentParams: message.contentParams,
        messageParams: message.messageParams,
        createTime: message.createTime,
      })
    )
    .join("\n");
  return `${COMPACT_PROMPT_BASE}\n\nconversation below:\n\n\`\`\`jsonl\n${jsonl}\n\`\`\``;
}

export function getRuntimeContext(projectRoot: string, model?: string): string {
  const uname = getUnameInfo();
  const shellPath = getShellPathInfo();
  const shellModeOpts = process.platform === "win32" ? { "shell mode": "git-bash" } : {};
  const runtimeVersions = getRuntimeVersionInfo();
  const env = {
    "root path": projectRoot,
    pwd: projectRoot,
    homedir: os.homedir(),
    "system info": uname,
    "shell path": shellPath,
    ...shellModeOpts,
    ...runtimeVersions,
    "command installed": {
      ripgrep: checkToolInstalled("rg"),
      jq: checkToolInstalled("jq"),
    },
  };
  return `${getCurrentDateAndModelPrompt(model)}

# Local Workspace Environment

\`\`\`json
${JSON.stringify(env, null, 2)}
\`\`\``;
}

function checkToolInstalled(tool: string): boolean {
  try {
    if (process.platform === "win32") {
      const bashPath = findGitBashPath();
      execFileSync(bashPath, ["-lc", `command -v ${shellSingleQuote(tool)}`], {
        encoding: "utf8",
        stdio: "ignore",
        windowsHide: true,
      });
      return true;
    }
    execSync(`command -v ${tool}`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getShellPathInfo(): string {
  try {
    return resolveShellPath();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function getRuntimeVersionInfo(): Record<string, string> {
  const versions: Record<string, string> = {};
  const pythonVersion = getCommandVersion("python3", ["--version"]);
  const nodeVersion = getCommandVersion("node", ["--version"]);

  if (pythonVersion) {
    versions["python3 version"] = pythonVersion.replace(/^Python\s+/i, "");
  }
  if (nodeVersion) {
    versions["node version"] = nodeVersion;
  }

  return versions;
}

function getCommandVersion(command: string, args: string[]): string | null {
  try {
    const commandText = [command, ...args].map(shellSingleQuote).join(" ");
    if (process.platform === "win32") {
      return execFileSync(findGitBashPath(), ["-lc", `${commandText} 2>&1`], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    }
    return execSync(`${commandText} 2>&1`, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function getUnameInfo(): string {
  try {
    if (process.platform === "win32") {
      return execFileSync(findGitBashPath(), ["-lc", "uname -a"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    }
    return execSync("uname -a", { encoding: "utf8" }).trim();
  } catch {
    return `${os.type()} ${os.release()} ${os.arch()}`;
  }
}

export function getExtensionRoot(): string {
  // Prefer `__dirname` which is always available in the CJS bundle output.
  // Fall back to `import.meta.url` for ESM test environments (tsx --test).
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..");
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "..");
}

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

// 合并说明：保留 fork 的 options 参数名（非 _options）——fork 的 PureShowWidget
// 条件注册（options.enabledSkills）依赖该参数；上游的 nonInteractive/multimodal
// 判断同样通过 options 读取
export function getTools(options: PromptToolOptions = {}, externalTools: ToolDefinition[] = []): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Execute shell commands in a persistent bash session.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute",
            },
            description: {
              type: "string",
              description:
                'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.',
            },
            sideEffects: {
              description:
                'Permission scopes required by this bash command. Use [] only for commands that do not read, write, delete, or access the network. Use ["unknown"] when the effects cannot be classified safely.',
              type: "array",
              items: {
                type: "string",
                enum: [
                  "read-in-cwd",
                  "read-out-cwd",
                  "write-in-cwd",
                  "write-out-cwd",
                  "delete-in-cwd",
                  "delete-out-cwd",
                  "query-git-log",
                  "mutate-git-log",
                  "network",
                  "unknown",
                ],
              },
              uniqueItems: true,
            },
            run_in_background: {
              type: "boolean",
              description:
                "Set to true to run the command in the background. Use this only when you need to perform a blocking task and do not need the result immediately.",
            },
          },
          required: ["command", "sideEffects"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "AskUserQuestion",
        description:
          "When the task has ambiguities or multiple implementation approaches, use this tool to pause execution and ask the user a question to get clarification or make a decision.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              description: "Questions to present to the user. Usually only one question is needed at a time.",
              items: {
                type: "object",
                properties: {
                  question: {
                    type: "string",
                    description: "The question to ask the user.",
                  },
                  multiSelect: {
                    type: "boolean",
                    description: "Whether the user may choose multiple options.",
                  },
                  options: {
                    type: "array",
                    description: "A list of predefined options for the user to choose from.",
                    items: {
                      type: "object",
                      properties: {
                        label: {
                          type: "string",
                          description: "The display text for the option.",
                        },
                        description: {
                          type: "string",
                          description:
                            "A detailed explanation or hint about this option to help the user understand what happens if they choose it.",
                        },
                      },
                      required: ["label"],
                    },
                  },
                },
                required: ["question", "options"],
              },
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "UpdatePlan",
        description:
          "Update the current task plan. The plan argument must be the complete markdown task list to show as the latest progress state.",
        parameters: {
          type: "object",
          properties: {
            plan: {
              type: "string",
              description:
                "The complete markdown task list, including task status markers such as [ ], [>], [x], and optional notes.",
            },
            explanation: {
              type: "string",
              description: "Optional short reason for changing the plan.",
            },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        // 上游 v0.3.1 新增：skill 工具（按名加载 bundled/用户 skill 的完整指令）
        name: "skill",
        description:
          "Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The exact skill name from the available skills list.",
            },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        // fork 侧：read 保留图片加载能力（followUpMessages 多模态注入），描述保留 fork 版
        name: "read",
        description: "Read files from the filesystem (text, images, notebooks).",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "UNIX-style path to file",
            },
            offset: {
              type: "number",
              description: "Line number to start reading from",
            },
            limit: {
              type: "number",
              description: "Number of lines to read",
            },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: "Create files or overwrite them with a complete string payload. Prefer edit for existing files.",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute path to file",
            },
            content: {
              type: "string",
              description: "Complete file content as a single string. Serialize JSON documents before writing.",
            },
          },
          required: ["file_path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "Perform scoped string replacements in files.",
        parameters: {
          type: "object",
          properties: {
            snippet_id: {
              type: "string",
              description: "Required Read/Edit snippet_id.",
            },
            file_path: {
              type: "string",
              description: "Optional absolute path guard; must match snippet_id's file.",
            },
            old_string: {
              type: "string",
              description: "Exact text to replace inside snippet_id's scope",
            },
            new_string: {
              type: "string",
              description: "Replacement text (must differ from old_string)",
            },
            replace_all: {
              type: "boolean",
              description: "Replace all occurences of old_string (default false)",
              default: false,
            },
            expected_occurrences: {
              type: "number",
              description: "Expected number of matches, especially useful as a safety check with replace_all",
            },
          },
          required: ["snippet_id", "old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
  ];

  // 上游 v0.3.1：非交互模式（exec/headless）下移除 AskUserQuestion（无 UI 承接用户回答）
  if (options.nonInteractive === true) {
    const askUserQuestionIndex = tools.findIndex((tool) => tool.function.name === "AskUserQuestion");
    if (askUserQuestionIndex !== -1) {
      tools.splice(askUserQuestionIndex, 1);
    }
  }

  tools.push({
    type: "function",
    function: {
      name: "WebSearch",
      description: "Perform web searching using a natural language query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A search query phrased as a clear, specific natural language question or statement that includes key context.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  });

  // 上游 v0.3.1 新增：按多模态能力注册图片工具——
  //   模型支持多模态 → ReadImage（图片直接注入上下文）
  //   模型不支持多模态 → UnderstandImage（经独立 LLM 分析图片后返回文本）
  if (supportsMultimodal(options.model ?? "", options.multimodal)) {
    tools.push({
      type: "function",
      function: {
        name: "ReadImage",
        description:
          "Read a PNG, JPEG, WebP, or GIF file and return the image itself. Large images are validated and downscaled before the next model request.",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "The absolute path of the PNG, JPEG, WebP, or GIF image to read.",
            },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    });
  } else {
    tools.push({
      type: "function",
      function: {
        name: "UnderstandImage",
        description: "Analyze or extract information from a local JPEG, PNG, or WebP image.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "A clear instruction describing what to analyze or extract from the image.",
            },
            image_path: {
              type: "string",
              description: "The absolute path of the JPEG, PNG, or WebP image to analyze.",
            },
          },
          required: ["prompt", "image_path"],
          additionalProperties: false,
        },
      },
    });
  }

  // P1-T2（fork）：PureShowWidget 工具条件注册
  //
  // 启用条件：enabledSkills["dynamic-ui"] 未被显式设为 false（默认启用）
  // 禁用行为：当用户在 settings.enabledSkills 中将 "dynamic-ui" 设为 false 时，
  //           工具不在 tools 列表中注册，LLM 不会发起 pure_show_widget 调用
  //
  // 与 dynamic-ui skill 的关系：
  //   - 工具是 skill 的执行入口（skill 描述何时调用，工具执行渲染）
  //   - skill 文档加载由 getDefaultSkillPrompt() 控制（独立于工具注册）
  //   - 用户禁用 skill 后，工具与文档都应不出现（保证一致性）
  if (options.enabledSkills?.["dynamic-ui"] !== false) {
    tools.push(pureShowWidgetToolDefinition);
  }

  for (const tool of externalTools) {
    tools.push(tool);
  }

  return tools;
}
