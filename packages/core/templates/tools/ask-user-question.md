## AskUserQuestion

Use this tool when you need to ask the user questions during execution. This allows you to:

1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:

- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

## Optional: suggestedCommand

When you intend to execute a slash command (e.g. `/team dispatch`, `/eag-build`)
after the user answers, provide `suggestedCommand` to enable auto-dispatch:

```json
{
  "questions": [...],
  "suggestedCommand": {
    "command": "/team dispatch --role architect --task \"整个代码库架构评审\"",
    "reason": "用户回答后自动分派给架构师角色"
  }
}
```

Rules:
- `command` MUST start with `/` (slash command)
- When `suggestedCommand` is provided, CLI auto-injects the command as the next user input
  immediately after the user answers, bypassing LLM's text-only response
- Use this when the user's answer confirms the task scope and you have a clear next command
- Do NOT use this for open-ended questions where the next step depends on nuanced interpretation

### When NOT to use suggestedCommand

- Clarification questions whose answer determines which command to run (use ask\_clarification instead)
- Questions where the next step depends on the specific answer text

### 机制边界（强制，违反即产生建议循环）

- `suggestedCommand` 只能附加在**本次 AskUserQuestion 调用**的参数里，随提问一起发出。
  它是唯一的命令自动执行通道。
- 一旦用户已经回答（下一条 user 消息就是答案），该机制**永久失效**：没有任何后置通道
  可以注入命令。此时若你仍输出"建议执行 /xxx 命令"，它只是一段无法被执行的死文字，
  用户看到后只会被迫再次打断你。
- 因此收到答案后的唯一正确动作是：**立即用你已有的工具（Bash/Read/Grep/Write 等）
  直接完成该命令的等价工作**。例如想执行 /review，就直接 git diff + 逐文件审查，
  而不是把 /review 推荐给用户。
