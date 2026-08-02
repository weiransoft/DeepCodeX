import { test } from "node:test";
import assert from "node:assert/strict";
// 注意：直接从源文件导入 Props 类型，避免通过 ui/index.ts 触发构建产物加载链。
// ask-user-question.ts 对 deepcode-core 仅持有 type-only import，编译时会被完全删除。
import type { Props } from "../ui/views/AskUserQuestionPrompt";
import type { AskUserQuestionAnswers, AskUserQuestionItem, SuggestedCommand } from "../ui/core/ask-user-question";

/**
 * 构造最小问题列表
 *
 * @returns 单问题、单选项的 AskUserQuestionItem 数组
 */
function sampleQuestions(): AskUserQuestionItem[] {
  return [{ question: "Confirm?", options: [{ label: "Yes" }, { label: "No" }] }];
}

/**
 * 构造合法 suggestedCommand
 *
 * @returns SuggestedCommand 对象
 */
function sampleSuggestedCommand(): SuggestedCommand {
  return {
    command: "/team dispatch --role architect",
    reason: "基于用户回答自动派发架构师角色",
  };
}

// ============================================================================
// TC-1：Props 类型接受 suggestedCommand 字段
// 期望：包含 suggestedCommand 的 props 对象通过 TypeScript 类型检查
// ============================================================================
test("TC-1: AskUserQuestionPrompt Props 接受 suggestedCommand 字段", () => {
  const submitted: Array<{ answers: AskUserQuestionAnswers; allow: boolean }> = [];
  const props: Props = {
    questions: sampleQuestions(),
    suggestedCommand: sampleSuggestedCommand(),
    onSubmit: (answers: AskUserQuestionAnswers, allowSuggestedCommand: boolean) => {
      submitted.push({ answers, allow: allowSuggestedCommand });
    },
    onCancel: () => {},
  };

  assert.equal(props.questions.length, 1);
  assert.equal(props.suggestedCommand?.command, "/team dispatch --role architect");
  assert.equal(typeof props.onSubmit, "function");

  // 验证回调签名：允许执行 suggestedCommand
  props.onSubmit({ Confirm: "Yes" }, true);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.allow, true);

  // 验证回调签名：跳过 suggestedCommand
  props.onSubmit({ Confirm: "No" }, false);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1]?.allow, false);
});

// ============================================================================
// TC-2：Props 类型允许 suggestedCommand 为空
// 期望：无 suggestedCommand 时 props 仍然合法
// ============================================================================
test("TC-2: AskUserQuestionPrompt Props 允许省略 suggestedCommand", () => {
  const props: Props = {
    questions: sampleQuestions(),
    onSubmit: (_answers: AskUserQuestionAnswers, _allowSuggestedCommand: boolean) => {},
    onCancel: () => {},
  };

  assert.equal(props.suggestedCommand, undefined);
  assert.equal(typeof props.onSubmit, "function");
});

// ============================================================================
// TC-3：onSubmit 回调第二参数为 boolean
// 期望：传入非布尔值时 TypeScript 应报错（运行时仅做类型断言）
// ============================================================================
test("TC-3: onSubmit 第二参数为 boolean 类型", () => {
  const calls: boolean[] = [];
  const props: Props = {
    questions: sampleQuestions(),
    onSubmit: (_answers: AskUserQuestionAnswers, allowSuggestedCommand: boolean) => {
      calls.push(allowSuggestedCommand);
    },
    onCancel: () => {},
  };

  props.onSubmit({}, false);
  assert.deepEqual(calls, [false]);
});
