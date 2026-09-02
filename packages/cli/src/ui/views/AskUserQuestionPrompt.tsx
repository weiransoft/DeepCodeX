import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import type { AskUserQuestionAnswers, AskUserQuestionItem, SuggestedCommand } from "../core/ask-user-question";
import { useTerminalInput, type InputKey } from "../hooks";

export type Props = {
  questions: AskUserQuestionItem[];
  /** 可选：用户回答后自动执行的建议命令 */
  suggestedCommand?: SuggestedCommand;
  /**
   * 用户完成所有问题（并确认/跳过了 suggestedCommand）后的回调。
   * @param answers 用户回答
   * @param allowSuggestedCommand 用户是否允许自动执行 suggestedCommand
   */
  onSubmit: (answers: AskUserQuestionAnswers, allowSuggestedCommand: boolean) => void;
  onCancel: () => void;
};

const OTHER_VALUE = "__other__";

/** 二次确认阶段的可选项 */
const CONFIRM_OPTIONS = [
  { label: "执行建议命令", value: "execute", allow: true },
  { label: "跳过，仅提交回答", value: "skip", allow: false },
];
type OptionEntry = {
  label: string;
  description?: string;
  value: string;
  isOther?: boolean;
};

/** 当前交互阶段 */
type Phase = "questions" | "confirm";

