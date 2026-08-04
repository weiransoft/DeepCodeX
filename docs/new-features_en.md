# DeepCodeX New Features Overview

> **Version**: v1.1
> **Date**: 2026-07-26 (v1.0); 2026-08-04 (v1.1 doc-vs-code consistency revision)
> **Status**: ✅ Implemented (exceptions: F.4 background-task persistence and C.4 `.deepcode/eag.yml` file loading are planned but not wired — see the notes in those sections)
> **Related Documents** (`docs/fusion/` contains local design docs that are not committed; links work only on this machine):
> - Fusion Plan: [docs/fusion/DEEPCODEX_FUSION_PLAN.md](fusion/DEEPCODEX_FUSION_PLAN.md)
> - V2 Context Memory: [docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md)
> - EAG Usage Guide: [docs/eag-autonomous_en.md](eag-autonomous_en.md)
> - Historical review records (archived): [docs/archive/](archive/)
>
> **v1.1 Revision Notes (2026-08-04)**: After a role-by-role doc-vs-code audit by the multi-role team, the following mismatches were corrected:
> command name `deepcodex` → `deepcode`; `--max-iter` → `--max-iterations`; `--agent` → `--role` (the CLI has no `--explain`/`--match-strategy` options);
> `/eag-autonomous-status|stop` take a positional argument (not `--run-id`); the EAG-P5 RunState path is actually `.eag/p5/run-state/<runId>.jsonl`;
> `/inject` is actually `/inject <instruction text>` (no taskId parameter); F.4 background-task persistence is not wired yet (Phase 2 plan);
> `/team consensus` is actually the `team dispatch --consensus` flag. The previously referenced `docs/enterprise/*.md` and two `docs/dev/*.md`
> design docs were never committed; they have been removed from navigation and replaced with code paths. Historical review/incident/fix-plan docs are archived under [docs/archive/](archive/).

---

## Overview

DeepCodeX builds upon Deep Code CLI to deliver two major leaps — **multi-role fusion** and **Enterprise Application Generation (EAG)** — along with dynamic instruction injection, AskUserQuestion auto-dispatch, V2 context memory, Loop-Graph fusion orchestration, and many more. This document summarizes all implemented new features, grouped by capability domain.

| Domain | Key Capability | Main Entry |
|--------|---------------|-----------|
| A. Multi-Role Collaboration | 5 core roles + 30 domain experts + smart matching + consensus review | `/team` subcommand |
| B. Autonomous Orchestration | Ralph 4-stage loop + Cybernetics + 6 workflow patterns | `/team autonomous` |
| C. EAG Enterprise App Generation | 3-loop design/code/test + red-line eval + paradigm recall | `/eag-autonomous` |
| D. Loop-Graph Fusion | DAG topology + intra-node Loop + predicate routing + graph guards | `/eag-graph` |
| E. V2 Context Memory | Dual-layer context + sliding window + diff preview + dual-axis approval + experience RAG | Auto-enabled |
| F. Dynamic Interrupt & Background Tasks | InterruptQueue + background sub-agent + task state machine | `/inject` `/bg` `/tasks` |
| G. AskUserQuestion Auto-Dispatch | Whitelist + suggestedCommand + auto command execution | LLM-triggered |
| H. Builtin Skills Enhancement | 4 bundled + 3 default + 4 document-processing skills | `/skills` |
| I. Logging & Observability | Log rotation + error-type preservation + interrupt event log | Auto-enabled |
| J. Multi-Model Provider | Anthropic native + OpenAI-compatible + Qwen3 compat | `settings.json` |

---

## A. Team Multi-Role Collaboration

### A.1 5 Core Roles

DeepCodeX ships 5 roles covering the technical execution chain of software development. Each role has its own `systemPromptSuffix`, responsibility boundary, and test coverage.

| Role | expertId | Responsibility | Trigger Keywords |
|------|----------|---------------|------------------|
| Architect | `architect` | Systematic, forward-looking, verifiable architecture | architecture, design, review |
| Product Manager | `product-manager` | Clear user value, well-defined requirements | requirements, PRD, user stories |
| Solo Coder | `solo-coder` | Complete, high-quality, maintainable, testable code | implement, develop, refactor |
| Test Expert | `test-expert` | Comprehensive, automated, quantifiable QA | test, quality, acceptance |
| UI Designer | `ui-designer` | Distinctive, production-grade UI; no AI "slop" | UI design, visual design |

