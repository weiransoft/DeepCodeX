export const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

export const NON_MULTIMODAL_MODELS = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-chat",
  "deepseek-reasoner",
]);

export type MultimodalMode = "default" | "on" | "off";

export function defaultsToThinkingMode(model: string): boolean {
  return DEEPSEEK_V4_MODELS.has(model);
}

/**
 * Whether the given model supports multimodal (image) content.
 *
 * `mode` is the resolved `multimodal` configuration:
 * - `"on"`: always treat the model as multimodal.
 * - `"off"`: always treat the model as non-multimodal.
 * - `"default"` (or omitted): infer from the known model list.
 */
export function supportsMultimodal(model: string, mode: MultimodalMode = "default"): boolean {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return !NON_MULTIMODAL_MODELS.has(model.trim());
}
