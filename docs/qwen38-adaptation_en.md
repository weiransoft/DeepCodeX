# Qwen3.8 Series Adaptation Design Document

> Status: Review approved (architect + test-expert conditional pass; v2 implements all revisions)
> Version: v2 (2026-09-03, post-review revision)
> Related model card: [Qwen/Qwen3.8-27B-FP8](https://modelscope.cn/models/Qwen/Qwen3.8-27B-FP8)

## 0. v2 Review Revision Log

| Rev | Source | Content |
|---|---|---|
| R1 | Architect B-1 | §4 list adds `packages/core/src/tests/settings-and-notify.test.ts`: existing test at L651-664 uses `"medium" as never` as the invalid sample; after D1 this test would fail — sample must change to a genuinely invalid value `"ultra"` and the test name synced |
| R2 | Architect B-2 / Test-expert fix 3 | §4 list adds `packages/cli/src/tests/models-dropdown.test.ts`: existing L9-15 asserts the four-level order/indexes; D7 reordering would fail it — assertions must be updated to the six-level form |
| R3 | Architect S-1 | D2 regex anchored to `^(?:qwen/)?qwen3\.(\d+)`, aligning the namespace with `isQwen3Model` (the 3.8+ recognition set ⊆ the Qwen3 recognition set; removes ambiguity for names like "unsloth/Qwen3.8") |
| R4 | Architect S-2 | D3 mapping `high→medium` decision rationale added: conservatively control token cost by clamping down (not probing up to xhigh); xhigh is already the Qwen3.8 server-side default, so no level drift |
| R5 | Architect S-3 | D4 wording corrected: `openai-message-converter.ts` replays historical `reasoning_content` **unconditionally** (independent of thinkingEnabled); the reason for not sending preserve_thinking when thinking is off is "no new field, server default applies" |
| R6 | Architect S-4 | D6 `??` semantics documented: an empty `reasoning_content` string does not fall back — same semantics as the session.ts L1460 main path; both sites keep identical implementations |
| R7 | Architect S-5 | D8 doc-sync scope extended: `docs/quickstart.md` / `quickstart_en.md` (L52 three-level wording), `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md` (L34, L83-91); noted that `docs/INSTALL.md:83` sample value `"medium"` becomes valid after D1 (incidental fix of a pre-existing doc/behavior inconsistency) |
| R8 | Architect S-6 / Test-expert fix 2 | §5.3 test location corrected: existing reasoningEffort parsing tests live in `settings-and-notify.test.ts`, not `qwen3-settings.test.ts`; the invalid-value assertion is black-box on the resolved result falling back to `"max"` (`resolveReasoningEffort` is not exported; no new export added) |
| R9 | Test-expert fix 1 | §5.4 handle guard cases use a full handle object (`isOpenAIClientHandle` validates the four required fields client/model/baseURL/thinkingEnabled; passing only reasoningEffort would not exercise the widening); added old-three-level positive regression and case-sensitive negative cases |
| R10 | Test-expert §2.1 | §5.1 boundary cases T7-T12 added: two-digit minor (qwen3.10), patch suffix (qwen3.7.9 / qwen3.8.1), dual-function fork boundary (qwen30-8b), surrounding whitespace, bare prefix name (qwen3.8) |
| R11 | Test-expert §2.3 | §5.2 mapping matrix completed (T9-T12); thinking=false path gets negative assertions (no reasoning_effort / preserve_thinking fields in the body) |
| R12 | Test-expert §2.5 | New S5: team-adapter path Qwen3.8 end-to-end integration case (reuses existing stubs in `packages/core/src/team/tests/team-adapter-llm.test.ts`; that path currently only covers DeepSeek) |
| R13 | Test-expert §2.6 | New doc-consistency test `qwen38-docs-consistency.test.ts` providing automated support for acceptance criterion 8 |
| R14 | Test-expert fix 4 | §5.6 S1-S4 defined as provider-level "fixed-response stubs against the real interface contract" (reusing the `TestableOpenAILLMClient` pattern from `openai-stream.test.ts`: subclass OpenAILLMClient, override `getUnderlyingOpenAI()` to return a fixed response — not a mock); S4 observed at provider level via `buildMessages` (replay logic lives in the converter; short observation chain, equivalent proof) |
| R15 | Test-expert §5.6 | New implementation-order constraint: update the R1/R2 existing test assertions first, then make the D1-D8 functional changes, then run the full regression — prevents mid-flight red tests being misread as feature regressions |
| R16 | Architect risk 3 | `ThinkingRequestOptions.reasoning_effort` type comment explicitly states "produced only by the Qwen3.8+ branch; do not promote to a common path" (the SDK official type only accepts low/medium/high; xhigh sent to OpenAI official endpoints would 400) |

## 1. Background & Requirements

### 1.1 Key model card facts (Qwen3.8-27B-FP8)

| Dimension | Description |
|---|---|
| Quantization | Fine-grained FP8 (block size 128), compatible with vLLM / SGLang / Transformers |
| Architecture | Native vision-language model (image + video), 27B dense, hybrid attention (gated DeltaNet linear attention + gated attention) + MTP (multi-token prediction) |
| Context | Native 262,144, expandable to 1,000,000 |
| Thinking mode | **Enabled by default**, controlled via `chat_template_kwargs.enable_thinking` |
| Thinking preservation | **`preserve_thinking` enabled by default** (keeps thinking blocks in all history messages), controlled via `chat_template_kwargs.preserve_thinking` |
| Reasoning effort | **Official top-level `reasoning_effort` parameter**: `xhigh` (default) / `medium` / `low` |
| Recommended sampling | Thinking: temp=1.0 / top_p=0.95 / top_k=20; non-thinking: temp=0.7 / top_p=0.8 / top_k=20 / presence_penalty=1.5 |
| Streaming output | `delta.reasoning_content` or `delta.reasoning` field (varies by deployment) |

### 1.2 User requirement

Based on the current (v1.1 fork) Qwen3 support in DeepCodeX-cli, update the adaptation mechanism so the CLI fully and correctly drives the Qwen3.8 series (including local/hosted Qwen3.8-27B-FP8 deployments):

- Correctly identify Qwen3.8 and later 3.x (>= 3.8) sub-versions;
- Correctly send `enable_thinking` / `preserve_thinking` given thinking mode is on by default;
- Support the official `reasoning_effort` levels (xhigh / medium / low) and expose them in settings and UI;
- Parse both `reasoning_content` / `reasoning` streaming fields correctly;
- No regression for existing Qwen3 (<3.8) and DeepSeek V4 request shapes.

## 2. Current State & Gap Analysis

Existing Qwen3 support (v1.1):

- `isQwen3Model` (`packages/core/src/common/model-capabilities.ts`): `lower.startsWith("qwen3") || lower.startsWith("qwen/qwen3")` — **"Qwen/Qwen3.8-27B-FP8" already matches**;
- `defaultsToThinkingMode`: Qwen3 defaults to thinking on, consistent with the 3.8 card ✓;
- `buildThinkingRequestOptions` (`packages/core/src/common/openai-thinking.ts`): Qwen3 branch sends top-level `chat_template_kwargs: { enable_thinking }` ✓;
- `openai-message-converter.ts`: replays historical assistant `reasoning_content` (L258-264, unconditionally, independent of thinkingEnabled); Qwen3 system-message flattening (L99-104);
- `session.ts` main streaming path: `delta.reasoning_content ?? delta.reasoning` dual-field parsing (L1460) ✓.

Gap list:

| # | Feature | Current | Gap |
|---|---|---|---|
| G1 | Qwen3.8 sub-version detection | Only coarse `isQwen3Model` match | No 3.8+ discrimination to differentiate new params |
| G2 | `reasoning_effort` | Only sent for DeepSeek (low/high/max, in extra_body) | Qwen3.8 needs top-level `reasoning_effort` (xhigh/medium/low) |
| G3 | `preserve_thinking` | Not supported | Qwen3.8+ thinking mode needs explicit `preserve_thinking: true` |
| G4 | `ReasoningEffort` type | `"low" \| "high" \| "max"` | Extend `medium` / `xhigh` (settings.ts L33, resolveReasoningEffort L259, openai-client.ts guard L257, ModelsDropdown options) |
| G5 | openai-provider.ts streaming | L179 only reads `delta["reasoning_content"]` | Missing `?? delta["reasoning"]` fallback (session.ts main path already has it) |
| G6 | UI levels | max / high / low / No thinking | Missing xhigh / medium options |

Already satisfied, no change needed:

- Context window: `getDefaultContextWindow` defaults to 256K = 262,144 for non-DeepSeek-V4, matching the 3.8 native window ✓;
- Multimodal: `NON_MULTIMODAL_MODELS` only contains DeepSeek, Qwen defaults to multimodal ✓ (video input is out of CLI text-input scope, see §7 Out of Scope).

## 3. Design

### D1: `ReasoningEffort` type extension

`packages/core/src/settings.ts`:

```ts
// v1.2 change: add "medium" / "xhigh" levels (Qwen3.8 official levels are low/medium/xhigh)
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
```

Sync points (verified by repo-wide grep: literal validation exists in only these 2 places; all other hits are type references / display / pass-through and inherit automatically):

- `resolveReasoningEffort` (settings.ts L259-261): accept the five literals `low/medium/high/xhigh/max`;
- `openai-client.ts` `isOpenAIClientHandle` (L257-264): widen the guard to five levels.

**Compatibility**: old values low/high/max all retained; zero config migration. Note `resolveReasoningEffort` uses strict literal equality, case-sensitive; invalid values (including `"XHIGH"`, `" high"`) fall back to the default `"max"` (settings.ts L697-703).

### D2: `isQwen38Model` sub-version detection

New export in `packages/core/src/common/model-capabilities.ts`:

```ts
/**
 * Whether the model belongs to the Qwen3.8+ series (3.8 / 3.9 / 4.x, etc.)
 *
 * Rule: lowercase and trim the model name, match the anchored regex
 * /^(?:qwen\/)?qwen3\.(\d+)/ and require the captured minor version >= 8
 * Covers: Qwen/Qwen3.8-27B-FP8 / qwen3.8-27b / qwen3.8-plus /
 *         qwen3.8-max-preview / qwen3.9-70b, etc.
 *
 * Notes:
 * - The anchored regex allows only the qwen/ prefix, aligning with the
 *   isQwen3Model namespace ("qwen3" / "qwen/qwen3" prefixes) so that the
 *   isQwen38Model recognition set is a subset of the isQwen3Model set
 * - The dot is required (qwen3.8-…); non-version strings like "qwen38" /
 *   "qwen30-8b" never match
 * - 3.8 is the capability baseline: 3.8 introduced reasoning_effort /
 *   preserve_thinking; later sub-versions are assumed compatible
 * - \d+ captures the full number, so a two-digit minor (qwen3.10) yields 10 >= 8
 */
export function isQwen38Model(model: string): boolean {
  const lower = model.trim().toLowerCase();
  const match = /^(?:qwen\/)?qwen3\.(\d+)/.exec(lower);
  if (!match) return false;
  return Number(match[1]) >= 8;
}
```

### D3: Rework the Qwen3 branch in `buildThinkingRequestOptions`

`packages/core/src/common/openai-thinking.ts`:

```ts
type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  extra_body?: {
    reasoning_effort?: ReasoningEffort;
  };
  chat_template_kwargs?: {
    enable_thinking: boolean;
    /** Qwen3.8+: keep thinking blocks in history (matches the CLI's unconditional reasoning_content replay) */
    preserve_thinking?: boolean;
  };
  /**
   * Qwen3.8+: official top-level reasoning_effort (xhigh / medium / low)
   *
   * NOTE: produced only by the Qwen3.8+ branch; do NOT promote to a common
   * path — the OpenAI SDK official type only accepts low/medium/high, and
   * sending xhigh to OpenAI official endpoints would 400
   */
  reasoning_effort?: "xhigh" | "medium" | "low";
};
```

Qwen3 branch behavior:

| Condition | Request body |
|---|---|
| Qwen3.8+ and thinkingEnabled=true | `{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, reasoning_effort: map(reasoningEffort) }` |
| Qwen3.8+ and thinkingEnabled=false | `{ chat_template_kwargs: { enable_thinking: false } }` |
| Qwen3 (<3.8) | `{ chat_template_kwargs: { enable_thinking: thinkingEnabled } }` (**zero regression**) |

Level mapping `mapReasoningEffortToQwen`:

| CLI level | Qwen3.8 top-level value | Note |
|---|---|---|
| `low` | `low` | pass-through |
| `medium` | `medium` | pass-through |
| `high` | `medium` | Qwen3.8 has no high level. Decision: clamp down conservatively to control token cost (rather than probing up to xhigh), avoiding cost blowups in high-throughput scenarios |
| `xhigh` | `xhigh` | pass-through (Qwen3.8 server-side default level) |
| `max` | `xhigh` | max exceeds the official top level; clamp to xhigh |

The mapping is monotone non-decreasing; the settings default level `"max"` (L697-703) maps to xhigh, matching the model's server-side default — no level drift.

**Why explicitly send `preserve_thinking: true` (D4)**:
`openai-message-converter.ts` (L258-264) replays historical assistant `reasoning_content` **unconditionally** (independent of thinkingEnabled). In thinking mode this matches the semantics of `preserve_thinking: true` exactly; although the card marks it enabled by default, sending it explicitly is immune to server-side default changes and keeps strong consistency with the CLI's replay behavior. When thinking is off, no new field is added and the server default applies, avoiding an ineffective parameter.

**Regression protection for old models**: Qwen3 models where `isQwen38Model` is false (e.g. qwen3-8b, Qwen3-32B, qwen3.5-xxx, qwen30-8b) keep the original branch; the request shape is byte-identical to v1.1. The DeepSeek branch is untouched; non-Qwen/non-DeepSeek models still return `{}` (OpenAI official o-series etc. unaffected).

### D5: Recommended sampling parameters — not implemented (YAGNI, approved by architect)

The card's recommended temp/top_p/top_k/presence_penalty combinations are **not auto-injected**, because:

1. Current CLI semantics: when temperature is not explicitly set, nothing is sent and the server uses the model defaults; on vLLM those defaults equal the card's recommendations;
2. Auto-overriding a user-configured temperature/top_p would break user control;
3. If deployment differences are observed later, a `samplingProfile` setting can be added (out of this scope).

Conclusion: record the recommended values in this doc only; no code.

### D6: Dual-field streaming reasoning parsing in openai-provider.ts

`packages/core/src/providers/openai-provider.ts` L179 (streaming):

```ts
// Align with the session.ts L1460 main path: support both reasoning_content (vLLM)
// and reasoning (some deployments). Note: ?? falls back only on null/undefined —
// an empty-string reasoning_content does NOT fall back; the subsequent
// length > 0 check yields no event, keeping both sites semantically identical.
const reasoningRaw =
  (delta as unknown as Record<string, unknown>)["reasoning_content"] ??
  (delta as unknown as Record<string, unknown>)["reasoning"];
if (typeof reasoningRaw === "string" && reasoningRaw.length > 0) {
  yield { type: "thinking_delta", thinking: reasoningRaw };
}
```

The non-streaming `createMessage` (L110) gets the same `?? msg["reasoning"]` fallback (identical `??` semantics).

### D7: New level options in ModelsDropdown

`packages/cli/src/ui/components/ModelsDropdown/index.tsx`:

```ts
export const MODEL_COMMAND_THINKING_OPTIONS: ThinkingModeOption[] = [
  { label: "Thinking mode [xhigh]", thinkingEnabled: true, reasoningEffort: "xhigh" },
  { label: "Thinking mode [max]", thinkingEnabled: true, reasoningEffort: "max" },
  { label: "Thinking mode [high]", thinkingEnabled: true, reasoningEffort: "high" },
  { label: "Thinking mode [medium]", thinkingEnabled: true, reasoningEffort: "medium" },
  { label: "Thinking mode [low]", thinkingEnabled: true, reasoningEffort: "low" },
  { label: "No thinking", thinkingEnabled: false },
];
```

- `getThinkingOptionIndex` (L25-33, already exported at L167 + ui barrel) matches by exact `reasoningEffort`, falling back to 0; all five levels resolve correctly — **the function itself needs no changes**;
- The component's `maxVisible={6}` fits exactly six items; no adjustment needed.

### D8: Documentation sync (scope extended after review)

| Document | Change |
|---|---|
| `docs/configuration.md` / `configuration_en.md` | L35 values updated to five levels; L178 section adds the five-level table; L141-176 Qwen3 section adds a 3.8+ parameter table (enable_thinking / preserve_thinking / top-level reasoning_effort mapping) |
| `docs/quickstart.md` / `quickstart_en.md` | L52 `reasoningEffort` values updated to five levels |
| `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md` | L34 value table and L83-91 five-level table synced (bundled skill reference docs ship with the package; must stay consistent with docs) |
| `docs/INSTALL.md` | L83 sample value `"reasoningEffort": "medium"` needs no edit — **incidental fix**: under current code the sample is silently invalid (parsing falls back to max); after D1 it becomes valid, resolving a pre-existing doc/behavior inconsistency |
| `docs/qwen38-adaptation.md` / `_en.md` | This design doc (kept as the implementation basis) |

D8 must also document the dual relationship: whether historical thinking blocks enter the prompt depends on both the CLI's unconditional `reasoning_content` replay and the server-side `preserve_thinking` default — when debugging "model forgets earlier thinking" issues, inspect both sides.

### D9: Qwen3.8+ default context window 128K + dynamic auto-compaction (v1.3 increment, 2026-09-03)

Requirement: set a dedicated default context window of 128K for the Qwen3.8 series (e.g. `Qwen/Qwen3.8-27B-FP8`), with dynamic compaction driven by actual context usage.

Approach (reuse existing mechanisms; only change default inference — Karpathy Simplicity First):

1. `packages/core/src/settings.ts`:
   - New constant `QWEN38_CONTEXT_WINDOW = 128 * 1024` (131072 tokens);
   - `getDefaultContextWindow(model)` gains a Qwen3.8+ branch: returns 128K when `isQwen38Model(model)` matches (ordered after the DeepSeek V4 exact set, before the default 256K);
   - New exported constant `DEFAULT_AUTOCOMPACT_RATIO = 0.8`; `getDefaultAutoCompactWindow` and the `resolveSettings` default compaction threshold are unified to `floor(contextWindow × 0.8)` (Qwen3.8 128K window → threshold 104857, leaving ~25.6K headroom).
2. Default compaction ratio 50% → 80% (adjusted after v1.3 review, industry evidence):
   - The upstream v0.3.1 default `contextWindow/2` (50%) is overly aggressive — nearly half of a 128K window sits idle;
   - Industry research (2026-09): Gemini CLI defaults to 70% (`DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.7`), OpenAI Codex CLI 90% (95% hard clamp), Claude Code ~92% (community feedback: too late, poor compaction quality);
   - 80% matches the fork's existing fallback `getCompactPromptTokenThreshold` (`contextWindow × 0.8`, commented as "reserve 20% for output + tool results") and sits mid-range; the session.ts fallback now uses the shared constant to remove the duplicated magic number.
3. Dynamic compaction chain (existing mechanism, zero changes; argued here to cover the requirement):
   - `resolveSettings` resolves `autoCompactWindow` as `min(explicit config ?? floor(contextWindow × 0.8), contextWindow)`;
   - `session.ts` main loop checks `session.activeTokens > compactPromptTokenThreshold` at the head of every iteration (activeTokens comes from the previous response's real usage stats); exceeding the threshold triggers `compactSession` dynamic compaction;
   - Users can still override explicitly via `settings.contextWindow` / `settings.autoCompactWindow` / `DEEPCODE_CONTEXT_WINDOW` / `DEEPCODE_AUTO_COMPACT_WINDOW`; explicit config takes precedence over model defaults.

Boundaries and regression:

- Qwen3 (<3.8, e.g. qwen3.6-plus / qwen3.7-max) is unaffected and stays 256K (`isQwen38Model` is always false for them);
- The DeepSeek V4 exact-set branch comes first; the 1M default is unchanged;
- Explicit config paths (env / settings) precede model defaults; override semantics unchanged.

## 4. Changed Files (completed after review)

| File | Change |
|---|---|
| `packages/core/src/settings.ts` | `ReasoningEffort` extended to five levels; `resolveReasoningEffort` synced (D1) |
| `packages/core/src/common/model-capabilities.ts` | New `isQwen38Model` (D2) |
| `packages/core/src/common/openai-thinking.ts` | Qwen3 branch rework (D3); `ThinkingRequestOptions` type extension (incl. R16 comment) |
| `packages/core/src/common/openai-client.ts` | `isOpenAIClientHandle` guard widened to five levels (D1) |
| `packages/core/src/providers/openai-provider.ts` | Dual-field reasoning fallback in stream/non-stream (D6) |
| `packages/cli/src/ui/components/ModelsDropdown/index.tsx` | New xhigh / medium options, six-level order (D7) |
| `packages/core/src/tests/settings-and-notify.test.ts` | **Existing assertion update** (R1): L651-664 invalid sample `"medium" as never` → `"ultra"`, test name synced; new five-level parsing cases (§5.3) |
| `packages/cli/src/tests/models-dropdown.test.ts` | **Existing assertion update** (R2): L9-15 four-level order/index assertions → six-level assertions (§5.5); new xhigh/medium cases |
| `docs/configuration.md` / `configuration_en.md` | Five-level docs + Qwen3.8 parameter notes (D8) |
| `docs/quickstart.md` / `quickstart_en.md` | Five-level values synced (D8) |
| `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` / `configuration_en.md` | Five-level docs synced (D8) |
| New tests (enumerated in §5) | — |

**Unchanged**: `session.ts` (main path L1460 already compatible), `openai-message-converter.ts`, `team-adapter.ts` (L681 inherits new behavior through `buildThinkingRequestOptions`), `docs/INSTALL.md` (R7 incidental fix, no edit needed).

## 5. Test Design

Conventions: node:test + `node:assert/strict`, Chinese-style detailed comments in code, `assert.deepStrictEqual` for all request-body assertions (loose `deepEqual` not used for bodies). New test files go in `packages/core/src/tests/` (top-level glob), `packages/core/src/providers/tests/` (recursive glob), or `packages/cli/src/tests/` — all auto-discovered; **no package.json changes needed**.

### 5.1 `qwen38-model-capabilities.test.ts` (core, new, unit)

`isQwen38Model` decisions (supports §6 #1):

- T1 `"Qwen/Qwen3.8-27B-FP8"` → true
- T2 `"qwen3.8-27b"` / `"qwen3.8-plus"` / `"qwen3.8-max-preview"` / `"qwen3.9-70b"` / `"QWEN/QWEN3.8-27B"` → true (case / prefix / later versions)
- T3 `"qwen3-8b"` / `"Qwen3-32B"` / `"qwen3.5-72b"` / `"qwen3.7-max"` → false (no dot, no false positive; 3.5/3.7 not 3.8+)
- T4 `"qwen38-10b"` → false (no dot, no match)
- T5 `""` / `"  "` → false; `"qwen2.5-72b"` → false (not Qwen3)
- T6 Subset property: every T1/T2 sample also satisfies `isQwen3Model(...) === true` (guaranteed by construction under the anchored regex)
- T7 `"qwen3.10-plus"` → true (two-digit minor=10, verifies `\d+` captures the full number)
- T8 `"qwen3.7.9-xxx"` → false (patch suffix; first segment 7 < 8)
- T9 `"qwen3.8.1-xxx"` → true (multi-decimal; first segment 8)
- T10 `"qwen30-8b"` → `isQwen38Model === false` and `isQwen3Model === true` (dual-function fork boundary: must land in the old Qwen3 branch)
- T11 `"  qwen3.8-plus  "` (surrounding spaces) → true (trim behavior pinned)
- T12 `"qwen3.8"` (no `-` suffix) → true (bare prefix name matches)

### 5.2 `qwen38-thinking.test.ts` (core, new, unit)

`buildThinkingRequestOptions` mapping matrix (supports §6 #2, #4), all `deepStrictEqual`:

- T1 Qwen3.8 thinking=true effort=max → `{ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }, reasoning_effort: "xhigh" }` (max clamped to xhigh)
- T2 effort=high → `reasoning_effort: "medium"` (down-clamp mapping)
- T3 effort=xhigh → `"xhigh"`; effort=medium → `"medium"`; effort=low → `"low"` (pass-through levels)
- T4 Qwen3.8 thinking=false (effort=xhigh) → exactly `{ chat_template_kwargs: { enable_thinking: false } }`, plus negative assertions `!("reasoning_effort" in result)`, `!("preserve_thinking" in result.chat_template_kwargs)`
- T5 Old Qwen3 ("qwen3-8b") thinking=true → exactly `{ chat_template_kwargs: { enable_thinking: true } }` (zero regression)
- T6 Old Qwen3 ("Qwen3-30B-A3B") thinking=false → exactly `{ chat_template_kwargs: { enable_thinking: false } }`
- T7 Fork boundary ("qwen30-8b") thinking=true → old branch (same shape as T5)
- T8 Non-thinking model ("gpt-4o") thinking=true → `{}`
- T9 DeepSeek regression ("deepseek-v4-pro") thinking=true → `thinking: { type: "enabled" }` + `extra_body.reasoning_effort`, and **no** `chat_template_kwargs` / top-level `reasoning_effort`
- T10 DeepSeek regression thinking=false → `thinking: { type: "disabled" }`, no extra_body

### 5.3 `settings-and-notify.test.ts` extension (core, existing file, unit)

reasoningEffort parsing (supports §6 #2), black-box assertions on `resolveSettings(...)` results:

- T1 userSettings `reasoningEffort: "xhigh"` → resolved `"xhigh"`
- T2 userSettings `reasoningEffort: "medium"` → resolved `"medium"`
- T3 Invalid values `"ultra"` / `"XHIGH"` (uppercase) / `" high"` (spaced) → resolved falls back to `"max"` (strict literal, case-sensitive)
- T4 systemEnv `REASONING_EFFORT: "xhigh"` penetration → resolved `"xhigh"`
- T5 Precedence regression: systemEnv `"low"` overrides userSettings `"high"` → resolved `"low"`
- T6 **Existing assertion update**: L651-664 test's invalid sample `"medium" as never` → `"ultra"`, assertion stays `"max"`, test name changed to `defaults invalid reasoning effort (ultra) to max`

### 5.4 `qwen38-handle-guard.test.ts` (core, new, unit)

`isOpenAIClientHandle` five-level guard (supports §6 #6). **Must pass a full handle** (the four required fields client/model/baseURL/thinkingEnabled):

- T1 Positive: full handle + `reasoningEffort: "xhigh"` → true; `"medium"` → true
- T2 Positive regression: `"low"` / `"high"` / `"max"` → true (old values must not be rejected after the widening)
- T3 Negative: `reasoningEffort: "ultra"` → false; `"xHIGH"` (case-sensitive) → false
- T4 Missing `client` key → false (guard baseline regression)

### 5.5 `models-dropdown.test.ts` extension (cli, existing file, unit)

(supports §6 #6) `getThinkingOptionIndex` is exported via the `../ui` barrel; call it as a pure function:

- T1 **Existing assertion update**: `MODEL_COMMAND_THINKING_OPTIONS.map(option => option.reasoningEffort)` deepEqual `["xhigh", "max", "high", "medium", "low", undefined]`
- T2 `getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "xhigh" })` → 0; `"medium"` → 3
- T3 `getThinkingOptionIndex({ thinkingEnabled: true, reasoningEffort: "unknown" })` → 0 (fallback-to-0 regression)
- T4 `{ thinkingEnabled: false }` → 5 (No thinking item regression)

### 5.6 `qwen38-integration.test.ts` (core, new, provider-level scenario integration)

Stub rule (no mocks / no simplification): reuse the `TestableOpenAILLMClient` pattern from `packages/core/src/providers/tests/openai-stream.test.ts` — subclass `OpenAILLMClient` and override `getUnderlyingOpenAI()` to return a **fixed-response stub against the real interface contract** (`chat.completions.create` records params and yields realistically shaped chunks); not a mock, does not bypass the constructor.

- S1 Qwen3.8 thinking=true body (supports §6 #2): settings `model: "qwen3.8-plus"`, `thinkingEnabled: true`, `reasoningEffort: "xhigh"`, call `createMessageStream` → captured `params` contains top-level `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` and `reasoning_effort: "xhigh"` (deepStrictEqual)
- S2 thinking=false negative (supports §6 #3): `thinkingEnabled: false` → `params` contains exactly `{ chat_template_kwargs: { enable_thinking: false } }` and `!("reasoning_effort" in params)`
- S3 Dual-field fallback (supports §6 #5): the stub yields `{ delta: { reasoning_content: "A" } }` and, in a second stream, `{ delta: { reasoning: "B" } }` → the provider emits non-empty `thinking_delta` events in both
- S4 Multi-turn replay + preserve_thinking co-occurrence (supports §6 #2 semantic consistency): a history assistant message with `messageParams: { reasoning_content: "previous thinking" }`, through the provider `buildMessages` → `params.messages` retains `reasoning_content` on that message, and the same body contains `preserve_thinking: true`

### 5.7 `team-adapter-llm.test.ts` extension (core, existing file, S5 scenario integration)

Supports §6 #2 for the team call path (of the three `buildThinkingRequestOptions` call sites, only DeepSeek is currently covered):

- S5 Reuse the file's existing `buildStubClient()`, build a handle `{ model: "qwen3.8-plus", thinkingEnabled: true, reasoningEffort: "xhigh", client: stub }` and drive executeDispatch → captured body contains `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }` and `reasoning_effort: "xhigh"` (deepStrictEqual, field by field)

### 5.8 `qwen38-docs-consistency.test.ts` (core, new, doc consistency)

Automated support for §6 #8:

- T1 `fs.readFileSync` `docs/configuration.md` and `docs/configuration_en.md`; assert the text contains the five level literals `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` and `preserve_thinking`
- T2 Same check on `packages/core/templates/skills/bundled/deepcode-self-refer/references/configuration.md` (bundled skill docs ship with the package; prevents "code changed, docs not")

### 5.9 Full regression (zero-regression red lines)

- `cd packages/core && npm test` and `cd packages/cli && npm test` fully pass;
- **The following files must not be modified after D3** (any change is a regression): `qwen3-thinking.test.ts` (all model names take the <3.8 old branch), `qwen3-model-capabilities.test.ts` (existing 3.6/3.7 cases unchanged; only a new isQwen38Model group), `openai-thinking.test.ts` (DeepSeek), `session-skill-matching-safety.test.ts` (L248 Qwen3.6 `{enable_thinking:false}`).

### 5.10 Implementation order (avoid false-red misdiagnosis)

1. First update the two existing test assertion sites: R1 (settings-and-notify.test.ts) and R2 (models-dropdown.test.ts);
2. Then make the D1-D8 functional changes + new tests;
3. Finally run the full core + cli regression.

### 5.11 Qwen3.8+ default context window (D9, v1.3 increment, unit)

Located in `settings-and-notify.test.ts` (where the existing contextWindow parsing cases live):

- W1 `model: "Qwen/Qwen3.8-27B-FP8"` with no explicit config → `contextWindow === 131072` and `autoCompactWindow === 104857` (floor(131072×0.8));
- W2 `model: "qwen3.8-plus"` same as above (series-level inference, not a 27B-specific hardcode);
- W3 Regression: `model: "qwen3.7-max"` → 256K / 209715 (<3.8 unaffected); `model: "deepseek-v4-flash"` → 1M / 838860;
- W4 Explicit override: settings `contextWindow: "512k"` → `contextWindow === 524288` and `autoCompactWindow === 419430` (explicit config takes precedence over model defaults);
- W5 Upstream assertion sync: after the default autoCompactWindow ratio moves 50% → 80%, four existing assertions ("derives model-specific defaults", "derives auto compact window from the configured context window", "ignores invalid windows", "skips invalid higher-priority") are updated to `floor(contextWindow × 0.8)`.

## 6. Acceptance Criteria

| # | Criterion | Test support |
|---|---|---|
| 1 | `isQwen38Model` correct on all §5.1 T1-T12 samples (two-digit minor, patch suffix, fork boundary, trim) | §5.1 |
| 2 | Qwen3.8 thinking body contains `enable_thinking: true` + `preserve_thinking: true` + top-level `reasoning_effort`, full five-level mapping table (D3) covered, effective at both session-level and team-level call sites | §5.2 T1-T4 + §5.6 S1 + §5.7 S5 |
| 3 | Qwen3.8 non-thinking body contains only `enable_thinking: false`, with **no** residual reasoning_effort / preserve_thinking fields | §5.2 T4 + §5.6 S2 |
| 4 | Old Qwen3 (<3.8, incl. the qwen30-8b fork boundary) bodies byte-identical to v1.1 | §5.2 T5-T7 + §5.9 red-line files untouched |
| 5 | DeepSeek V4 request shape unchanged | §5.2 T9-T10 + openai-thinking.test.ts untouched |
| 6 | Five levels parse via settings (incl. invalid-value fallback to max), pass the handle guard (old-three positive + new-two + invalid negative), and are selectable among the six UI items | §5.3 + §5.4 + §5.5 |
| 7 | openai-provider streaming yields `thinking_delta` for both `reasoning` and `reasoning_content` fields | §5.6 S3 |
| 8 | core + cli full test suites pass; `docs/configuration*.md` and the bundled skill reference docs consistent with the implementation | §5.9 + §5.8 |
| 9 | Qwen3.8+ series default context window 128K with an 80% auto-compaction threshold (104857, dynamically triggered by real usage; mid-range of the 70–92% industry band); Qwen3 <3.8 and DeepSeek V4 defaults unchanged; explicit config takes precedence | §5.11 |

## 7. Out of Scope (recorded, not implemented)

- **Video input**: the model understands video, but CLI input channels are text/image; out of scope here;
- **Auto-injection of recommended sampling params** (D5): see §3-D5 decision (architect approved the YAGNI rejection);
- **1M context extension**: requires server-side RoPE extension config the CLI cannot control; keep the 256K default;
- **MTP (multi-token prediction)**: server-side inference optimization, unrelated to the request protocol.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Older vLLM versions may not know `preserve_thinking` | The param passes through `chat_template_kwargs` into the jinja template; undeclared template variables are silently ignored — no 400 risk (same channel as enable_thinking) |
| Some deployments may not know top-level `reasoning_effort` | The OpenAI SDK passes unknown fields through; vLLM ignores undeclared params; only sent when thinking=true |
| Top-level `reasoning_effort: "xhigh"` accidentally sent to OpenAI official endpoints would 400 | R16: type comment explicitly marks "produced only by the Qwen3.8+ branch, do not promote"; §5.2 T8 pins zero-field behavior for non-Qwen models |
| Five-level scale interacting with DeepSeek extra_body scale | DeepSeek branch stays as-is (L64-70 untouched); xhigh/max pass through extra_body unchanged on the DeepSeek path; server behavior is deployment-defined, no new clamping |
| Whether historical thinking blocks enter the prompt depends on both sides | D8 documents the dual relationship between the CLI's unconditional replay and the server-side `preserve_thinking` default (R5); §5.6 S4 pins the co-occurrence assertion |
| Multi-turn thinking on→off→on | `chat_template_kwargs` is per-request stateless; no server-side residue; when re-enabled, reasoning_effort is re-mapped from current settings (expected behavior) |
| UI option list too long | Six items ordered by strength descending, xhigh on top (Qwen3.8 default), No thinking last; maxVisible=6 fits exactly |
| Change rollback-ability (Karpathy principles) | No new abstraction layer, no new dependencies; `isQwen38Model` is false for all pre-existing model names — when no 3.8+ name appears, the full chain is byte-identical to v1.1, and each file rolls back independently |