### A.2 30 Domain Experts

To bridge the business-domain perspective, DeepCodeX incorporates 30 domain experts filtered from woagent's `builtin-agent-templates.yml` (all with mandatory `domain-` prefix). All domain experts support **lazy loading** and **dynamic matching**, automatically activated by business domain without polluting the default context.

| Category | Count | Representative Experts |
|----------|-------|----------------------|
| product | 4 | product-manager / sprint-prioritizer / trend-researcher / feedback-synthesizer |
| project_management | 3 | project-producer / project-shepherd / jira-workflow-automation |
| support | 4 | legal-compliance / finance-tracker / customer-response / analytics-reporter |
| specialized | 5 | agent-orchestrator / blockchain-security-auditor / medical-marketing-compliance / cloud-architect / data-scientist |
| academic | 4 | anthropologist / geographer / historian / psychologist |
| strategy | 4 | business-strategist / competitive-analyst / innovation-strategist / digital-transformation |
| marketing (selective) | 5 | growth-hacker / content-creator / seo-specialist / xiaohongshu-operator / cross-border-ecomm |
| sales (selective) | 1 | solution-strategist |

> Detailed inclusion list and matching weights: see code `packages/core/src/team/domain-experts/` (design doc never committed)

### A.3 Smart Matching Strategies

`role-matcher.ts` provides three matching strategies:

- **keyword** (default): keyword hit
- **semantic**: cosine similarity via local TFIDF/Hashing embedder
- **ai**: host-LLM prompt-layer smart matching (auto-degrades to semantic when unavailable)

```bash
# Explicit role
deepcode team dispatch --task "Design microservice architecture" --role architect

# AI auto-match (default when --role is omitted)
deepcode team dispatch --task "Design microservice architecture"

# Keyword matching is the built-in default strategy of role-matcher.ts;
# semantic / ai strategies are selected programmatically (no CLI flag)
```

### A.4 Eight-Stage Standard Workflow

Full project pipeline supports 8 stages (with Stage 8 doc-vs-code review added in v2.8):

```
Stage 1: Requirements Analysis (Product Manager)
Stage 2: Architecture Design (Architect)
Stage 3: UI Design (UI Designer)
Stage 4: Test Design (Test Expert)
Stage 5: Task Breakdown (Solo Coder)
Stage 6: Implementation (Solo Coder)
Stage 7: Test Verification (Test Expert)
Stage 8: Doc-vs-Code Review (multi-role)  ★ v2.8
```

On Stage 8 failure, precisely roll back to the relevant stage based on the gap dimension. Max iterations default to 3.

```bash
deepcode team full-lifecycle --task "Launch project: secure browser ad-block feature"
```

---

## B. Autonomous Orchestration Mode

Ralph-style 4-stage loop: **plan → dev → verify → fix**, iterating until done or iteration limit reached.

### B.1 Stage Responsibilities

| Stage | StageHandler | Key Responsibility |
|-------|--------------|-------------------|
| Plan | `PlanStageHandler` | Fetch next task card from tasks.md + G-A3a scope lock precheck |
| Dev | `DevStageHandler` | G-A1a path cage + G-A5a credential whitelist + file-state inventory + ChangeDiff artifact |
| Verify | `VerifyStageHandler` | Real test command execution + test output parsing (Jest/Mocha/node:test/generic) + G-A4a evidence enforcement |
| Fix | `FixStageHandler` | Failure-mode analysis (6 categories) + fix-suggestion generation + G-A3b cleanup-intent permanent ban |

### B.2 6-Layer 15 BLOCKER Safety Guards

In unattended mode, every command must pass the 6-Guard chain:

| Guard | IDs | Protection |
|-------|-----|-----------|
| EnvBoundaryGuard | G-A1a/b/c | Path cage / env-var write protection / production-credential unreachable |
| DangerousCommandGuard | G-A2a/b | Blacklisted commands / recursive deletion |
| ScopeLockGuard | G-A3a/b | Scope lock (out-of-scope → ASK for human) / cleanup-intent permanent ban |
| FakeCompletionGuard | G-A4a/b | Evidence enforcement / fake-completion detection |
| CredentialMisuseGuard | G-A5a/b | Credential whitelist / pre-commit secret scan |
| RuntimeConstraintGuard | G-A6a/b/c/d | Iteration cap / timeout breaker / heartbeat MAJOR / freeze on limit |

