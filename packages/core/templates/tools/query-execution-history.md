## Query Execution History

Query the execution history of tool runs (bash, write, edit, skill) in this project. Returns a structured list of past tool executions including command, result, exit code, cwd, and duration. Use this to find what commands were run recently, what worked or failed, or to locate a specific past execution by keyword. Results are ordered by time descending (newest first) by default.

### When to Use This Tool

- Need to know what build or test commands were run before
- Debugging a recurring failure — check what worked recently
- Recalling which scripts or npm tasks are available in this project
- Finding a specific past execution (e.g., "when was the last successful deployment?")

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | No | Filter by specific session ID. Omit for project-wide search. |
| `toolName` | string | No | Filter by tool name: `bash`, `write`, `edit`, `skill`, `AskUserQuestion`, etc. |
| `lastDays` | number | No | Only return records from the last N days. Default: all history. |
| `ok` | boolean | No | `true` = only successes, `false` = only failures. |
| `keyword` | string | No | Case-insensitive substring search across command args, output, and working directory. |
| `limit` | number | No | Max records to return (1–1000). Default: 50. |

### Example Calls

```json
// What bash commands ran in the last 7 days?
{ "toolName": "bash", "lastDays": 7, "limit": 20 }

// Show all failed executions in this project
{ "ok": false, "limit": 30 }

// Find any command related to "build"
{ "keyword": "build", "limit": 20 }

// Get recent history for a specific session
{ "sessionId": "session-abc123", "lastDays": 1 }
```

### Response Format

Returns JSON with:

- `totalCount`: Total matching records (before pagination)
- `returnedCount`: Records returned in this response
- `records`: Array of execution records, each containing:
  - `id`: Unique record identifier
  - `sessionId`: Session that ran this tool
  - `date`: ISO date (YYYY-MM-DD)
  - `toolName`: Tool that was executed
  - `ok`: Whether the execution succeeded
  - `exitCode`: Shell exit code (for bash)
  - `cwd`: Working directory (for bash)
  - `durationMs`: Execution time in milliseconds
  - `args`: Tool arguments (truncated)
  - `output`: Tool output (truncated)
  - `outputCount`: Number of files produced/modified (for write/edit)

### Notes

- History is **per-project**, stored locally in `~/.deepcode/projects/<project>/execution-history.jsonl`
- Records are retained for up to 100 days; the newest 500 records per session are kept
- This is a **read-only query** — it does not modify any data or run any commands
