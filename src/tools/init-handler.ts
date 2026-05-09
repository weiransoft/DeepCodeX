import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { buildDiffPreview, ensureParentDirectory, normalizeContent, readTextFileWithMetadata, writeTextFile } from "./file-utils";
import { executeValidatedTool } from "./runtime";

const initSchema = z.strictObject({
  content: z.string().min(1, "content is required.")
});

export async function handleInitTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return executeValidatedTool(
    "Init",
    initSchema,
    args,
    context,
    async (input) => {
      const filePath = path.join(context.projectRoot, "AGENTS.md");
      const normalizedContent = normalizeContent(input.content);
      const existingMetadata = fs.existsSync(filePath)
        ? readTextFileWithMetadata(filePath)
        : null;

      try {
        ensureParentDirectory(filePath);
        const lineEndings =
          existingMetadata?.lineEndings ??
          (input.content.includes("\r\n") ? "CRLF" : "LF");
        const encoding = existingMetadata?.encoding ?? "utf8";
        const diffPreview = buildDiffPreview(
          filePath,
          existingMetadata?.content ?? null,
          normalizedContent
        );
        const bytes = writeTextFile(filePath, normalizedContent, encoding, lineEndings);

        return {
          ok: true,
          name: "Init",
          output: existingMetadata
            ? "Updated AGENTS.md."
            : "Created AGENTS.md.",
          metadata: {
            file_path: filePath,
            type: existingMetadata ? "update" : "create",
            bytes,
            encoding,
            line_endings: lineEndings,
            diff_preview: diffPreview
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: "Init",
          error: message
        };
      }
    }
  );
}
