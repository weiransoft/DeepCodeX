/**
 * 内联权限审批卡片（R7，设计文档 §4）。
 *
 * 对应 SSE permission_request 事件中的单个请求：
 * 展示工具名 / 命令 / 描述 / 申请权限范围，提供 允许 / 拒绝 按钮；
 * 决策经 POST /api/chats/:id/messages {permissions: [...]} 回注引擎。
 * 决策提交后卡片保留在对话流中并展示决策结果（可追溯，不可重复提交）。
 */
import { BanIcon, ShieldCheckIcon, WrenchIcon } from "./icons";
import type { PermissionRequest } from "../sse";

/** PermissionCard 组件属性 */
export interface PermissionCardProps {
  /** 待审批请求 */
  request: PermissionRequest;
  /** 已做出的决策（有值时卡片进入只读展示态） */
  decided?: "allow" | "deny";
  /** 决策提交中（禁用按钮防重复提交） */
  submitting?: boolean;
  /** 决策回调（仅 undecided 状态下按钮可点） */
  onDecide: (toolCallId: string, decision: "allow" | "deny") => void;
}

/** PermissionCard：内联审批卡片 */
export function PermissionCard({ request, decided, submitting, onDecide }: PermissionCardProps): React.JSX.Element {
  return (
    <div className={`perm-card${decided !== undefined ? " perm-card-decided" : ""}`}>
      {/* 标题行：工具名 + 状态徽标 */}
      <div className="perm-card-head">
        <WrenchIcon size={15} className="perm-card-tool-icon" />
        <span className="perm-card-tool-name">{request.name}</span>
        {decided === undefined ? (
          <span className="perm-badge perm-badge-pending">待审批</span>
        ) : decided === "allow" ? (
          <span className="perm-badge perm-badge-allow">已允许</span>
        ) : (
          <span className="perm-badge perm-badge-deny">已拒绝</span>
        )}
      </div>

      {/* 命令行（有 command 时直显，等宽字体） */}
      {typeof request.command === "string" && request.command !== "" && (
        <div className="perm-card-command">
          <code>{request.command}</code>
        </div>
      )}

      {/* 描述与申请的权限范围 */}
      {typeof request.description === "string" && request.description !== "" && (
        <div className="perm-card-desc">{request.description}</div>
      )}
      {Array.isArray(request.scopes) && request.scopes.length > 0 && (
        <div className="perm-card-scopes">
          {request.scopes.map((s) => (
            <span key={s} className="perm-scope-chip">
              {s}
            </span>
          ))}
        </div>
      )}

      {/* 操作区：未决策时展示 允许/拒绝；已决策/提交中禁用 */}
      {decided === undefined && (
        <div className="perm-card-actions">
          <button
            type="button"
            className="perm-btn perm-btn-allow"
            disabled={submitting === true}
            onClick={() => onDecide(request.toolCallId, "allow")}
          >
            <ShieldCheckIcon size={14} />
            允许
          </button>
          <button
            type="button"
            className="perm-btn perm-btn-deny"
            disabled={submitting === true}
            onClick={() => onDecide(request.toolCallId, "deny")}
          >
            <BanIcon size={14} />
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
