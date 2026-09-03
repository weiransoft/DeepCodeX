import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  // 融合两侧：上游新增 buildSkillCatalogPrompt（skill 工具目录提示），fork 保留 getDefaultSkillPrompt（默认 skill 注入）
  buildSkillCatalogPrompt,
  buildSkillDocumentsPrompt,
  getDefaultSkillPrompt,
  getPlanModePrompt,
  getRuntimeContext,
  getSystemPrompt,
  getTools,
} from "../prompt";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("getTools always includes WebSearch", () => {
  const names = getTools().map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
});

// 上游 v0.3.1 新增用例：多模态能力驱动的图像工具切换
test("image tools match the current model's multimodal capability", () => {
  const nonMultimodalTools = getTools({ model: "deepseek-chat" }).map((tool) => tool.function.name);
  const multimodalTools = getTools({ model: "gpt-4o" }).map((tool) => tool.function.name);

  assert.equal(nonMultimodalTools.includes("UnderstandImage"), true);
  assert.equal(nonMultimodalTools.includes("ReadImage"), false);
  assert.equal(multimodalTools.includes("UnderstandImage"), false);
  assert.equal(multimodalTools.includes("ReadImage"), true);
  assert.equal(getSystemPrompt("/tmp/project", { model: "deepseek-chat" }).includes("## UnderstandImage"), true);
  assert.equal(getSystemPrompt("/tmp/project", { model: "deepseek-chat" }).includes("## ReadImage"), false);
  assert.equal(getSystemPrompt("/tmp/project", { model: "gpt-4o" }).includes("## UnderstandImage"), false);
  assert.equal(getSystemPrompt("/tmp/project", { model: "gpt-4o" }).includes("## ReadImage"), true);
});

test("multimodal config overrides model-based multimodal detection", () => {
  // "off" forces non-multimodal behavior even for a multimodal model.
  const forcedOffTools = getTools({ model: "gpt-4o", multimodal: "off" }).map((tool) => tool.function.name);
  assert.equal(forcedOffTools.includes("UnderstandImage"), true);
  assert.equal(forcedOffTools.includes("ReadImage"), false);
  assert.equal(
    getSystemPrompt("/tmp/project", { model: "gpt-4o", multimodal: "off" }).includes("## UnderstandImage"),
    true
  );

  // "on" forces multimodal behavior even for a non-multimodal model.
  const forcedOnTools = getTools({ model: "deepseek-chat", multimodal: "on" }).map((tool) => tool.function.name);
  assert.equal(forcedOnTools.includes("UnderstandImage"), false);
  assert.equal(forcedOnTools.includes("ReadImage"), true);
  assert.equal(
    getSystemPrompt("/tmp/project", { model: "deepseek-chat", multimodal: "on" }).includes("## UnderstandImage"),
    false
  );
});

test("interactive prompt and tools include AskUserQuestion", () => {
  assert.equal(getSystemPrompt("/tmp/project").includes("## AskUserQuestion"), true);
  assert.equal(
    getTools().some((tool) => tool.function.name === "AskUserQuestion"),
    true
  );
});

// suggestedCommand 优化（2026-09-03）：机制边界注入 + JSON schema 声明
test("AskUserQuestion tool docs include suggestedCommand mechanism boundary (强制)", () => {
  const prompt = getSystemPrompt("/tmp/project");
  // 工具文档必须包含方案中的"机制边界"段——反建议循环的强制规则
  assert.equal(prompt.includes("### 机制边界（强制，违反即产生建议循环）"), true);
  assert.equal(prompt.includes("该机制**永久失效**"), true);
  assert.equal(prompt.includes("直接完成该命令的等价工作"), true);
});

test("AskUserQuestion tool schema declares suggestedCommand property", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "AskUserQuestion");
  assert.ok(tool);
  const properties = tool.function.parameters.properties as Record<string, any>;
  // additionalProperties: false 下，schema 未声明的字段会被严格 provider 拒绝，
  // 因此 suggestedCommand 必须显式出现在 parameters.properties 中
  assert.ok(properties.suggestedCommand, "schema 必须声明 suggestedCommand 属性");
  const suggested = properties.suggestedCommand as any;
  assert.deepEqual(suggested.required, ["command"]);
  assert.equal(suggested.additionalProperties, false);
  // command 约束说明必须传达：必须以 / 开头 + 白名单语义
  const commandDesc = (suggested.properties?.command as any)?.description ?? "";
  assert.ok(commandDesc.includes("MUST start with '/'"), "command 描述需说明斜杠开头约束");
});

