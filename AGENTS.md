# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript CLI implementation, with tool handlers in `src/tools/`, MCP integration in `src/mcp/`, UI components in `src/ui/`, and shared helpers in `src/common/`.
- `src/tests/` contains Node test files named `*.test.ts`.
- `templates/` contains runtime prompt assets: `templates/prompts/` for EJS prompt templates and `templates/tools/` for tool instruction Markdown loaded into the system prompt.
- `docs/` is reserved for user-facing documentation such as configuration and MCP guides.
- `resources/` stores static images used by the documentation or UI.

## Build, Test, and Development Commands

- `npm test` runs all test files with `tsx --test`.
- `npm run test:single -- src/tests/<name>.test.ts` runs one test file.
- `npm run typecheck` verifies TypeScript types without emitting files.
- `npm run lint` checks ESLint rules for `src/`.
- `npm run build` runs checks, bundles `src/cli.tsx` to `dist/cli.js`, and marks the bundle executable.

## Coding Style & Naming Conventions

- Use TypeScript ES modules and keep imports explicit.
- Prefer small, focused functions; keep filesystem path construction centralized when a path is reused.
- Use two-space indentation and Prettier-compatible formatting.
- Respond in standard technical English. Avoid nonstandard phrasing and corporate jargon.

## Testing Guidelines

- Add or update tests in `src/tests/` when changing command behavior, prompt rendering, session flow, tools, or settings.
- Prefer Node's built-in `node:test` and `node:assert/strict` APIs, matching the existing tests.
- Keep tests deterministic by using temporary directories and mocked network calls where needed.

## Commit & Pull Request Guidelines

- Keep commits focused on a single change and use concise, imperative commit messages.
- In pull requests, describe the behavior change, list verification commands, and note any packaging or template path changes.