### B.3 Three-Command Complete Chain

```bash
# Launch unattended loop (inside TUI)
/eag-autonomous --goal "Implement login feature" --max-iterations 10

# Query run status (positional arg; defaults to the most recent run when omitted)
/eag-autonomous-status <runId>

# Break + rollback (cross-process stop via abort-flag file)
/eag-autonomous-stop <runId>
```

> The Team module also provides the CLI subcommand `deepcode team autonomous --goal "..." --max-iterations 10` (independent of the EAG-P5 engine).

### B.4 Persistence & Cross-Run Memory

- **RunState JSONL** (EAG-P5): `<projectRoot>/.eag/p5/run-state/<runId>.jsonl`, one JSON object per line, with `localChecksum` / `cumulativeChecksum` SHA256 verification and file locking
- **RunState JSON** (Team autonomous CLI): `./.deepcodex/runs/<runId>/state.json` — a separate store from EAG-P5
- **NotesMemory**: `./.deepcodex/notes.md`, cross-run memory shared by multiple runs
- **Resume**: Team autonomous uses `--resume-run` (boolean flag that resumes the most recent resumable run); EAG-P5 exposes resume evidence via `/eag-autonomous-status`

### B.5 Configuration

Create `./.deepcodex/autonomous.yml` in the project root:

```yaml
max_iterations: 10
confirmation: smart        # auto-approve | ask-user | fail-closed
sleep_guard: true
git:
  auto_commit: true
  branch_prefix: "autonomous/"
```

### B.6 Dynamic Workflows — 6 Patterns

| Task Pattern | Routing Mode | Execution |
|--------------|-------------|----------|
| Decomposable into independent subtasks (parallelism ≥ 2) | fan-out-aggregate | Dispatch in parallel → aggregate |
| Need quality validation / adversarial review | adversarial-verify | Generate → review → fix loop |
| Need multi-option competition | tournament | Parallel options → best wins |
| Need batch-generate-then-filter | generate-filter | Bulk generate → quality filter |
| Single clear-cut task type | classifier-dispatch | Classify → single-role execute |
| Quantifiable success criteria not yet met | loop-until-done | Iterate until criteria met |

### B.7 Cybernetics Three-Ring Control

Inspired by Qian Xuesen's engineering cybernetics and ICLR 2026 Profile-Aware Maneuvering:

- **Strategic layer**: perceive → decide → execute → feedback closed loop
- **Tactical layer**: pre-execution validation + anomaly detection + AI-augmented risk assessment
- **Execution layer**: Guard Coordinator

---

## C. EAG Enterprise Application Generation

> Code: `packages/core/src/eag/` (gate / graph / loop / coding / testing / design / p5 subsystems). Usage guide: [docs/eag-autonomous_en.md](eag-autonomous_en.md)

### C.1 Core Philosophy

**Enterprise App Generation = Architecture-Paradigm Knowledge × Loop Engineering × Multi-Role Collaboration**

Three paradigm shifts:

1. **From "prompting the model to write code" to "designing loops that let the model recall paradigms itself"**: User inputs raw business requirement ("I want an order-management service"); paradigm selection is done by the Architect role inside the DESIGN Loop based on requirement characteristics.
2. **From "human expert gating" to "independent evaluator gating by enterprise red lines"**: Generator and Evaluator are strictly separated — the model that writes code does not grade itself.
3. **From "linear script" to "three-loop progressive refinement"**: Design / Code / Test loops chained; humans intervene only at HUMAN_CHECKPOINT nodes.

### C.2 EAG-P5 Unattended Engine — Completed

| Dimension | Data |
|-----------|------|
| Code path | `packages/core/src/eag/p5/` |
| Files | 20 TS files |
| Lines | 16,159 |
| Tests | 52 E2E cases (L-U group, 4,346 test lines) |

For component details see the code under `packages/core/src/eag/p5/` (design doc never committed).