test("non-interactive prompt and tools exclude only AskUserQuestion", () => {
  const externalTool = {
    type: "function" as const,
    function: {
      name: "mcp_example",
      description: "MCP example",
      parameters: { type: "object" as const, properties: {} },
    },
  };
  const prompt = getSystemPrompt("/tmp/project", { nonInteractive: true });
  const names = getTools({ nonInteractive: true }, [externalTool]).map((tool) => tool.function.name);

  assert.equal(prompt.includes("## AskUserQuestion"), false);
  assert.equal(prompt.includes("## Bash"), true);
  assert.equal(names.includes("AskUserQuestion"), false);
  assert.equal(names.includes("bash"), true);
  assert.equal(names.includes("mcp_example"), true);
});

test("getTools includes UpdatePlan with string plan schema", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "UpdatePlan");
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ["plan"]);
  assert.equal((tool.function.parameters.properties.plan as { type?: unknown }).type, "string");
});

// 上游 v0.3.1 新增用例：skill 工具的精确 schema
test("getTools includes skill with the exact load-skill schema", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "skill");
  assert.ok(tool);
  assert.equal(
    tool.function.description,
    "Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill."
  );
  assert.deepEqual(tool.function.parameters.required, ["name"]);
  assert.equal((tool.function.parameters.properties.name as { type?: unknown }).type, "string");
  assert.equal(
    (tool.function.parameters.properties.name as { description?: unknown }).description,
    "The exact skill name from the available skills list."
  );
});

test("buildSkillCatalogPrompt renders previous and new preloaded skills", () => {
  const prompt = buildSkillCatalogPrompt([
    { name: "skill-writer", description: "Write a SKILL.md" },
    { name: "code-review", description: "Review code" },
  ]);

  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /- `skill-writer`: Write a SKILL\.md/);
  assert.match(prompt, /- `code-review`: Review code/);
  assert.match(prompt, /call the `skill` tool with the exact skill name/);
  assert.match(prompt, /A user may also invoke a skill directly/);
});

test("getTools requires bash sideEffects permission scopes", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "bash");
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ["command", "sideEffects"]);
  const sideEffects = tool.function.parameters.properties.sideEffects as {
    type?: unknown;
    items?: { enum?: unknown[] };
  };
  assert.equal(sideEffects.type, "array");
  assert.equal(sideEffects.items?.enum?.includes("write-out-cwd"), true);
  assert.equal(sideEffects.items?.enum?.includes("unknown"), true);
  const runInBackground = tool.function.parameters.properties.run_in_background as { type?: unknown };
  assert.equal(runInBackground.type, "boolean");
});

test("getTools does not expose the unused PDF pages parameter", () => {
  const tool = getTools().find((candidate) => candidate.function.name === "read");
  assert.ok(tool);
  assert.equal("pages" in tool.function.parameters.properties, false);
});

test("getSystemPrompt always includes WebSearch docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## WebSearch"), true);
});

test("getSystemPrompt includes UpdatePlan docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## UpdatePlan"), true);
  assert.equal(prompt.includes("The `plan` argument is a markdown string, not an array of step objects."), true);
});

test("getSystemPrompt includes Bash background guidance", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("run_in_background: true"), true);
  assert.equal(prompt.includes("do NOT add `&`"), true);
  assert.equal(prompt.includes("use the `stopCommand` returned in the tool result metadata"), true);
  assert.equal(prompt.includes("stop background tasks that has not reported a completed state"), true);
});

// fork 保留用例：A1 改进（2026-07-27）System Prompt 强化，要求报告类内容必须工具验证
test("getSystemPrompt includes tool-verification-first constraints for reports (A1)", () => {
  const prompt = getSystemPrompt("/tmp/project");
  // 必须包含工具验证优先约束段
  assert.equal(prompt.includes("报告类内容的工具验证优先约束"), true);
  // 必须包含三档置信度标注
  assert.equal(prompt.includes("[已验证]"), true);
  assert.equal(prompt.includes("[未验证]"), true);
  assert.equal(prompt.includes("[不确定]"), true);
  // 必须包含具体命令示例（typecheck / eslint / prettier）
  assert.equal(prompt.includes("npm run typecheck"), true);
  assert.equal(prompt.includes("npx eslint"), true);
  assert.equal(prompt.includes("npx prettier --check"), true);
  // 必须包含禁止编造约束
  assert.equal(prompt.includes("禁止编造"), true);
});

