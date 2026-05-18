## UpdatePlan

Updates the current task plan and progress display.

Usage:
- Use this tool for non-trivial multi-step tasks when a task list helps track execution progress.
- Pass the complete current task list every time. The latest call replaces the previous visible plan.
- The `plan` argument is a markdown string, not an array of step objects.
- Keep exactly one task marked `[>]` while work is in progress.
- Update the plan before starting a task, immediately after completing a task, and whenever tasks are split, merged, reordered, blocked, or changed.
- Do not edit issue documents just to maintain task status; use `UpdatePlan` for the task list instead.

Task markers:
- `[ ]` Pending
- `[>]` In progress
- `[x]` Completed
- `[!]` Blocked

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "plan": {
      "description": "The complete markdown task list to display as the latest plan state.",
      "type": "string"
    },
    "explanation": {
      "description": "Optional short reason for changing the plan.",
      "type": "string"
    }
  },
  "required": [
    "plan"
  ],
  "additionalProperties": false
}
```
