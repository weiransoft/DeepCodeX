import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

/**
 * UnderstandImage 工具：分析本地图片并返回文字结论。
 *
 * 隐私加固（2026-09-17 审计）——重新设计：
 * 旧实现将用户图片整文件上传至厂商插件服务器
 * （https://deepcode.vegamo.cn/api/plugin/understand-image），截图中的代码、
 * 密钥、内网地址等敏感信息存在外泄风险，且上传行为由 LLM 自主触发，用户无感知。
 *
 * 新实现复用用户已配置 LLM 的多模态能力（OpenAI 兼容 chat.completions 接口）：
 * 图片以 base64 data URI 直接进入用户自己选定模型的请求体，数据仅流向用户的
 * 模型 baseURL（与会话对话同级别的外发），不再向任何外部插件地址发起请求，
 * 也不再携带 machineId / PLUS-API-KEY 等遥测或计费凭据。
 */

/** 单张图片大小上限：10 MiB（防止超大文件撑爆 base64 编码后的请求体） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 支持的图片扩展名 → MIME 类型映射（多模态接口的通用支持范围） */
const MIME_TYPE_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export async function handleUnderstandImageTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  context.signal?.throwIfAborted();
  // 参数校验：prompt 与 image_path 均为必填，路径必须为绝对路径
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const imagePath = typeof args.image_path === "string" ? args.image_path.trim() : "";

  if (!prompt) {
    return toolError('Missing required "prompt" string.');
  }
  if (!imagePath) {
    return toolError('Missing required "image_path" string.');
  }
  if (!path.isAbsolute(imagePath)) {
    return toolError('"image_path" must be an absolute path.');
  }

  // 格式校验：仅支持多模态接口通用的 JPEG / PNG / WebP
  const mimeType = MIME_TYPE_BY_EXTENSION.get(path.extname(imagePath).toLowerCase());
  if (!mimeType) {
    return toolError("Unsupported image format. Only JPEG, PNG, and WebP are supported.");
  }

  // 文件校验：必须存在、为常规文件、非空且不超过大小上限
  let stat: fs.Stats;
  try {
    stat = fs.statSync(imagePath);
  } catch (error) {
    context.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Unable to access image: ${message}`);
  }
  if (!stat.isFile()) {
    return toolError('"image_path" must point to a regular file.');
  }
  if (stat.size === 0) {
    return toolError("Image file must not be empty.");
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return toolError("Image file exceeds the 10 MiB limit.");
  }

  // 读取图片文件（尊重中断信号），随后通过用户自有 LLM 的多模态通道分析
  const activityId = `understand-image-${randomUUID()}`;
  context.onProcessStart?.(activityId, `UnderstandImage: ${path.basename(imagePath)}`);
  try {
    const image = await fs.promises.readFile(imagePath, { signal: context.signal });
    context.signal?.throwIfAborted();

    // 获取当前会话的 LLM 客户端（与主对话共用同一 baseURL / apiKey / model）
    const llm = context.createOpenAIClient?.();
    if (!llm?.client) {
      return toolError("UnderstandImage requires a configured LLM client. Check your API key and model settings.");
    }

    // 构造多模态消息：文本指令 + base64 data URI 图片（与 ReadImage 注入方式一致）
    const dataUri = `data:${mimeType};base64,${image.toString("base64")}`;
    const response = await llm.client.chat.completions.create(
      {
        model: llm.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
      },
      { signal: context.signal }
    );
    context.signal?.throwIfAborted();

    // 解析模型回复：兼容纯文本与分段数组两种 content 形态
    const content = extractResponseContent(response);
    if (!content.trim()) {
      return toolError("The image understanding response was empty.");
    }

    return {
      ok: true,
      name: "UnderstandImage",
      output: content.trim(),
      metadata: { imagePath },
    };
  } catch (error) {
    context.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`UnderstandImage request failed: ${message}`);
  } finally {
    context.onProcessExit?.(activityId);
  }
}

/**
 * 从 chat.completions 响应中提取文字内容。
 *
 * @param response OpenAI 兼容的 chat.completions 响应对象
 * @returns 拼接后的文字内容；无法识别的结构返回空字符串
 */
function extractResponseContent(response: unknown): string {
  const message = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  // 多段 content（text 分片数组）：按顺序拼接所有 text 字段
  if (Array.isArray(content)) {
    return (content as Array<{ text?: unknown }>)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function toolError(error: string): ToolExecutionResult {
  return { ok: false, name: "UnderstandImage", error };
}