// F4 修复（2026-09-03）：系统提示词新增"命令执行纪律"，反建议循环
test("getSystemPrompt includes command execution discipline rules (F4)", () => {
  const prompt = getSystemPrompt("/tmp/project");
  // 必须包含命令执行纪律段
  assert.equal(prompt.includes("命令执行纪律（反建议循环，强制）"), true);
  // 三条规则齐全：任务指令即执行信号 / 斜杠命令不可代输 / "继续"的含义
  assert.equal(prompt.includes("任务指令即执行信号"), true);
  assert.equal(prompt.includes('严禁回复"建议执行 /xxx 命令"'), true);
  assert.equal(prompt.includes("斜杠命令不可代输"), true);
  assert.equal(prompt.includes("由你直接完成该任务"), true);
  // 与 F3 呼应的【执行要求】标记识别
  assert.equal(prompt.includes("【执行要求】"), true);
});

test("getSystemPrompt does not include runtime context", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("# Local Workspace Environment"), false);
  assert.equal(prompt.includes('"root path": "/tmp/project"'), false);
});

// fork 保留用例：默认 skill 文档注入（E6 增强共 4 个默认 skill）
// 行为矛盾裁定（合并后）：skill 文档标签统一为上游 v0.3.1 的 <skill_content name="..."> 格式，
// 替代 fork 旧版 <karpathy-guidelines-skill> 标签，断言随之更新
test("getDefaultSkillPrompt loads the default skill template", () => {
  const prompt = getDefaultSkillPrompt();

  assert.equal(prompt.includes('<skill_content name="karpathy-guidelines">'), true);
  assert.equal(prompt.includes("# Karpathy Guidelines"), true);
  assert.equal(prompt.includes("Use the skill documents below to assist the user:"), true);
  assert.equal(prompt.includes('path="templates/skills/'), false);
});

test("getDefaultSkillPrompt loads all four default skills", () => {
  const prompt = getDefaultSkillPrompt();

  // 验证 4 个默认 skill 全部加载（E6 增强：新增 3 个默认 skill；合并后标签为 <skill_content name="...">）
  assert.equal(prompt.includes('<skill_content name="karpathy-guidelines">'), true);
  assert.equal(prompt.includes('<skill_content name="design-aesthetics">'), true);
  assert.equal(prompt.includes('<skill_content name="ui-ux-best-practices">'), true);
  assert.equal(prompt.includes('<skill_content name="code-quality-guidelines">'), true);
});

test("getDefaultSkillPrompt skips disabled default skills", () => {
  // 禁用所有 4 个默认 skill 后应为空字符串
  const prompt = getDefaultSkillPrompt({
    enabledSkills: {
      "karpathy-guidelines": false,
      "design-aesthetics": false,
      "ui-ux-best-practices": false,
      "code-quality-guidelines": false,
    },
  });

  assert.equal(prompt, "");
});

test("getDefaultSkillPrompt can disable individual default skills", () => {
  // 仅禁用 karpathy-guidelines，其他 3 个仍应加载
  const prompt = getDefaultSkillPrompt({
    enabledSkills: { "karpathy-guidelines": false },
  });

  assert.equal(prompt.includes('<skill_content name="karpathy-guidelines">'), false);
  assert.equal(prompt.includes('<skill_content name="design-aesthetics">'), true);
  assert.equal(prompt.includes('<skill_content name="ui-ux-best-practices">'), true);
  assert.equal(prompt.includes('<skill_content name="code-quality-guidelines">'), true);
});

test("getPlanModePrompt loads the dedicated Plan Mode template", () => {
  const prompt = getPlanModePrompt();
  assert.equal(prompt.includes("# Plan Mode (Conversational)"), true);
  assert.equal(prompt.includes("<proposed_plan>"), true);
});

test("buildSkillDocumentsPrompt excludes SKILL.md frontmatter metadata", () => {
  const prompt = buildSkillDocumentsPrompt([
    {
      name: "example",
      content:
        "---\nname: example\ndescription: Example skill\nlicense: MIT\ncompatibility: Node.js\nallowed-tools: Read Bash\nmetadata:\n  author: test\n  allow-implicit-invocation: false\n---\n# Example Skill\n\nUse these instructions.\n",
    },
  ]);

  assert.equal(prompt.includes("name: example"), true);
  assert.equal(prompt.includes("description: Example skill"), true);
  assert.equal(prompt.includes("license: MIT"), true);
  assert.equal(prompt.includes("compatibility: Node.js"), true);
  assert.equal(prompt.includes("allowed-tools: Read Bash"), true);
  assert.equal(prompt.includes("# Example Skill"), true);
  assert.equal(prompt.includes("Use these instructions."), true);
  assert.equal(prompt.includes("metadata:"), false);
  assert.equal(prompt.includes("author: test"), false);
  assert.equal(prompt.includes("allow-implicit-invocation"), false);
});

