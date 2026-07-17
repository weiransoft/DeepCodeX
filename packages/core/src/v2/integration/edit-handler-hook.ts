/**
 * V2 编辑工具结果钩子
 *
 * 在 edit/write 工具执行后，使用 enhanceDiffPreview 生成增强的 diff 预览，
 * 替换原有的简单 diff_preview 字段。
 *
 * 设计依据：
 * - V2-P0a 钩子集成模块
 * - 与 edit-handler.ts 的 metadata.old_content / metadata.new_content 字段配合
 * - 大文件降级保护：当 old_content/new_content 为 null 时回退使用原 diff_preview
 *
 * 命名说明（V2.3 P1-04）：
 * - 钩子字段原名 onToolResult，统一更名为 onAfterToolExecution，
 *   与 onBeforeToolExecution 及 V1 文件级钩子（onBeforeFileMutation /
 *   onAfterFileMutation）前缀对称；
 * - 本钩子只在 ToolExecutor 层触发一次，edit 的 diff 增强仅由本钩子执行，
 *   文件级钩子（onAfterFileMutation）不重复处理（详见技术方案 §9.0 钩子命名与触发表）。
 *
 * 钩子契约：
 * - 输入：handler 返回的 ToolExecutionResult + 上下文（toolName + args）
 * - 输出：可能被修改的 ToolExecutionResult（替换 diff_preview，新增 diff_stats 和 diff_hunks）
 * - 向后兼容：非 edit/write 工具、失败结果、缺少 metadata 字段时原样返回
 */

import { enhanceDiffPreview, type DiffPreviewOptions } from "../diff/enhance-diff-preview";
import type { ToolExecutionResult } from "./v1-adapters";

/**
 * 创建编辑工具的 onAfterToolExecution 钩子
 *
 * 返回一个符合 ToolExecutionHooks.onAfterToolExecution 签名的钩子函数，
 * 在 edit/write 工具成功执行后，使用 Myers diff 算法生成增强的 diff 预览。
 *
 * 用法：
 * ```typescript
 * const executor = new ToolExecutor(projectRoot);
 * await executor.executeToolCalls(sessionId, toolCalls, {
 *   onAfterToolExecution: createEditHandlerAfterExecutionHook({ colorEnabled: false, contextLines: 3 }),
 * });
 * ```
 *
 * @param options diff 预览选项（可选，未提供时使用 enhanceDiffPreview 的默认值）
 * @returns onAfterToolExecution 钩子函数
 */
export function createEditHandlerAfterExecutionHook(options?: DiffPreviewOptions) {
  return function editHandlerAfterExecutionHook(
    result: ToolExecutionResult,
    _context: { toolName: string; args: Record<string, unknown> }
  ): ToolExecutionResult {
    // 仅处理 edit 和 write 工具的成功结果
    // 失败结果无 metadata.old_content/new_content，原样返回
    // 非 edit/write 工具不涉及文件内容变更的 diff 增强，原样返回
    if (!result.ok || (result.name !== "edit" && result.name !== "write")) {
      return result;
    }

    // 从 metadata 获取原始内容和新内容
    // 注意：字段名为 snake_case（与 edit-handler.ts 实际返回一致）
    const filePath = result.metadata?.["file_path"] as string | undefined;
    const oldContent = result.metadata?.["old_content"] as string | null | undefined;
    const newContent = result.metadata?.["new_content"] as string | null | undefined;

    // 缺少必要数据时返回原始结果（向后兼容）
    // - filePath 为空：不应发生在 edit/write 工具上，防御性检查
    // - oldContent/newContent 为 undefined：当前工具未输出该字段（如 write 工具未实现）
    // - oldContent/newContent 为 null：edit-handler 的大文件降级保护触发（>256KB）
    if (!filePath || oldContent === undefined || newContent === undefined) {
      return result;
    }
    if (oldContent === null || newContent === null) {
      // 大文件降级保护：原文或新文超过 MAX_INLINE_CONTENT_BYTES（256KB），
      // 此时无法对完整内容做 diff 增强（内存开销过大），回退使用原 diff_preview
      return result;
    }

    // 生成增强 diff 预览
    // 使用 Myers diff 算法计算精确差异，渲染为 unified diff 格式
    const enhanced = enhanceDiffPreview(oldContent, newContent, {
      colorEnabled: options?.colorEnabled ?? false,
      contextLines: options?.contextLines ?? 3,
      maxDiffLines: options?.maxDiffLines ?? 200,
      showLineNumbers: options?.showLineNumbers ?? false,
    });

    // 更新 metadata：
    // - diff_preview：替换为增强后的渲染文本（覆盖原 buildDiffPreview 的简单输出）
    // - diff_stats：新增字段，包含 additions/deletions/changes 统计
    // - diff_hunks：新增字段，包含 hunk 列表（用于 UI 高亮渲染）
    return {
      ...result,
      metadata: {
        ...result.metadata,
        diff_preview: enhanced.rendered,
        diff_stats: enhanced.stats,
        diff_hunks: enhanced.hunks,
      },
    };
  };
}