### C.3 EAG-P6 CodeMap Dynamic Window

Symbol-level code graph (CALLS / INHERITS / IMPLEMENTS / TESTED_BY) + dynamic context-window strategy to improve token efficiency.

### C.4 Paradigm Lock (Org Standards)

The paradigm-lock mechanism is implemented (`eak/paradigm-registry.ts`: when locked, the Architect role skips paradigm-signal evaluation and strictly follows organizational standards). The lock is passed in via `DesignLoopInput.paradigmLock`:

```yaml
paradigm_lock: "ddd"  # ddd | clean-architecture | cqrs | microservice | ...
```

> ⚠️ **Not wired (verified 2026-08-04)**: reading and YAML-parsing of the `.deepcode/eag.yml` file is not implemented in the repo; config-file loading is the caller's responsibility before invocation (see the comment in `design-models.ts`). Currently `paradigmLock` can only be passed through the API.

---

## D. Loop-Graph Fusion Architecture

> Code: `packages/core/src/eag/graph/` (graph-builder / graph-loop-orchestrator / predicate-registry / node-loop-kernel, etc.); command parsing: `packages/core/src/eag/cli/eag-graph-command.ts`

### D.1 Core Capabilities

Model complex tasks as **DAG topology**, with node contracts and conditional routing enabling multi-stage, multi-branch, parallel orchestration.

- **6 node types**: loop / task / decision / merge / fork / end — covers serial, parallel, conditional routing
- **Intra-node Loop closure**: `loop` nodes reuse the P5 AutonomousOrchestrator 4-stage loop
- **Contract-driven**: nodes declare `inputContract` / `outputContract`; edges declare `dataMapping`
- **Predicate routing**: all conditional logic via `PredicateRegistry`-registered predicate functions — **eliminates RCE risk**
- **Graph-level guards**: depth limit, parallelism limit, token budget, timeout, automatic failure isolation
- **Three-layer config merge**: `DEFAULT < JSON config < CLI args`
- **Immutable-first**: all interface fields `readonly` + `Object.freeze`

### D.2 Command Usage

```bash
# Load graph definition from file
/eag-graph --graph-file graphs/standard-delivery-chain.json

# Load from file + override config
/eag-graph --graph-file graphs/standard-delivery-chain.json --max-depth 50 --enable-experience-recall

# Inline graph definition
/eag-graph --inline-graph '{"graphId":"demo","name":"Demo","entryNodeId":"start","nodes":[...],"edges":[...]}'

# Inline + disable auto-isolation
/eag-graph --inline-graph '{"graphId":"demo",...}' --disable-auto-isolation --timeout-sec 3600
```

### D.3 Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--graph-file` | — | Graph-definition JSON path (mutually exclusive with `--inline-graph`) |
| `--inline-graph` | — | Inline graph-definition JSON string |
| `--enable-experience-recall` | `false` | Enable experience recall (Layer 3) |
| `--disable-auto-isolation` | `true` | Disable auto-isolation on node failure |
| `--max-depth` | `100` | Max traversal depth |
| `--max-parallelism` | `4` | Max parallelism |
| `--timeout-sec` | `0` | Graph-level timeout (0 = no limit) |
| `--max-tokens` | `0` | Graph-level token budget |
| `--node-retry-limit` | `3` | Node failure retry count |

---

## E. V2 Context Memory & Diff/Approval

> Full design: [docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md) (local doc, not committed)

### E.1 Dual-Layer Context

- **GlobalContext** (cross-task): project-level long-term context, persists across sessions
- **TaskContext** (per-task): working context for the current task, cleared on task end
- **ContextSynchronizer**: bidirectional sync

### E.2 Task-Focused Sliding Window

Replaces naive full-context compression with a CodeMap-based relevance-scored sliding window — precise focus under DeepSeek V4's 1M context window.

### E.3 Enhanced Diff Preview

- **Colored unified diff**: `+` lines green / `-` lines red / context default
- **Fuzzy matching**: fault-tolerant matching
- **PatchSummaryCell**: hunk summary
- **Multi-hunk support**: multiple changes per file
- **Performance**: 10KB file diff < 50ms

### E.4 Dual-Axis Approval Gate

