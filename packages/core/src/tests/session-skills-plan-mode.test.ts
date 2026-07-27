/**
 * SessionManager 技能扫描与 Plan Mode 测试套件
 *
 * 覆盖方法群：
 * - 技能扫描：marks skills loaded、lists skills by priority、bundled skills 优先级、
 *   project override bundled、resolves bundled prompts
 * - Plan Mode：persists Plan Mode transitions、excludes bundled plan skill、
 *   legacy sessions default Default mode
 * - 技能禁用与 opt-out：excludes disabled skills、keeps manual opt-out、
 *   excludes implicit opt-out from auto matching
 *
 * 共 10 个测试用例。
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "../session";
import {
  createSessionTestEnv,
  createTempDir,
  createSessionManager,
  createMockedClientSessionManager,
  createMockedClientSessionManagerWithClient,
  createChatResponse,
  createSkillMatchingResponse,
  isSkillMatchingRequest,
  countLoadedSkillMessages,
  PLAN_MODE_ON_STATUS_MESSAGE,
  PLAN_MODE_OFF_STATUS_MESSAGE,
} from "./fixtures/session-test-env";
import { getProjectCode } from "../session";

// 每个测试文件持有独立的 env 实例，避免跨文件全局状态污染
const env = createSessionTestEnv();

afterEach(() => {
  env.cleanup();
});

test("SessionManager marks skills loaded from existing session messages", async () => {
  const workspace = createTempDir(env, "deepcode-loaded-skills-workspace-");
  const home = createTempDir(env, "deepcode-loaded-skills-home-");
  env.setHomeDir(home);

  const skillDir = path.join(home, ".agents", "skills", "lessweb-starter");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: lessweb-starter\ndescription: Create Lessweb projects\n---\n# Lessweb Starter\n",
    "utf8"
  );

  const projectCode = getProjectCode(workspace);
  const projectDir = path.join(home, ".deepcode", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "loaded-session.jsonl"),
    `${JSON.stringify({
      id: "skill-message",
      sessionId: "loaded-session",
      role: "system",
      content: "Use the skill document below",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
      meta: {
        skill: {
          name: "lessweb-starter",
          path: "~/.agents/skills/lessweb-starter/SKILL.md",
          description: "Create Lessweb projects",
          isLoaded: true,
        },
      },
    })}\n`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-loaded-skills");
  const loadedSkill = (await manager.listSkills("loaded-session")).find((skill) => skill.name === "lessweb-starter");

  assert.equal(loadedSkill?.isLoaded, true);
});

test("SessionManager lists skills from Deep Code and .agents roots by priority", async () => {
  const workspace = createTempDir(env, "deepcode-project-skills-workspace-");
  const home = createTempDir(env, "deepcode-project-skills-home-");
  env.setHomeDir(home);

  const userSkillDir = path.join(home, ".agents", "skills", "shared");
  fs.mkdirSync(userSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: User-level skill\n---\n# Shared\n",
    "utf8"
  );

  const userNativeSkillDir = path.join(home, ".deepcode", "skills", "native-user");
  fs.mkdirSync(userNativeSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userNativeSkillDir, "SKILL.md"),
    "---\nname: native-user\ndescription: User .deepcode skill\n---\n# Native User\n",
    "utf8"
  );

  const userNativeSharedSkillDir = path.join(home, ".deepcode", "skills", "shared");
  fs.mkdirSync(userNativeSharedSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(userNativeSharedSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: User .deepcode skill\n---\n# Shared\n",
    "utf8"
  );

  const projectAgentsSkillDir = path.join(workspace, ".agents", "skills", "shared");
  fs.mkdirSync(projectAgentsSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectAgentsSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Project .agents skill\n---\n# Shared\n",
    "utf8"
  );

  const projectNativeSkillDir = path.join(workspace, ".deepcode", "skills", "shared");
  fs.mkdirSync(projectNativeSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectNativeSkillDir, "SKILL.md"),
    "---\nname: shared\ndescription: Project .deepcode skill\n---\n# Shared\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-project-skills");
  const skills = await manager.listSkills();
  const nativeUserSkill = skills.find((skill) => skill.name === "native-user");
  const sharedSkill = skills.find((skill) => skill.name === "shared");

  assert.equal(nativeUserSkill?.path, "~/.deepcode/skills/native-user/SKILL.md");
  assert.equal(nativeUserSkill?.description, "User .deepcode skill");
  assert.equal(sharedSkill?.path, "./.deepcode/skills/shared/SKILL.md");
  assert.equal(sharedSkill?.description, "Project .deepcode skill");
});

test("SessionManager lists bundled skills at lowest priority", async () => {
  const workspace = createTempDir(env, "deepcode-bundled-skills-workspace-");
  const home = createTempDir(env, "deepcode-bundled-skills-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-bundled-skills");
  const skills = await manager.listSkills();
  const skillWriter = skills.find((skill) => skill.name === "skill-writer");
  const selfRefer = skills.find((skill) => skill.name === "deepcode-self-refer");

  assert.equal(skillWriter?.path, "bundled:skill-writer/SKILL.md");
  assert.equal(selfRefer?.path, "bundled:deepcode-self-refer/SKILL.md");
  assert.match(skillWriter?.description ?? "", /Guide users through creating/);
});

test("SessionManager lets project skills override bundled skills", async () => {
  const workspace = createTempDir(env, "deepcode-bundled-override-workspace-");
  const home = createTempDir(env, "deepcode-bundled-override-home-");
  env.setHomeDir(home);

  const projectSkillDir = path.join(workspace, ".deepcode", "skills", "skill-writer");
  fs.mkdirSync(projectSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkillDir, "SKILL.md"),
    "---\nname: skill-writer\ndescription: Project override skill writer\n---\n# Project Skill Writer\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-bundled-override");
  const skillWriter = (await manager.listSkills()).find((skill) => skill.name === "skill-writer");

  assert.equal(skillWriter?.path, "./.deepcode/skills/skill-writer/SKILL.md");
  assert.equal(skillWriter?.description, "Project override skill writer");
});

test("SessionManager resolves bundled skill prompts", () => {
  const workspace = createTempDir(env, "deepcode-bundled-prompt-workspace-");
  const home = createTempDir(env, "deepcode-bundled-prompt-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-bundled-prompt");
  const prompt = (manager as any).buildSkillPrompt({
    name: "skill-writer",
    path: "bundled:skill-writer/SKILL.md",
    description: "Write skills",
  });

  assert.match(prompt, /<skill-writer-skill/);
  assert.match(prompt, /# Skill Writer/);
});

test("SessionManager persists Plan Mode and appends prompts only on mode transitions", async () => {
  const workspace = createTempDir(env, "deepcode-plan-matched-workspace-");
  const home = createTempDir(env, "deepcode-plan-matched-home-");
  env.setHomeDir(home);

  const manager = createMockedClientSessionManager(workspace, [
    createChatResponse("planned", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("still planning", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    createChatResponse("implementing", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
  ]);
  const sessionId = await manager.createSession({ text: "Plan this change", planMode: true });
  let messages = manager.listSessionMessages(sessionId);
  assert.equal(manager.getSession(sessionId)?.planMode, true);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_ON_STATUS_MESSAGE).length, 1);
  assert.equal(
    messages.some((message) => message.content?.includes("# Plan Mode (Conversational)")),
    true
  );
  assert.equal(messages.find((message) => message.role === "user")?.meta?.userPrompt?.planMode, true);

  await manager.replySession(sessionId, { text: "Refine it", planMode: true });
  messages = manager.listSessionMessages(sessionId);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_ON_STATUS_MESSAGE).length, 1);

  await manager.replySession(sessionId, { text: "Implement it", planMode: false });
  messages = manager.listSessionMessages(sessionId);
  assert.equal(manager.getSession(sessionId)?.planMode, false);
  assert.equal(messages.filter((message) => message.content === PLAN_MODE_OFF_STATUS_MESSAGE).length, 1);
});

test("SessionManager excludes the former bundled plan skill and defaults legacy sessions to Default mode", async () => {
  const workspace = createTempDir(env, "deepcode-plan-legacy-workspace-");
  const home = createTempDir(env, "deepcode-plan-legacy-home-");
  env.setHomeDir(home);

  const manager = createSessionManager(workspace, "machine-id-plan-legacy");
  assert.equal(
    (await manager.listSkills()).some((skill) => skill.name === "plan"),
    false
  );

  const sessionId = await manager.createSession({ text: "Default mode" });
  const index = (manager as any).loadSessionsIndex();
  delete index.entries.find((entry: { id: string }) => entry.id === sessionId).planMode;
  (manager as any).saveSessionsIndex(index);
  assert.equal(manager.getSession(sessionId)?.planMode, false);

  const autoMatchManager = createMockedClientSessionManagerWithClient(workspace, {
    chat: {
      completions: {
        create: async (request: any) =>
          isSkillMatchingRequest(request)
            ? createSkillMatchingResponse(["plan"])
            : createChatResponse("default reply", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      },
    },
  });
  const autoMatchSessionId = await autoMatchManager.createSession({ text: "Plan this feature" });
  const autoMatchMessages = autoMatchManager.listSessionMessages(autoMatchSessionId);
  assert.equal(
    autoMatchMessages.some((message) => message.meta?.skill?.name === "plan"),
    false
  );
});

test("SessionManager excludes disabled skills by resolved skill name", async () => {
  const workspace = createTempDir(env, "deepcode-disabled-skills-workspace-");
  const home = createTempDir(env, "deepcode-disabled-skills-home-");
  env.setHomeDir(home);

  const writeSkill = (root: string, dirName: string, skillName: string): void => {
    const skillDir = path.join(root, dirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: ${skillName} description\n---\n# ${skillName}\n`,
      "utf8"
    );
  };

  for (const root of [
    path.join(workspace, ".deepcode", "skills"),
    path.join(workspace, ".agents", "skills"),
    path.join(home, ".deepcode", "skills"),
    path.join(home, ".agents", "skills"),
  ]) {
    writeSkill(root, "skill-writer", "skill-writer");
  }
  writeSkill(path.join(workspace, ".deepcode", "skills"), "frontmatter-disabled", "renamed-disabled");
  writeSkill(path.join(workspace, ".deepcode", "skills"), "enabled-skill", "enabled-skill");

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      machineId: "machine-id-disabled-skills",
    }),
    getResolvedSettings: () => ({
      model: "test-model",
      enabledSkills: {
        "skill-writer": false,
        "renamed-disabled": false,
        "deepcode-self-refer": false,
        "skill-digester": false,
        plan: false,
        // 批次 2 新增的 6 个 EAK 模式 Skill 包——本测试只验证 enabled-skill 的发现，
        // 新增的 bundled skill 必须显式禁用以保持测试范围隔离
        "eag-domain-modeling": false,
        "eag-aggregate-design": false,
        "eag-cqrs-separation": false,
        "eag-saga-orchestration": false,
        "eag-acl": false,
        "eag-verify-enterprise": false,
        // Builtin Skills 增强方案（v1.4）新增的 4 个 bundled skill
        // 同样需显式禁用以保持测试范围隔离
        "web-dev": false,
        "web-artisan": false,
        "code-mode-orchestrator": false,
        "browser-automation": false,
        // Builtin Skills 增强方案（v1.5）P1+P2 阶段新增的 7 个 bundled skill
        // P1: dynamic-ui / html-deck / html-report
        // P2: docx / pdf / pptx / xlsx
        // 同样需显式禁用以保持测试范围隔离
        "dynamic-ui": false,
        "html-deck": false,
        "html-report": false,
        docx: false,
        pdf: false,
        pptx: false,
        xlsx: false,
        "enabled-skill": true,
      },
    }),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
  });

  const skills = await manager.listSkills();
  const skillNames = skills.map((skill) => skill.name);

  assert.deepEqual(skillNames, ["enabled-skill"]);
  assert.equal(skills[0]?.path, "./.deepcode/skills/enabled-skill/SKILL.md");
});

test("SessionManager keeps implicit opt-out skills available for manual invocation", async () => {
  const workspace = createTempDir(env, "deepcode-manual-only-skill-workspace-");
  const home = createTempDir(env, "deepcode-manual-only-skill-home-");
  env.setHomeDir(home);

  const skillDir = path.join(workspace, ".agents", "skills", "manual-only");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: manual-only\ndescription: Manual-only skill\nmetadata:\n  allow-implicit-invocation: false\n---\n# Manual Only\n",
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-manual-only-skill");
  const skill = (await manager.listSkills()).find((candidate) => candidate.name === "manual-only");
  assert.ok(skill);
  assert.equal(skill.allowImplicitInvocation, false);

  const sessionId = await manager.createSession({ text: "", skills: [skill] });
  const skillMessages = manager
    .listSessionMessages(sessionId)
    .filter((message) => message.role === "system" && message.meta?.skill?.name === "manual-only");

  assert.equal(skillMessages.length, 1);
  assert.match(skillMessages[0]?.content ?? "", /<manual-only-skill/);
  assert.doesNotMatch(skillMessages[0]?.content ?? "", /allow-implicit-invocation/);
});

test("SessionManager excludes implicit opt-out skills from automatic matching candidates", async () => {
  const workspace = createTempDir(env, "deepcode-implicit-opt-out-workspace-");
  const home = createTempDir(env, "deepcode-implicit-opt-out-home-");
  env.setHomeDir(home);
  globalThis.fetch = (async () => ({ ok: true, text: async () => "" }) as Response) as typeof fetch;

  const writeSkill = (name: string, metadata = ""): void => {
    const skillDir = path.join(workspace, ".deepcode", "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} description${metadata}\n---\n# ${name}\n`,
      "utf8"
    );
  };
  writeSkill("auto-skill");
  writeSkill("manual-only", "\nmetadata:\n  allow-implicit-invocation: false");

  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          if (isSkillMatchingRequest(request)) {
            return createSkillMatchingResponse(["manual-only", "auto-skill"]);
          }
          return createChatResponse("done", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        },
      },
    },
  };
  const manager = createMockedClientSessionManagerWithClient(workspace, client);
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "choose an automatic skill" });
  const matchingPrompt = String(requests[0]?.messages?.[0]?.content ?? "");

  assert.match(matchingPrompt, /"name": "auto-skill"/);
  assert.doesNotMatch(matchingPrompt, /"name": "manual-only"/);
  assert.equal(countLoadedSkillMessages(manager.listSessionMessages(sessionId), "auto-skill"), 1);
  assert.equal(countLoadedSkillMessages(manager.listSessionMessages(sessionId), "manual-only"), 0);
});
