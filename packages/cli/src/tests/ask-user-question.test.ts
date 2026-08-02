import { test } from "node:test";
import assert from "node:assert/strict";
// 注意：直接从源文件导入，绕过 ui/index.ts 的视图组件加载链。
// 原因：ui/index.ts 间接 re-export 了视图组件（如 ProcessStdoutView），后者以值导入
// @vegamo/deepcode-core 的 BASH_TIMEOUT_DECREMENT_MS，触发 dist/eag/tcs/index.js
// 加载不存在的 ./fixtures.js（构建产物 bug，dist 中 fixtures 是目录而非文件）。
// 直接从 ./core/ask-user-question 导入可避免触发该加载链，且 ask-user-question.ts
// 对 deepcode-core 仅持有 type-only import，编译时会被完全删除。
import {
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  formatAskUserQuestionDecline,
} from "../ui/core/ask-user-question";
import type { SessionMessage } from "@vegamo/deepcode-core";

function message(content: unknown): SessionMessage {
  const now = "2026-04-29T00:00:00.000Z";
  return {
    id: "tool-message",
    sessionId: "session-id",
    role: "tool",
    content: JSON.stringify(content),
    contentParams: null,
    messageParams: { tool_call_id: "call-id" },
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

test("findPendingAskUserQuestion returns latest pending AskUserQuestion tool message", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({ ok: true, name: "read" }),
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Which package manager should we use?",
              options: [{ label: "npm", description: "Use package-lock.json." }, { label: "yarn" }],
            },
          ],
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.messageId, "tool-message");
  assert.equal(pending?.questions[0]?.question, "Which package manager should we use?");
  assert.equal(pending?.questions[0]?.options[0]?.description, "Use package-lock.json.");
});

test("findPendingAskUserQuestion preserves multiple pending questions in order", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Use default description?",
              options: [{ label: "Yes" }, { label: "Custom" }],
            },
            {
              question: "Where should the project be created?",
              options: [{ label: "Current directory" }, { label: "Custom path" }],
            },
          ],
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.deepEqual(
    pending?.questions.map((question) => question.question),
    ["Use default description?", "Where should the project be created?"]
  );
});

test("findPendingAskUserQuestion ignores questions unless session waits for user", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Continue?", options: [{ label: "Yes" }] }],
        },
      }),
    ],
    "processing"
  );

  assert.equal(pending, null);
});

test("formatAskUserQuestionAnswers creates model-readable answer text", () => {
  assert.equal(
    formatAskUserQuestionAnswers({
      "Which package manager?": "yarn",
      "Any notes?": "Use the existing lockfile",
    }),
    'User has answered your questions: "Which package manager?"="yarn", "Any notes?"="Use the existing lockfile". You can now continue with the user\'s answers in mind.'
  );
});

test("formatAskUserQuestionDecline creates decline text", () => {
  assert.match(formatAskUserQuestionDecline(), /declined to answer/);
});

// ============================================================================
// TC-15 ~ TC-22：suggestedCommand 字段解析集成测试
//
// 测试目标：
// - 验证 findPendingAskUserQuestion 能正确解析 metadata.suggestedCommand
// - 验证格式错误时安全降级（不抛错，返回 undefined）
// - 验证白名单策略（与核心层 parseSuggestedCommand 对齐，拒绝 /exit 等会话控制命令）
// - 验证 suggestedCommand 不影响 questions 的正常解析
//
// 测试隔离：每个用例独立构造 message，复用现有 message() 辅助函数
// ============================================================================

// TC-15：metadata 含合法 suggestedCommand
// 期望：pending.suggestedCommand.command 正确保留，reason 字段也保留
test("TC-15: metadata 含合法 suggestedCommand 时 pending 应完整保留", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Which role should we dispatch?",
              options: [{ label: "architect" }, { label: "coder" }],
            },
          ],
          suggestedCommand: {
            command: "/team dispatch --role architect",
            reason: "基于用户回答自动派发架构师角色",
          },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.messageId, "tool-message");
  assert.equal(pending?.suggestedCommand?.command, "/team dispatch --role architect");
  assert.equal(pending?.suggestedCommand?.reason, "基于用户回答自动派发架构师角色");
});

// TC-16：metadata 不含 suggestedCommand
// 期望：pending.suggestedCommand === undefined（保持现状，向后兼容）
test("TC-16: metadata 不含 suggestedCommand 时 pending.suggestedCommand 应为 undefined", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Continue?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.messageId, "tool-message");
  assert.equal(pending?.suggestedCommand, undefined);
  // 同时验证 questions 仍能正常解析
  assert.equal(pending?.questions[0]?.question, "Continue?");
});

// TC-17：suggestedCommand 格式错误（command 非字符串）
// 期望：pending.suggestedCommand === undefined（降级安全，不抛错）
test("TC-17: suggestedCommand.command 为非字符串时应安全降级为 undefined", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Which framework?",
              options: [{ label: "React" }, { label: "Vue" }],
            },
          ],
          suggestedCommand: {
            command: 123,
            reason: "command 类型错误",
          },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
  // questions 仍能正常解析，不因 suggestedCommand 错误而失败
  assert.equal(pending?.questions[0]?.question, "Which framework?");
});