**AppMode × ApprovalMode orthogonal design**:

| Approval \ App | Plan | Agent | YOLO |
|----------------|------|-------|------|
| **Suggest** | Suggest + confirm | Suggest + confirm | Direct |
| **Auto** | Auto + report | Auto + report | Direct |
| **Never** | Never | Never | Never |

### E.5 side-git Zero-Pollution Rollback

Side-git repo using `--git-dir` / `--work-tree` separation for turn-level snapshot rollback — **does not pollute the main repo**.

### E.6 Business Understanding

- **CodeMap**: code map (symbol-level)
- **AST parsing**: project structure detection (monorepo / layered architecture)
- **Business domain modeling**: infer business domain from code

### E.7 7-Dimension Dynamic Memory System

| Dimension | Scope | Persistence |
|-----------|-------|-------------|
| User global memory | Cross-project | `~/.deepcodex/memory/user_profile.md` |
| Project memory | Per project | `.deepcodex/memory/project_memory.md` |
| Task temp memory | Per task | Runtime memory |
| Experience RAG | Cross-project | Vector retrieval |
| Topics summary | Per project | `.deepcodex/memory/projects/<project>/YYYYMMDD/topics.md` |
| Session memory | Per session | `session_memory_<id>.jsonl` |
| Performance profile | Per project | Execution case records + similar-case retrieval |

---

## F. Dynamic Interrupt & Background Tasks (ADR-DI-001)

Allows users to append instructions mid-execution or launch independent sub-tasks — similar to Claude CLI's interrupt capability.

### F.1 InterruptQueue FIFO Instruction Queue

Polled between LLM calls and during streaming responses; merged into system messages to steer task direction.

### F.2 Task State Machine

11 states + legal-transition table:

```
queued → pending → running ⇄ pausing ⇄ paused
                           ↓
                       retrying → running
                           ↓
            timeout / failed / succeeded / cancelled
                           ↑
                       injecting (dynamic instruction injection)
```

### F.3 Command Entries

| Command | Purpose |
|---------|---------|
| `/inject <instruction text>` | Append an instruction to the currently running task (soft interrupt, consumed at the next LLM call) |
| `/bg <prompt>` | Launch background sub-agent (independent SessionManager instance) |
| `/tasks` | List all tasks |
| `/fg <taskId>` | Switch foreground focus |
| `/cancel <taskId>` | Cancel specified task |
| `/pause` | Pause current foreground task |
| `/resume <taskId>` | Resume a paused task |

### F.4 Persistence & Recovery

> ⚠️ **Not wired (verified 2026-08-04; Phase 2 plan)**: task-snapshot serialization (`TaskSnapshot` / `toSnapshot` / `fromSnapshot`) and the `TaskStoreLike` interface are defined, but the repo has no `TaskStoreLike` implementation, and the CLI assembly layer does not inject a taskStore when creating `BackgroundTaskRunner`. Task state is currently in-memory only — it does NOT auto-transition to `paused` after a crash, and `.deepcodex/tasks/` is never written. On the LLM-tool side, `inject_message(task_id, message)` can target a specific background task.

### F.5 LLM Tool Integration

Four new LLM-callable tools:

- `background_task`: launch background sub-task
- `list_tasks`: list all tasks
- `cancel_task`: cancel specified task
- `inject_message`: inject message into specified task

### F.6 Interrupt Mechanism

- **Soft interrupt** (instruction injection): consumed by InterruptQueue during LLM gaps
- **Hard interrupt** (task cancel): based on AbortController + file flag (`.abort` file) for cross-process interruption

---

## G. AskUserQuestion Auto-Dispatch

> Code: `packages/core/src/common/` (core-layer `parseSuggestedCommand` whitelist) and `packages/cli/src/ui/core/ask-user-question.ts` (CLI-layer `normalizeSuggestedCommand` secondary validation)

### G.1 Background

When the LLM asks the user via the AskUserQuestion tool, the user's answer was only sent back as a plain message — **no automatic follow-up command execution**, forcing the user to manually type `/team dispatch` etc. — a broken experience.

### G.2 Solution

Extend AskUserQuestion with an optional `suggestedCommand` field. After the user answers, the command is auto-injected for execution:

