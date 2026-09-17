# Repository Guidelines

## Project Structure & Module Organization

npm workspaces monorepo under `packages/`.

- `packages/core/src/` — `session.ts` (LLM loop, streaming, retry, compaction), `tools/` (10 handlers), `common/` (permissions, OpenAI client, capabilities, file history), `mcp/`, `templates/`.
- `packages/cli/src/` — Ink/React TUI (`cli.tsx`, `cli-args.ts`, `ui/`); `packages/vscode-ide-companion/` — VSCode companion.
- `docs/` — user docs; `scripts/` — build/release tooling; `dist/` — bundled output (gitignored).

## Build, Test, and Development Commands

- `npm run check` — typecheck/lint/format; `npm test` — workspace tests.
- `npm run build` — full build; `npm run bundle` — esbuild bundle; `npm run start` — run the CLI.
- Single test: `node --import tsx --test packages/core/src/tests/session.test.ts`.
- Release: `npm run release:version -- <bump>`, then `npm run prepare:package` / `prepare:vscode` (`RELEASE.md`; `v0.4.0`).

## Coding Style & Naming Conventions

- 2-space indent, double quotes, semicolons, `es5` trailing commas, 120-char lines, LF endings; TypeScript strict.
- `import type` for type-only imports; `_` prefix for unused vars; ES2022/ESNext; JSX `react-jsx`.
- Prettier + ESLint; Husky/lint-staged formats staged files. Files: `kebab-case.ts`, `kebab-case.tsx`, `*.test.ts`.

## Testing Guidelines

- Node native test runner (`node:test`) via `tsx` with `node:assert/strict`.
- Tests live in `packages/*/src/tests/`, named after the source module; run `npm test` before PRs.

## Commit & Pull Request Guidelines

- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `style:`, `test:`, `docs:`, `perf:`, `build:`.
- PRs: clear description, linked issues, UI screenshots, passing `npm run check && npm test`, no unintended `dist/`/lockfile changes.

## Architecture Overview

- `@vegamo/deepcode-cli` (Ink TUI) drives the LLM loop via `SessionManager` (`@vegamo/deepcode-core`) over a 180s keep-alive `createOpenAIClient()` with DeepCode Plus fallback.
- Built-in tools: `bash`, `read`, `write`, `edit`, `skill`, `AskUserQuestion`, `UpdatePlan`, `WebSearch`, `ReadImage`, `UnderstandImage`; `read` returns a `snippet_id` for `edit`, and `supportsMultimodal()` picks the matching image tool.
- `bash` bounds output draining after exit/timeout so a held pipe cannot hang a session, captures native cwd on Windows Git Bash; `run_in_background` handles detached work.
- Permissions: 12 scopes including `read-in-tmp`/`write-in-tmp`; `addWorkingDirs` extends the workspace; `file-history.ts` provides undo.
- Models: default `deepseek-flash`; `/model` offers `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` (effort `low`/`high`/`max`).
- Commands: `/skills`, `/model`, `/plan`, `/new`, `/init`, `/resume`, `/fork`, `/continue`, `/undo`, `/mcp`, `/raw`, `/exit`; Plan Mode gates writes behind `<proposed_plan>`.
- CLI flags: `-p`, `-x`, `-r`, `-f`, `-l`, `-v`, `-h`.

## Agent-Specific Instructions

- AGENTS.md loads from `./.deepcode/AGENTS.md`, `./AGENTS.md`, then `~/.deepcode/AGENTS.md` (first wins).
- Skills load from `./.deepcode/skills`, `./.agents/skills`, or `~` equivalents via the `skill` tool. Bundled: `deepcode-self-refer`, `image-generator`, `video-generator` (+`references/`, `scripts/`), `skill-digester`, `skill-writer`.
- File references: `@path/to/file`.