export function AskUserQuestionPrompt({
  questions,
  suggestedCommand,
  onSubmit,
  onCancel,
}: Props): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>("questions");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [answers, setAnswers] = useState<AskUserQuestionAnswers>({});
  const [selectedValues, setSelectedValues] = useState<Record<number, string[]>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const question = questions[questionIndex];
  const options = useMemo(() => buildOptions(question), [question]);
  const selectedForQuestion = selectedValues[questionIndex] ?? [];
  const otherText = otherTexts[questionIndex] ?? "";
  const isCurrentOther = options[cursorIndex]?.isOther === true;

  useEffect(() => {
    if (!statusMessage) {
      return;
    }
    const timer = setTimeout(() => setStatusMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    setPhase("questions");
    setQuestionIndex(0);
    setCursorIndex(0);
    setConfirmIndex(0);
    setAnswers({});
    setSelectedValues({});
    setOtherTexts({});
    setStatusMessage(null);
  }, [questions]);

  useEffect(() => {
    if (cursorIndex >= options.length) {
      setCursorIndex(Math.max(0, options.length - 1));
    }
  }, [cursorIndex, options.length]);

  useTerminalInput((input, key) => {
    // 全局取消/跳过快捷键
    if (key.escape) {
      if (phase === "confirm") {
        // 二次确认阶段：Esc 视为跳过建议命令，仍提交回答
        onSubmit(answers, false);
      } else {
        onCancel();
      }
      return;
    }

    if (key.ctrl && (input === "c" || input === "C")) {
      if (phase === "confirm") {
        // Ctrl+C 在确认阶段同样视为跳过建议命令
        onSubmit(answers, false);
      } else {
        onCancel();
      }
      return;
    }

    if (phase === "confirm") {
      handleConfirmInput(input, key);
      return;
    }

    if (!question) {
      return;
    }

    if (key.upArrow) {
      setCursorIndex((index) => Math.max(0, index - 1));
      return;
    }

    if (key.downArrow) {
      setCursorIndex((index) => Math.min(options.length - 1, index + 1));
      return;
    }

    if (key.backspace && isCurrentOther) {
      setOtherTexts((prev) => ({
        ...prev,
        [questionIndex]: (prev[questionIndex] ?? "").slice(0, -1),
      }));
      return;
    }

    if (key.return) {
      commitCurrentQuestion();
      return;
    }

    if (isCurrentOther && input && !key.ctrl && !key.meta && !input.startsWith("\u001B")) {
      const sanitized = input.replace(/\r/g, "");
      if (sanitized) {
        setOtherTexts((prev) => ({
          ...prev,
          [questionIndex]: `${prev[questionIndex] ?? ""}${sanitized}`,
        }));
      }
      return;
    }

    if (question.multiSelect && input === " " && !key.ctrl && !key.meta) {
      toggleCurrentOption();
      return;
    }

    if (question.multiSelect && input && /^[1-9]$/.test(input)) {
      const nextIndex = Number(input) - 1;
      if (nextIndex >= 0 && nextIndex < options.length) {
        toggleOption(options[nextIndex]?.value ?? "");
      }
    }
  });

  if (!question) {
    return null;
  }

  // suggestedCommand 二次确认阶段的键盘处理：↑/↓ 选择、Enter/Y 执行、N 跳过
  function handleConfirmInput(input: string, key: InputKey): void {
    if (key.upArrow) {
      setConfirmIndex((index) => Math.max(0, index - 1));
      return;
    }

    if (key.downArrow) {
      setConfirmIndex((index) => Math.min(CONFIRM_OPTIONS.length - 1, index + 1));
      return;
    }

    if (key.return) {
      submitConfirmation(CONFIRM_OPTIONS[confirmIndex]?.allow ?? false);
      return;
    }

    if (input === "y" || input === "Y") {
      submitConfirmation(true);
      return;
    }

    if (input === "n" || input === "N") {
      submitConfirmation(false);
      return;
    }
  }

  function submitConfirmation(allowSuggestedCommand: boolean): void {
    onSubmit(answers, allowSuggestedCommand);
  }

  function toggleCurrentOption(): void {
    const value = options[cursorIndex]?.value;
    if (value) {
      toggleOption(value);
    }
  }

  function toggleOption(value: string): void {
    setSelectedValues((prev) => {
      const current = prev[questionIndex] ?? [];
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
      return { ...prev, [questionIndex]: next };
    });
  }

  function commitCurrentQuestion(): void {
    const answer = buildAnswerForQuestion(question, options[cursorIndex], selectedForQuestion, otherText);
    if (!answer) {
      setStatusMessage(
        question.multiSelect
          ? "Select at least one option with Space, or type an Other answer."
          : "Select an option, or type an Other answer."
      );
      return;
    }

    const nextAnswers = {
      ...answers,
      [question.question]: answer,
    };
    setAnswers(nextAnswers);

    if (questionIndex >= questions.length - 1) {
      if (suggestedCommand) {
        // 进入 suggestedCommand 二次确认阶段，而不是立即提交
        setPhase("confirm");
        setConfirmIndex(0);
        return;
      }
      onSubmit(nextAnswers, false);
      return;
    }

    setQuestionIndex((index) => index + 1);
    setCursorIndex(0);
  }

  // 二次确认阶段 UI：展示 suggestedCommand 并让用户选择执行或跳过
  if (phase === "confirm" && suggestedCommand) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Box marginBottom={1}>
          <Text color="yellow" bold>
            Confirm suggested command
          </Text>
        </Box>
        {suggestedCommand.reason ? (
          <Box marginBottom={1}>
            <Text dimColor>{suggestedCommand.reason}</Text>
          </Box>
        ) : null}
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginY={1}>
          <Text color="cyan">{suggestedCommand.command}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {CONFIRM_OPTIONS.map((option, index) => {
            const isCursor = index === confirmIndex;
            return (
              <Text key={option.value} color={isCursor ? "cyanBright" : undefined}>
                {isCursor ? "> " : "  "}
                {option.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ move · Enter/Y execute · N/Esc skip</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="yellow" bold>
          Answer questions
        </Text>
        <Text dimColor>
          {" "}
          {questionIndex + 1}/{questions.length}
        </Text>
      </Box>
      <Text bold>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const isCursor = index === cursorIndex;
          const isSelected = option.isOther
            ? selectedForQuestion.includes(OTHER_VALUE) || Boolean(otherText.trim())
            : selectedForQuestion.includes(option.value) || answers[question.question] === option.label;
          const marker = question.multiSelect ? (isSelected ? "[x]" : "[ ]") : isSelected ? "●" : "○";
          return (
            <Box key={option.value} flexDirection="column">
              <Text color={isCursor ? "cyanBright" : undefined}>
                {isCursor ? "> " : "  "}
                {marker} <Text bold={isCursor}>{option.label}</Text>
              </Text>
              {option.isOther ? (
                <Box
                  marginLeft={4}
                  marginTop={0}
                  borderStyle="single"
                  borderColor={isCursor ? "cyanBright" : "gray"}
                  paddingX={1}
                  width={64}
                >
                  {otherText ? (
                    <Text color="white">
                      {otherText}
                      {isCursor ? <Text color="cyanBright">▌</Text> : null}
                    </Text>
                  ) : (
                    <Text dimColor>{isCursor ? "type your answer here" : "type a custom answer"}</Text>
                  )}
                </Box>
              ) : null}
              {option.description ? (
                <Box marginLeft={3}>
                  <Text dimColor> {option.description}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {statusMessage ??
            (isCurrentOther
              ? "Type your answer · Backspace edit · Enter submit/next · ↑ choose presets · Esc type manually"
              : question.multiSelect
                ? "↑/↓ move · Space toggle · Enter submit/next · Esc type manually"
                : "↑/↓ move · Enter select/next · Esc type manually")}
        </Text>
      </Box>
    </Box>
  );
}

function buildOptions(question: AskUserQuestionItem | undefined): OptionEntry[] {
  if (!question) {
    return [];
  }
  return [
    ...question.options.map((option) => ({
      label: option.label,
      description: option.description,
      value: option.label,
    })),
    {
      label: "Other",
      value: OTHER_VALUE,
      isOther: true,
    },
  ];
}

function buildAnswerForQuestion(
  question: AskUserQuestionItem,
  focusedOption: OptionEntry | undefined,
  selectedValues: string[],
  otherText: string
): string | null {
  const trimmedOther = otherText.trim();
  if (question.multiSelect) {
    const labels = selectedValues
      .filter((value) => value !== OTHER_VALUE)
      .map((value) => value.trim())
      .filter(Boolean);
    if (selectedValues.includes(OTHER_VALUE) && !trimmedOther) {
      return null;
    }
    if (trimmedOther) {
      labels.push(trimmedOther);
    }
    return labels.length > 0 ? labels.join(", ") : null;
  }

  if (!focusedOption) {
    return null;
  }
  if (focusedOption.isOther) {
    return trimmedOther || null;
  }
  return focusedOption.label;
}