```typescript
{
  "questions": [...],
  "suggestedCommand": {
    "command": "/team dispatch",
    "reason": "User confirmed review scope; auto-dispatch to architect recommended"
  }
}
```

### G.3 Security (Three-Layer Whitelist)

1. **Core-layer `parseSuggestedCommand`**: whitelist check — only `team / architect / pm / coder / tester / ui / eag-*` commands allowed
2. **CLI-layer `normalizeSuggestedCommand`**: secondary whitelist aligned with core layer
3. **Must start with `/`**: prevents arbitrary shell-command injection

### G.4 Concurrency Safety (Merge Strategy)

To avoid racing the SessionManager state machine with concurrent `handlePrompt` calls, a **single-call merge strategy** is used: the user's answer + the auto-command are merged into a single submission.

---

## H. Builtin Skills Enhancement

> Code: `packages/core/src/skill-manager.ts` (scan & load) and `packages/core/templates/skills/` (skill templates)

### H.1 New Bundled Skills (4)

| Skill | Purpose |
|-------|---------|
| `web-dev` | Full-stack frontend (React + Vite + Tailwind + shadcn/ui) |
| `web-artisan` | High-quality web artifacts and marketing pages |
| `code-mode-orchestrator` | Code-mode orchestration (multi-mode switching) |
| `browser-automation` | Browser automation testing and scraping |

### H.2 New Default Skills (3)

Enabled by default; can be disabled via `settings.json`'s `enabledSkills`:

| Skill | Purpose |
|-------|---------|
| `design-aesthetics` | Design-aesthetics constraints |
| `ui-ux-best-practices` | UI/UX best practices |
| `code-quality-guidelines` | Code-quality guidelines |

### H.3 New Document-Processing Skills (4)

Backed by real Python scripts (no mock / placeholder / simplification):

| Skill | Implementation | Main Capabilities |
|-------|---------------|-------------------|
| `docx` | python-docx | Create / edit / format Word documents |
| `pdf` | pdfplumber + token-based design system | Create / reformat / form-fill |
| `pptx` | PptxGenJS + CSV data | Create / edit / extract text |
| `xlsx` | openpyxl + recalc.py | Create / edit / formula recalc / data analysis |

### H.4 Visualization Renderer & Widget Tool

- `packages/core/src/visualization/renderer.ts`: visualization renderer supporting multiple component types
- `packages/core/src/visualization/widget-tool.ts`: LLM-callable visualization widget tool

---

## I. Logging & Observability

### I.1 Log Rotation

> Code: `packages/core/src/common/log-rotation.ts`

Rotates by file size (**10MB**), keeping **3 backups** — replaces the legacy "read full file + slice + rewrite" performance anti-pattern.

Affected log files:

- `~/.deepcodex/logs/debug.log` + `.1` / `.2` / `.3` rolling backups
- `~/.deepcodex/logs/error.log` + rolling backups
- `~/.deepcodex/logs/interrupts.log` + rolling backups

### I.2 Error-Type Preservation

Fixed the message fallback logic in `llm-error.ts` so the original error type is correctly displayed:

```
# Before
[ERROR] Request failed: <message>

# After
[ERROR] APIUserAbortError: Request aborted by user
[ERROR] APIError 400: Invalid request payload
```

### I.3 Interrupt Event Log

New `interrupt-logger.ts` module records dynamic-instruction injections and background-task key events to `interrupts.log` for troubleshooting and behavior tracing:

```jsonl
{"ts":"2026-07-26T10:30:00Z","event":"inject","taskId":"t-001","message":"...","source":"user"}
{"ts":"2026-07-26T10:31:00Z","event":"bg_start","taskId":"t-002","kind":"autonomous"}
{"ts":"2026-07-26T10:35:00Z","event":"task_cancel","taskId":"t-002","reason":"user_cancel"}
```

---

## J. Multi-Model Provider Support

### J.1 Supported Providers

| Provider | Applicable Models | Access |
|----------|------------------|--------|
| OpenAI-compatible (default) | DeepSeek V4 / Doubao / Qwen / any OpenAI-compatible | `BASE_URL` + `API_KEY` |
| Anthropic native | Claude 3.5 / 3.7 / Opus / Sonnet | Native API + independent `reasoning` field extraction |

