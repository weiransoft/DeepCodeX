# EAG Unattended Engine (/eag-autonomous)

## Overview

The EAG Unattended Engine (EAG-P5) is Deep Code's autonomous coding loop system. Without human intervention, it automatically executes the **plan → dev → verify → fix** four-stage loop until the task is complete or a termination condition is triggered.

Core capabilities:

- **4-stage loop**: plan task → write code → run tests → fix failures
- **6-layer 15-rule BLOCKER safety guardrails**: path prison, command blacklist, scope lock, evidence enforcement, credential allowlist, runtime constraints
- **Three-command full chain**: start, query status, circuit-breaker rollback
- **Cross-session resume**: RunState JSONL persistence + NotesMemory cross-round memory
- **eag/loop/ scheduler reuse**: the P5 loop reuses the generic LoopScheduler decision engine, unifying termination-condition semantics

---

## Command Reference

| Command | Purpose |
|---------|---------|
| [`/eag-autonomous`](#1-start-the-loop-eag-autonomous) | Start the unattended loop |
| [`/eag-autonomous-status`](#2-query-status-eag-autonomous-status) | Query run status |
| [`/eag-autonomous-stop`](#3-circuit-breaker-rollback-eag-autonomous-stop) | Circuit-break and roll back to the last all-green snapshot |

---

## 1. Start the Loop `/eag-autonomous`

### Command Format

```
/eag-autonomous --goal "<goal>" [--max-iterations N] [--confirmation smart] [--test-command "command"] [--stop-when "condition"] [--max-tokens N] [--test-timeout-sec N] [--consecutive-failure-abort N]
```

### Parameter Reference

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--goal` | Yes | — | User goal text, e.g. `"add refund feature to order service"`; supports single/double-quote wrapping |
| `--max-iterations` | No | `10` | Maximum iteration count, positive integer 1-1000 |
| `--confirmation` | No | `smart` | Confirmation mode: `smart` (smart tri-state) / `always-ask` (always ask) / `fail-closed` (close on failure) |
| `--test-command` | No | `npm test` | Test command string |
| `--stop-when` | No | empty | Deterministic stop condition, e.g. `"all tests passed"` |
| `--max-tokens` | No | `200000` | Maximum token budget, positive integer |
| `--test-timeout-sec` | No | `600` | Test timeout in seconds, positive integer |
| `--consecutive-failure-abort` | No | `3` | Consecutive failure abort threshold, positive integer |

### Usage Examples

Basic usage (all default parameters):

```
/eag-autonomous --goal "add refund feature to order service"
```

Custom iteration count and test command:

```
/eag-autonomous --goal "refactor user authentication module" --max-iterations 20 --test-command "npm run test:unit"
```

Set a deterministic stop condition and conservative confirmation mode:

```
/eag-autonomous --goal "fix all TypeScript compilation errors" --stop-when "all tests passed" --confirmation always-ask
```

### Execution Flow

1. **Parameter parsing**: extract goal and optional parameters from the command string
2. **Admission checks** (AU-1~6): plan approved, workspace isolated, confirmation gate online, environment credential scan, hard caps configured, circuit-breaker channel available
3. **Forbidden-scenario detection** (AU-N1~N5): hitting any one rejects startup
4. **Show confirmation card**: the loop starts after user confirmation
5. **4-stage loop**: plan → dev → verify → fix; each iteration runs these 4 stages
6. **Termination check**: decided by LoopScheduler (reuses the eag/loop/ scheduler layer)
7. **Output run-id**: for subsequent status/stop queries

---

## 2. Query Status `/eag-autonomous-status`

### Command Format

```
/eag-autonomous-status <run-id>
```

### Parameter Reference

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<run-id>` | Yes | The run ID returned by `/eag-autonomous` |

### Usage Examples

```
/eag-autonomous-status abc123-def456
```

### Output Content

- **Seven-segment status bar**: current iteration / stage / status / token usage / LLM call count / consecutive failure count / estimated remaining
- **Milestone list**: records of each round where all 4 stages were green
- **Blocker analysis report** (if any): blocking Loop / iteration / stage / reason / root-cause hypothesis / suggested solution
- **Token usage statistics**: used / budget / remaining

---

## 3. Circuit-Breaker Rollback `/eag-autonomous-stop`

### Command Format

```
/eag-autonomous-stop <run-id>
```

### Parameter Reference

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<run-id>` | Yes | The run ID returned by `/eag-autonomous` |

### Usage Examples

```
/eag-autonomous-stop abc123-def456
```

### Execution Behavior

1. Calls `LoopGuard.abort()` + `AutonomousOrchestrator.stop()`
2. Exits after the current round completes (waits up to 5 seconds)
3. GitDriver performs rolling rollback to the last all-green snapshot point
4. Outputs the rollback target tag + list of cleaned uncommitted changes

> Circuit-breaking is implemented via an abort flag file for cross-process stop: `<projectRoot>/.eag/p5/abort-flags/<runId>.abort`

---

## 4-Stage Loop

Each iteration runs the following 4 stages in sequence:

| Stage | StageHandler | Responsibility |
|-------|-------------|---------------|
| **plan** | PlanStageHandler | Fetch next task card from tasks.md + scope-lock pre-check + domain-expert matching + GuardCoordinator validation |
| **dev** | DevStageHandler | Path prison + credential allowlist + file-state inventory + ChangeDiff artifact generation |
| **verify** | VerifyStageHandler | Real test-command execution + test-output parsing (Jest/Mocha/node:test/generic) + evidence enforcement |
| **fix** | FixStageHandler | Failure-mode analysis (6 categories) + fix-suggestion generation + cleanup-intent permanently forbidden |

Stage artifact chain flow: plan produces taskCard → dev produces changeDiff → verify produces testResult → fix produces fixSuggestion → next round's plan.

---

## Termination Conditions

EAG-P5 reuses the LoopScheduler decision engine from eag/loop/ to uniformly manage termination conditions:

| Termination condition | Trigger | Final status |
|------------------------|---------|--------------|
| **stop-when hit** | verify passes + stop-when condition satisfied | `succeeded` |
| **Iteration limit reached** | iterIndex + 1 >= maxIterations | `failed` (set uniformly by step 6) |
| **Consecutive failure abort** | consecutiveFailures >= consecutiveFailureAbort | `aborted` (human_checkpoint takes priority) |
| **User circuit-break** | `/eag-autonomous-stop` | `aborted` |
| **Token budget exhausted** | totalTokensUsed >= maxTokens | `failed` |
| **Timeout circuit-break** | single-round timeout | `failed` |

> LoopScheduler maps `SchedulingDecision.action` to P5 status: `human_checkpoint` → `aborted`; `stop_failure` (non-max-iter) → `aborted`; `stop_success`/`continue`/`fix` → no status change (handled by the loop condition).

---

## Safety Guardrails

EAG-P5 has 6 layers and 15 BLOCKER safety guardrails built in, all fail-closed (deny by default):

| Layer | Guard | Rule | Description |
|-------|-------|------|-------------|
| G-A1 | EnvBoundaryGuard | Path prison | Forbid access to files outside the project root directory |
| G-A1 | EnvBoundaryGuard | Environment variable write-protection | Forbid modifying production environment variables |
| G-A1 | EnvBoundaryGuard | Production credentials unreachable | Forbid reading production credential files |
| G-A2 | DangerousCommandGuard | Blacklisted commands | Forbid dangerous commands like `rm -rf /`, `chmod 777` |
| G-A2 | DangerousCommandGuard | Recursive deletion | Forbid unbounded recursive deletion |
| G-A3 | ScopeLockGuard | Scope lock | Forbid modifying files not declared in tasks.md (out-of-scope returns ASK to escalate to human) |
| G-A3 | ScopeLockGuard | Cleanup intent permanently forbidden | Forbid delete operations with a "cleanup" intent |
| G-A4 | FakeCompletionGuard | Evidence enforcement | Must provide test-passing evidence before marking complete |
| G-A4 | FakeCompletionGuard | Fake-completion detection | Forbid forging test results |
| G-A5 | CredentialMisuseGuard | Credential allowlist | Only allow credentials in the allowlist |
| G-A5 | CredentialMisuseGuard | Pre-commit secret scan | Scan for key leakage before commit |
| G-A6 | RuntimeConstraintGuard | Iteration limit | Enforce maxIterations |
| G-A6 | RuntimeConstraintGuard | Timeout circuit-break | Auto circuit-break on single-round timeout |
| G-A6 | RuntimeConstraintGuard | Heartbeat MAJOR | Heartbeat loss triggers a MAJOR alert |
| G-A6 | RuntimeConstraintGuard | Cap freeze | After reaching the cap, config is frozen and cannot be modified |

---

## Persistence and Cross-Session Resume

### RunState JSONL Persistence

- **File location**: `<projectRoot>/.eag/p5/run-state/<runId>.jsonl`
- **Format**: one JSON object per line, with `localChecksum` / `cumulativeChecksum` SHA256 checksums
- **API**: `P5RunStateStore.initialize` / `save` / `load` / `verify` / `resume`

### NotesMemory Cross-Round Memory

- **File location**: `<projectRoot>/.eag/p5/notes-memory/<runId>.md`
- **Format**: appends a `## Iter <iterIndex> / multi-stage` section each iteration
- **Purpose**: passes context across iterations to avoid repeating mistakes

### better-sqlite3 Symbol Graph

- **File location**: `<projectRoot>/.eag/p5/symbol-graph.db`
- **Function**: symbol-level CALLS / INHERITS / IMPLEMENTS / TESTED_BY graph
- **SQLite is the single source of truth**; codemap.json degrades to a derived view

---

## Configuration

EAG-P5's runtime parameters are configured via command-line arguments (see [Parameter Reference](#parameter-reference)); no extra configuration file is needed.

Prerequisites:

1. **API Key configured**: the `env.API_KEY` field in `~/.deepcode/settings.json` is set (see [configuration.md](configuration.md))
2. **tasks.md prepared**: `<projectRoot>/.eag/p5/tasks.md` contains at least one task card with `status: pending`
3. **Clean Git workspace**: `git status` shows no uncommitted changes before starting (or use a worktree for isolation)

---

## Related Documents

- [configuration.md](configuration.md) — Deep Code configuration guide (including LLM provider configuration)
- [EAG-P5 Requirements](enterprise/EAG-P5-REQUIREMENTS.md) — Full requirements specification
- [EAG-P5 Architecture](enterprise/EAG-P5-ARCHITECTURE.md) — Technical architecture design
- [EAG-P5 Loop Integration Design](enterprise/EAG-P5-LOOP-INTEGRATION-DESIGN.md) — P5 reuse of eag/loop/ Plan A design
- [EAG-P5 End-to-End Capability Verification](enterprise/EAG-P5-E2E-CAPABILITY-VERIFICATION-DESIGN.md) — 52-test-case verification suite
