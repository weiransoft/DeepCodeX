export const INIT_AGENT_GUIDE_PROMPT = `Generate a project agent guide and save it to AGENTS.md in the current project root.

Your goal is to inspect this repository, understand its actual structure and conventions, then produce a clear, concise, well-structured Markdown document that helps future agents contribute effectively.

Important workflow:
- First inspect the repository layout and metadata so the guide reflects the actual project rather than generic defaults.
- Use available tools such as bash and read to examine files like package manifests, README files, source directories, tests, and recent git history.
- When the guide is ready, call the Init tool with the complete Markdown content. The Init tool writes the file to AGENTS.md in the current project root.

Document requirements:
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful, such as commands, directory paths, and naming patterns.
- Maintain a professional, instructional tone.

Recommended sections:
- Project Structure & Module Organization: Outline the project structure, including where source code, tests, docs, and assets are located.
- Build, Test, and Development Commands: List key commands for building, testing, and running locally, and briefly explain each.
- Coding Style & Naming Conventions: Specify indentation, language-specific style preferences, naming patterns, and formatting or linting tools used.
- Testing Guidelines: Identify test frameworks, coverage expectations, test naming conventions, and how to run tests.
- Commit & Pull Request Guidelines: Summarize commit message conventions from git history and outline PR requirements.
- Optional sections if relevant: Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.

Do not stop after drafting the content in chat. Save the final Markdown by calling the Init tool.`;

export function buildInitPrompt(): string {
  return INIT_AGENT_GUIDE_PROMPT;
}
