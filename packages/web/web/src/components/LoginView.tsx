/**
 * 登录页（R5，设计文档 §4）：居中卡片（用户名 / 密码 / 登录按钮 / 错误提示）。
 * POST /api/auth/login；401 显示服务端统一错误信息（不泄露内部细节）。
 */
import { useState, type FormEvent } from "react";
import { login } from "../api";

/** LoginView 组件属性 */
export interface LoginViewProps {
  /** 是否为 LDAP 认证源（来自 /api/config；仅用于提示文案，不影响提交行为） */
  ldapEnabled: boolean | null;
  /** 登录成功回调（App 重新拉取用户态） */
  onSuccess: () => void;
}

/** 登录页：居中卡片 */
export function LoginView({ ldapEnabled, onSuccess }: LoginViewProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** 提交登录：成功通知 App；失败展示统一错误（含 401） */
  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (submitting) return;
    if (username.trim() === "" || password === "") {
      setError("请输入用户名和密码");
      return;
    }
    setSubmitting(true);
    setError("");
    login(username.trim(), password)
      .then(() => onSuccess())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "登录失败，请稍后重试");
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        {/* 品牌区 */}
        <div className="login-brand">
          <span className="login-brand-name">DeepCodeX</span>
          <span className="login-brand-sub">Web 对话控制台</span>
        </div>

        <label className="login-field">
          <span className="login-label">用户名</span>
          <input
            className="login-input"
            type="text"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="login-field">
          <span className="login-label">密码</span>
          <input
            className="login-input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        {/* 错误提示（统一 401 文案来自服务端 {error}） */}
        {error !== "" && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="login-submit" disabled={submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>

        {ldapEnabled === true && <div className="login-hint">企业账号请使用 LDAP 域账号登录</div>}
      </form>
    </div>
  );
}