test("buildSkillDocumentsPrompt lists skill resources", () => {
  const skillDir = createTempDir("deepcode-skill-resources-");
  fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "# PDF Skill\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "scripts", "extract.py"), "print('extract')\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "scripts", "merge.py"), "print('merge')\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "references", "pdf-spec-summary.md"), "# PDF Spec\n", "utf8");

  const prompt = buildSkillDocumentsPrompt([
    { name: "pdf", content: "# PDF Skill", path: skillPath, skillFilePath: skillPath },
  ]);

  // 上游 v0.3.1 统一采用 <skill_content name="..."> 标签格式（与 skill 工具加载格式、DSH 对齐）
  assert.equal(prompt.includes(`<skill_content name="pdf" path="${skillPath}">`), true);
  assert.equal(prompt.includes("<skill_resources>"), true);
  assert.equal(prompt.includes("<file>scripts/extract.py</file>"), true);
  assert.equal(prompt.includes("<file>scripts/merge.py</file>"), true);
  assert.equal(prompt.includes("<file>references/pdf-spec-summary.md</file>"), true);
  assert.equal(prompt.includes("<file>SKILL.md</file>"), false);
});

test("buildSkillDocumentsPrompt caps large skill resource listings", () => {
  const skillDir = createTempDir("deepcode-skill-resource-cap-");
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "# Large Skill\n", "utf8");
  for (let index = 0; index < 55; index += 1) {
    fs.writeFileSync(path.join(skillDir, `file-${String(index).padStart(2, "0")}.txt`), "resource\n", "utf8");
  }

  const prompt = buildSkillDocumentsPrompt([
    { name: "large", content: "# Large Skill", path: skillPath, skillFilePath: skillPath },
  ]);

  assert.equal((prompt.match(/<file>/g) ?? []).length, 50);
  assert.equal(prompt.includes("<file>file-49.txt</file>"), true);
  assert.equal(prompt.includes("<file>file-50.txt</file>"), false);
  assert.equal(prompt.includes("Listing capped at 50 files and may be incomplete."), true);
});

test("buildSkillDocumentsPrompt excludes hidden and generated skill resources", () => {
  const skillDir = createTempDir("deepcode-skill-resource-exclusions-");
  fs.mkdirSync(path.join(skillDir, ".hidden"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(skillDir, "dist"), { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, "# Clean Skill\n", "utf8");
  fs.writeFileSync(path.join(skillDir, ".secret.txt"), "hidden\n", "utf8");
  fs.writeFileSync(path.join(skillDir, ".hidden", "file.txt"), "hidden\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "node_modules", "pkg", "index.js"), "module.exports = {}\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "dist", "bundle.js"), "bundle\n", "utf8");
  fs.writeFileSync(path.join(skillDir, "README.md"), "# Resource\n", "utf8");

  const prompt = buildSkillDocumentsPrompt([
    { name: "clean", content: "# Clean Skill", path: skillPath, skillFilePath: skillPath },
  ]);

  assert.equal(prompt.includes("<file>README.md</file>"), true);
  assert.equal(prompt.includes(".secret.txt"), false);
  assert.equal(prompt.includes(".hidden/file.txt"), false);
  assert.equal(prompt.includes("node_modules/pkg/index.js"), false);
  assert.equal(prompt.includes("dist/bundle.js"), false);
});

test("getSystemPrompt does not include current date guidance", () => {
  const now = new Date();
  const expected = `今天是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。随着对话的进行，时间在流逝。`;
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes(expected), false);
});

test("getRuntimeContext includes current date and model guidance", () => {
  const now = new Date();
  const expectedDate = `今天是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日。随着对话的进行，时间在流逝。`;
  const prompt = getRuntimeContext("/tmp/project", "deepseek-v4-pro");
  assert.equal(prompt.includes(expectedDate), true);
  assert.equal(prompt.includes("当前LLM模型为deepseek-v4-pro，对话中可通过/model命令切换模型。"), true);
  assert.equal(prompt.includes("# Local Workspace Environment"), true);
  assert.equal(prompt.includes('"root path": "/tmp/project"'), true);
});

test("getSystemPrompt renders Read docs for non-multimodal models", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-chat" });
  // fork 保留断言：合并后的 read.md.ejs 非多模态分支使用 "the current model is not multimodal" 文案
  assert.equal(prompt.includes("the current model is not multimodal"), true);
  assert.equal(prompt.includes("the contents are presented visually"), false);
});

test("runtime prompt assets live under templates", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "web-search.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md.ejs")), true);
  // 融合两侧：fork 保留默认 skill 模板检查，上游新增 ReadImage 模板检查
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read-image.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "prompts", "init_command.md.ejs")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "skills", "karpathy-guidelines.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "templates", "tools", "read.md")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "tools")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "docs", "prompts")), false);
});