### J.2 Qwen3 Reasoning-Model Compatibility

The `reasoning` field is extracted independently to avoid SSE aggregation issues; supports multi-model frameworks (Qwen3 / DeepSeek-R1 / Claude 3.7) field compatibility.

### J.3 Configuration Examples

```json
{
  "env": {
    "MODEL": "claude-opus-4",
    "PROVIDER": "anthropic",
    "API_KEY": "sk-ant-..."
  }
}
```

```json
{
  "env": {
    "MODEL": "qwen3-235b-a22b",
    "BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "API_KEY": "sk-..."
  }
}
```

---

## K. Plan Mode

Switch to Plan Mode via `/plan`; the LLM only generates an implementation plan without performing real code changes. After plan confirmation, exit Plan Mode and enter the execution phase.

See: [docs/plan-mode.md](plan-mode_en.md)

---

## L. New Slash Commands Summary

| Command | Purpose | Module |
|---------|---------|--------|
| `/team` | Multi-role team dispatch (TUI slash command, auto role matching) | Team |
| `/architect` `/pm` `/coder` `/tester` `/ui` | Force dispatch to a specific role | Team |
| `/eag-autonomous` | Launch EAG unattended loop | EAG-P5 |
| `/eag-autonomous-status` | Query EAG run status (positional `<runId>`) | EAG-P5 |
| `/eag-autonomous-stop` | Break + rollback EAG (positional `<runId>`) | EAG-P5 |
| `/eag-graph` | Launch graph orchestration | Loop-Graph |
| `/inject` | Append instruction to current task | Dynamic Interrupt |
| `/bg` | Launch background sub-agent | Background Task |
| `/tasks` | List all tasks | Background Task |
| `/fg` | Switch foreground focus | Background Task |
| `/cancel` | Cancel a task | Background Task |
| `/pause` | Pause current task | Background Task |
| `/resume` | Resume a paused task | Background Task |
| `/plan` | Enter Plan Mode | Plan Mode |
| `/memory` | Memory management (list/delete/review/export) | V2 Memory |
| `/rules` | RLIS rule management | EAG-RLIS |
| `/quality-check` | Quality gate (codemap/uiux/visual/all) | Quality Gate |
| `/review` | Code review (tool-verification first) | Review |
| `/help` | List all builtin commands | Help |

> Team module CLI subcommands (not slash commands): `deepcode team list / match / dispatch / autonomous / full-lifecycle`; consensus review is enabled via `deepcode team dispatch --consensus`; the eight-stage loop is enabled via `deepcode team full-lifecycle --use-loop`.

---

## M. Configuration Files Overview

| Path | Purpose |
|------|---------|
| `~/.deepcode/settings.json` | User-level main config (API_KEY / MODEL / notify / permissions) |
| `./.deepcode/settings.json` | Project-level config (higher priority than user-level) |
| `./.deepcodex/autonomous.yml` | Autonomous orchestration config |
| `./.deepcode/eag.yml` | EAG config (incl. paradigm lock) |
| `./.deepcodex/runs/<runId>/state.json` | Single-run state |
| `./.deepcodex/notes.md` | Project-level cross-run memory |
| `./.deepcodex/tasks/` | Task-state persistence directory |
| `./.deepcodex/memory/` | 7-dimension dynamic memory system |

### .deepcode vs .deepcodex Naming

| Directory | Purpose |
|-----------|---------|
| `~/.deepcode/` / `./.deepcode/` | Deep Code CLI main config dir (settings.json / skills / plugins) |
| `~/.deepcodex/` / `./.deepcodex/` | Team autonomous dir (autonomous.yml / runs / notes / tasks / memory) |

---

## N. Test Baseline

| Module | Tests | Notes |
|---------|-------|-------|
| Core unit tests | 524+ | Includes V2 context memory, EAG-P5, Domain Expert, etc. |
| Team unit tests | 195 + 585 regression | 30 domain experts + 5 roles |
| E2E tests | 12 scripts | team-cmd / v2-modules / arch-mechanisms / domain-expert / EAG batches / e2e-eight-stage-loop |
| EAG-P5 E2E | 52 cases (L-U group) | Dev / Verify / Fix / BLOCKER / three commands / cross-session resume |
| Logging & interrupt | 57 cases | log-rotation / interrupt-logger / error-logger / debug-logger |
| AskUserQuestion | 2 suites | Core-layer + CLI-layer whitelist & merge strategy |

