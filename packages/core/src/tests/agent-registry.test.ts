/**
 * AgentRegistry 单元测试（T01）
 *
 * 测试覆盖（对应 T01 验收项）：
 *   ① 扫描根内合法 agent 定义被发现并列出（含来源根 displayPath）；
 *   ② type: skill 条目不进 agent 列表；
 *   ③ 非法 frontmatter（缺 description / name 非 kebab-case）→ 跳过 + 不中断其余扫描；
 *   ④ 同名覆盖优先级与 skill 一致（项目级覆盖用户级）；
 *   ⑤ buildAgentPrompt / buildAgentIndexPrompt：索引只含 name+role+description，无正文无绝对路径；
 *   ⑥ kebab-case 校验。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../agents/agent-registry";

// ============================================================================
// 测试 fixture
// ============================================================================

/** 写入一个 SKILL.md（frontmatter + 正文） */
function writeSkillMd(dir: string, name: string, frontmatter: string, body: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`, "utf8");
}

/** 创建测试用 AgentRegistry（HOME 指向临时目录后调用） */
function createRegistry(projectRoot: string): AgentRegistry {
  return new AgentRegistry({
    projectRoot,
    getResolvedSettings: () => ({}),
  });
}

/** 临时 home + project 环境搭建/清理（os.homedir 经 process.env.HOME 控制，POSIX 行为） */
function withTempEnv(fn: (home: string, project: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-project-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await fn(home, project);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  };
}

// ============================================================================
// 发现与列表
// ============================================================================

test(
  "listAgents 发现合法 agent 定义（含 role/body 与来源根）",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "code-reviewer",
      "name: code-reviewer\ndescription: 按团队规范评审代码改动\ntype: agent\nrole: 资深代码评审专家",
      "# 行为约束\n- 只评审，不直接改代码"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();

    assert.equal(agents.length, 1);
    const agent = agents[0];
    assert.ok(agent);
    assert.equal(agent.name, "code-reviewer");
    assert.equal(agent.kind, "agent");
    assert.equal(agent.role, "资深代码评审专家");
    assert.equal(agent.description, "按团队规范评审代码改动");
    // 来源根（displayPath 含 ~/.deepcode/skills 前缀，不含绝对路径）
    assert.ok(agent.path.startsWith("~/.deepcode/skills/"), `path 应含来源根：${agent.path}`);
    assert.ok(agent.body.includes("只评审，不直接改代码"), "body 应含 SKILL.md 正文");
  })
);

test(
  "listAgents role 缺省回退 description 首句",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(project, ".deepcode", "skills"),
      "test-runner",
      "name: test-runner\ndescription: 负责运行测试并汇报结果。必要时自动重试\ntype: agent",
      "# 正文"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.role, "负责运行测试并汇报结果");
  })
);

test(
  "listAgents 不返回 type: skill 的普通条目",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "plain-skill",
      "name: plain-skill\ndescription: 普通技能",
      "# 普通技能正文"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    assert.equal(agents.length, 0);
  })
);

test(
  "listAgents 同名覆盖优先级与 skill 一致：项目级覆盖用户级",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "shared-agent",
      "name: shared-agent\ndescription: 用户级版本\ntype: agent",
      "# 用户级正文"
    );
    writeSkillMd(
      path.join(project, ".deepcode", "skills"),
      "shared-agent",
      "name: shared-agent\ndescription: 项目级版本\ntype: agent",
      "# 项目级正文"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.description, "项目级版本");
    assert.ok(agents[0]?.body.includes("项目级正文"));
  })
);

// ============================================================================
// 非法定义校验（中文报错 + 不中断其余扫描）
// ============================================================================

test(
  "listAgents 缺 description 的 agent 被跳过且不影响其余扫描",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "no-desc-agent",
      "name: no-desc-agent\ntype: agent",
      "# 缺 description"
    );
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "valid-agent",
      "name: valid-agent\ndescription: 合法定义\ntype: agent",
      "# 合法正文"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.name, "valid-agent");
  })
);

test(
  "listAgents name 非 kebab-case 的 agent 被跳过",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "Bad_Agent",
      "name: Bad_Agent\ndescription: 非法名称\ntype: agent",
      "# 非法正文"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    assert.equal(agents.length, 0);
  })
);

test(
  "resolveAgent 未找到时返回 undefined（fail-safe）",
  withTempEnv(async (_home, project) => {
    const registry = createRegistry(project);
    const agent = await registry.resolveAgent("not-exist-agent");
    assert.equal(agent, undefined);
  })
);

// ============================================================================
// kebab-case 校验与 prompt 构建
// ============================================================================

test("isValidAgentName 只接受 kebab-case", () => {
  const registry = createRegistry("/tmp/agent-registry-unused");
  assert.equal(registry.isValidAgentName("code-reviewer"), true);
  assert.equal(registry.isValidAgentName("a1-b2"), true);
  assert.equal(registry.isValidAgentName("Code-Reviewer"), false);
  assert.equal(registry.isValidAgentName("code_reviewer"), false);
  assert.equal(registry.isValidAgentName("-code"), false);
  assert.equal(registry.isValidAgentName("code-"), false);
  assert.equal(registry.isValidAgentName(""), false);
});

test(
  "buildAgentPrompt 含正文与角色，buildAgentIndexPrompt 不含正文与绝对路径",
  withTempEnv(async (home, project) => {
    writeSkillMd(
      path.join(home, ".deepcode", "skills"),
      "doc-writer",
      "name: doc-writer\ndescription: 撰写技术文档\ntype: agent\nrole: 文档专家",
      "# 行为约束\n- 输出结构化中文文档"
    );

    const registry = createRegistry(project);
    const agents = await registry.listAgents();
    const agent = agents[0];
    assert.ok(agent);

    const prompt = registry.buildAgentPrompt(agent);
    assert.ok(prompt.includes("<agent_content"), "注入 prompt 应含 agent_content 标签");
    assert.ok(prompt.includes("文档专家"), "注入 prompt 应含 role");
    assert.ok(prompt.includes("输出结构化中文文档"), "注入 prompt 应含正文");

    const index = registry.buildAgentIndexPrompt(agents);
    assert.ok(index.includes("doc-writer"));
    assert.ok(index.includes("文档专家"));
    assert.ok(index.includes("撰写技术文档"));
    assert.ok(!index.includes("输出结构化中文文档"), "索引段不得含正文");
    assert.ok(!index.includes(home), "索引段不得暴露绝对路径");
    assert.equal(registry.buildAgentIndexPrompt([]), "", "空列表时索引段为空串");
  })
);
