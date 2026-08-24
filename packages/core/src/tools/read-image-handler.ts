import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionFollowUpMessage, ToolExecutionResult } from "./executor";
import { markFileRead } from "../common/state";
import { MAX_IMAGE_BYTES, normalizeImage, type ImageMediaType, type NormalizedImage } from "./image-normalizer";
import { resolveReadFilePath } from "./read-handler";

const MIME_TYPE_BY_EXTENSION = new Map<string, ImageMediaType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export async function handleReadImageTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const resolved = resolveReadFilePath(args.file_path, context.projectRoot);
  if (!resolved.ok) {
    return toolError(resolved.error);
  }
  const filePath = resolved.filePath;
  const declaredMediaType = MIME_TYPE_BY_EXTENSION.get(path.extname(filePath).toLowerCase());
  if (!declaredMediaType) {
    return toolError("Unsupported image format. Only PNG, JPEG, WebP, and GIF are supported.");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Failed to stat image: ${message}`);
  }
  if (!stat.isFile()) {
    return toolError('"file_path" must point to a regular file.');
  }
  if (stat.size === 0) {
    return toolError("Image file must not be empty.");
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return toolError("Image file exceeds the 20 MiB source limit.");
  }

  try {
    const source = await fs.promises.readFile(filePath);
    const sharp = context.loadSharp ? await context.loadSharp() : (await import("sharp")).default;
    const image = await normalizeImage(source, declaredMediaType, sharp);
    markFileRead(context.sessionId, filePath, {
      content: "",
      timestamp: Math.floor(stat.mtimeMs),
      isPartialView: true,
    });
    return {
      ok: true,
      name: "ReadImage",
      output: formatImageOutput(filePath, image),
      metadata: {
        imagePath: filePath,
        mime: image.mediaType,
        bytes: image.data.length,
        width: image.width,
        height: image.height,
        ...(image.originalDimensions ? { originalDimensions: image.originalDimensions } : {}),
      },
      followUpMessages: [buildImageFollowUpMessage(filePath, image)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Unable to read image: ${message}`);
  }
}

function formatImageOutput(filePath: string, image: NormalizedImage): string {
  let scaled = "";
  if (image.originalDimensions) {
    const x = (image.originalDimensions.width / image.width).toFixed(2);
    const y = (image.originalDimensions.height / image.height).toFixed(2);
    const advice =
      x === y ? `multiply coordinates by ${x}` : `multiply x coordinates by ${x} and y coordinates by ${y}`;
    scaled =
      ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ` +
      `${advice} to locate features in the original file)`;
  }
  return `<path>${filePath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.data.length} bytes${scaled}
</content>`;
}

function buildImageFollowUpMessage(filePath: string, image: NormalizedImage): ToolExecutionFollowUpMessage {
  return {
    role: "user",
    content:
      `The ReadImage tool has loaded \`${path.basename(filePath)}\`. ` +
      "Use the attached image content to answer the original request.",
    contentParams: [
      {
        type: "image_url",
        image_url: {
          url: `data:${image.mediaType};base64,${image.data.toString("base64")}`,
        },
      },
    ],
    visible: false,
  };
}

function toolError(error: string): ToolExecutionResult {
  return { ok: false, name: "ReadImage", error };
}