// TC-18：suggestedCommand 为非白名单命令 /exit
// 期望：pending.suggestedCommand === undefined（白名单拒绝会话控制类命令）
// 安全策略：与核心层 parseSuggestedCommand 白名单对齐，/exit 不在允许列表
test("TC-18: /exit 命令不在白名单时应被拒绝", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Confirm exit?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
          suggestedCommand: { command: "/exit" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-19：metadata.suggestedCommand 为 null
// 期望：pending.suggestedCommand === undefined（null 被视为非对象，降级）
test("TC-19: metadata.suggestedCommand 为 null 时应降级为 undefined", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Proceed?",
              options: [{ label: "Yes" }],
            },
          ],
          suggestedCommand: null,
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-20：command 不以 / 开头时降级
// 期望：pending.suggestedCommand === undefined（slash 前缀校验失败）
test("TC-20: command 不以 / 开头时应降级为 undefined", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Run command?",
              options: [{ label: "Yes" }],
            },
          ],
          suggestedCommand: { command: "team dispatch" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-21：command 为空白字符串时降级
// 期望：pending.suggestedCommand === undefined（trim 后长度为 0）
test("TC-21: command 为空白字符串时应降级为 undefined", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Proceed?",
              options: [{ label: "Yes" }],
            },
          ],
          suggestedCommand: { command: "   " },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-22：含 suggestedCommand 时仍能正常解析 questions
// 期望：pending.questions.length === 2 且 pending.suggestedCommand.command 正确
// 验证：suggestedCommand 字段的存在不影响 questions 的解析逻辑
test("TC-22: 含 suggestedCommand 时 questions 仍能正常解析（多问题场景）", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [
            {
              question: "Which role to dispatch?",
              options: [{ label: "architect" }, { label: "coder" }],
            },
            {
              question: "Which package manager?",
              options: [{ label: "npm" }, { label: "yarn" }],
            },
          ],
          suggestedCommand: {
            command: "/team dispatch --role architect",
            reason: "自动派发",
          },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.questions.length, 2);
  assert.deepEqual(
    pending?.questions.map((q) => q.question),
    ["Which role to dispatch?", "Which package manager?"]
  );
  assert.equal(pending?.suggestedCommand?.command, "/team dispatch --role architect");
  assert.equal(pending?.suggestedCommand?.reason, "自动派发");
});

// ============================================================================
// TC-23 ~ TC-27：CLI 层 suggestedCommand 参数沙箱校验
//
// 测试目标：
// - 验证 CLI 层 normalizeSuggestedCommand 对非法参数的降级行为
// - CLI 层无 projectRoot，因此任何绝对路径都应被拒绝
// - 验证 shell 元字符、路径穿越、~ 展开被拦截
//
// 安全策略：CLI 层作为核心层之后的第二道防线，无项目上下文时采取更严格的拒绝策略。
// ============================================================================

// TC-23：command 包含 shell 元字符
// 期望：pending.suggestedCommand === undefined
test("TC-23: CLI 层 suggestedCommand 包含 shell 元字符时应被拒绝", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          suggestedCommand: { command: "/team dispatch; cat /etc/passwd" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-24：--task-file 使用绝对路径
// 期望：pending.suggestedCommand === undefined（CLI 层无 projectRoot，拒绝所有绝对路径）
test("TC-24: CLI 层 --task-file 使用绝对路径时应被拒绝", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          suggestedCommand: { command: "/team dispatch --task-file /tmp/task.json" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-25：参数包含路径穿越 ".."
// 期望：pending.suggestedCommand === undefined
test("TC-25: CLI 层 suggestedCommand 参数包含 .. 时应被拒绝", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          suggestedCommand: { command: "/team dispatch --task-file ../package.json" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-26：参数包含 ~ home 目录展开
// 期望：pending.suggestedCommand === undefined
test("TC-26: CLI 层 suggestedCommand 参数包含 ~ 时应被拒绝", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          suggestedCommand: { command: "/team dispatch --task-file ~/.bashrc" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand, undefined);
});

// TC-27：合法相对路径参数
// 期望：pending.suggestedCommand 保留（CLI 层允许无 .. 的相对路径）
test("TC-27: CLI 层 suggestedCommand 使用合法相对路径时应被允许", () => {
  const pending = findPendingAskUserQuestion(
    [
      message({
        ok: true,
        name: "AskUserQuestion",
        awaitUserResponse: true,
        metadata: {
          kind: "ask_user_question",
          questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          suggestedCommand: { command: "/team dispatch --task-file docs/design.md" },
        },
      }),
    ],
    "waiting_for_user"
  );

  assert.equal(pending?.suggestedCommand?.command, "/team dispatch --task-file docs/design.md");
});