---

## O. Design Principles & Constraints

### O.1 Karpathy's Four Core Principles

| Principle | Requirement |
|-----------|-------------|
| Think Before Coding | State assumptions, ask when unclear, don't hide confusion |
| Simplicity First | Minimal code, no speculative features, no over-abstraction |
| Surgical Changes | Change only what's necessary, preserve style |
| Goal-Driven | Define success criteria, verify checkpoints |

### O.2 Ponytail Decision Ladder (6 Steps)

1. YAGNI: Is it really needed?
2. Standard library: Can the standard library do it?
3. Platform-native: Can platform-native capabilities do it?
4. Reuse: Can existing code be reused?
5. One-liner first: Can it be done in one line?
6. Minimum viable: What's the minimum viable implementation?

### O.3 Real-Implementation Promise

- ❌ No mock / placeholder / simplified implementation
- ✅ Every TODO must have a corresponding implementation
- ✅ Every FIXME must have a corresponding fix
- ✅ Code functions and key logic must have detailed comments

---

## P. Documentation Navigation

### Design Documents (by capability domain)

> Note: the `docs/fusion/` directory contains local design docs that are not committed (excluded via .gitignore); the fusion links below work only on this machine.

| Domain | Document |
|--------|----------|
| Fusion Plan | [docs/fusion/DEEPCODEX_FUSION_PLAN.md](fusion/DEEPCODEX_FUSION_PLAN.md) |
| Karpathy Principles | [docs/fusion/KARPATHY_PRINCIPLES.md](fusion/KARPATHY_PRINCIPLES.md) |
| Ponytail Rules | [docs/fusion/PONYTAIL_RULES.md](fusion/PONYTAIL_RULES.md) |
| V2 Context Memory PRD | [docs/fusion/V2_CONTEXT_MEMORY_PRD.md](fusion/V2_CONTEXT_MEMORY_PRD.md) |
| V2 Context Memory Tech Design | [docs/fusion/V2_CONTEXT_MEMORY_TECH_DESIGN.md](fusion/V2_CONTEXT_MEMORY_TECH_DESIGN.md) |
| Output Truncation Design | [docs/fusion/V2_OUTPUT_TRUNCATION_DESIGN.md](fusion/V2_OUTPUT_TRUNCATION_DESIGN.md) |
| EAG Enterprise App Generation | Design doc never committed; see code `packages/core/src/eag/` |
| Loop-Graph Fusion Design | Design doc never committed; see code `packages/core/src/eag/graph/` |
| Domain Expert Integration | Design doc never committed; see code `packages/core/src/team/domain-experts/` |
| Builtin Skills Enhancement | Design doc never committed; see code `packages/core/templates/skills/` and `packages/core/src/skill-manager.ts` |
| AskUserQuestion Auto-Dispatch | Design doc never committed; see code `packages/cli/src/ui/core/ask-user-question.ts` |
| Logging Fix Design | Design doc never committed; see code `packages/core/src/common/log-rotation.ts` |
| Historical review / incident / fix-plan records (archived) | [docs/archive/](archive/) |

### User Documentation

| Document | Purpose |
|----------|---------|
| [docs/quickstart_en.md](quickstart_en.md) | Quick Start |
| [docs/configuration_en.md](configuration_en.md) | Configuration |
| [docs/architecture_en.md](architecture_en.md) | Architecture Overview |
| [docs/agent-skills_en.md](agent-skills_en.md) | Agent Skills Guide |
| [docs/mcp_en.md](mcp_en.md) | MCP Integration |
| [docs/permission_en.md](permission_en.md) | Permission Control |
| [docs/plan-mode.md](plan-mode.md) | Plan Mode |
| [docs/notify_en.md](notify_en.md) | Notification Config |
| [docs/session-persistence_en.md](session-persistence_en.md) | Session Persistence |
| [docs/statusline_en.md](statusline_en.md) | Status Line |
| [docs/eag-autonomous_en.md](eag-autonomous_en.md) | EAG Autonomous Usage Guide |
