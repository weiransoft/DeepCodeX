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

- Clarification questions whose answer determines which command to run (use ask_clarification instead)
- Questions where the next step depends on the specific answer text
