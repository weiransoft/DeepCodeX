/**
 * 对话流条目模型：历史消息（REST）与 SSE 事件归并后的统一 UI 模型。
 * App 持有 entries 数组并按事件追加/更新，ChatPane 只负责渲染。
 */
import type { PermissionRequest } from "./sse";

/** 用户消息附件（发送时的本地文件 / 从文件抽屉插入的服务器路径） */
export interface UserAttachment {
  /** 展示名（文件名或路径） */
  name: string;
  /** 来源：local=本地选择/粘贴的文件；server=文件抽屉插入的服务器路径 */
  source: "local" | "server";
  /** 是否图片（决定走 imageUrls 还是文本引用） */
  image: boolean;
}

/** 对话流条目（按时间序渲染） */
export type ChatEntry =
  /** 用户消息：乐观上屏（先展示后等待 202） */
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: UserAttachment[];
      createTime?: string;
    }
  /** 助手消息：content 为完整文本（经 A2UI 渲染）；preview 为流式纯文本预览 */
  | {
      kind: "assistant";
      id: string;
      content: string | null;
      preview: string | null;
      /** 本条消息是否已终结（收到 assistant_message 后为 true） */
      done: boolean;
    }
  /** 工具执行进度：折叠条目，raw 保留事件原始字段（不丢信息） */
  | {
      kind: "tool";
      id: string;
      label: string;
      status: string;
      raw: Record<string, unknown>;
    }
  /** 内联权限审批卡片 */
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      decided?: "allow" | "deny";
      /** 决策提交中（防重复点击） */
      submitting: boolean;
    };
