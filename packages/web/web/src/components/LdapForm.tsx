/**
 * LDAP 认证配置表单（系统管理「LDAP 认证」页签）。
 *
 * 受控组件：草稿状态由父级（SettingsDrawer）持有，编辑经 onChange 回写。
 * 绑定口令仅在"修改"时由用户输入并随保存上送，留空表示保持已保存口令不变；
 * 口令仅落本地密钥库（engine:ldapBindPassword），经 DEEPCODE_WEB_LDAP_BIND_PASSWORD
 * 环境变量注入引擎，任何配置文件均不明文存储。
 *
 * 引擎消费键（settings.json web.ldap，与 core WebLdapSettings 对齐）：
 * enabled / server / port / useSsl / bindDn / baseDn / userFilter / timeoutMs / attrs。
 */
import { type DesktopLdapConfig } from "../desktopConfig";

export interface LdapFormProps {
  /** 当前草稿 */
  ldap: DesktopLdapConfig;
  /** 草稿变更回写 */
  onChange: (next: DesktopLdapConfig) => void;
}

export function LdapForm({ ldap, onChange }: LdapFormProps) {
  const patch = (p: Partial<DesktopLdapConfig>) => onChange({ ...ldap, ...p });

  return (
    <div className="cfg-editor">
      <div className="cfg-section-head">
        <h3>LDAP 统一认证</h3>
      </div>

      <label className="cfg-check">
        <input type="checkbox" checked={ldap.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        启用 LDAP 登录（关闭后走本地用户登录）
      </label>

      <div className="cfg-field">
        <label>服务器地址 *</label>
        <input
          type="text"
          value={ldap.server}
          placeholder="ldap.corp.example.com"
          onChange={(e) => patch({ server: e.target.value })}
        />
      </div>

      <div className="cfg-token-row">
        <div className="cfg-field">
          <label>端口</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={ldap.port ?? ""}
            placeholder={ldap.useSsl ? "默认 636" : "默认 389"}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const n = raw === "" ? null : Number(raw);
              patch({ port: n !== null && Number.isFinite(n) ? n : null });
            }}
          />
        </div>
        <label className="cfg-check">
          <input type="checkbox" checked={ldap.useSsl ?? false} onChange={(e) => patch({ useSsl: e.target.checked })} />
          使用 SSL（ldaps://）
        </label>
      </div>

      <div className="cfg-field">
        <label>搜索基准 DN（Base DN）*</label>
        <input
          type="text"
          value={ldap.baseDn}
          placeholder="dc=corp,dc=example,dc=com"
          onChange={(e) => patch({ baseDn: e.target.value })}
        />
      </div>

      <div className="cfg-field">
        <label>服务账号 DN（可选，留空匿名 bind）</label>
        <input
          type="text"
          value={ldap.bindDn ?? ""}
          placeholder="cn=svc-deepcode,ou=service,dc=corp"
          onChange={(e) => patch({ bindDn: e.target.value })}
        />
      </div>

      <div className="cfg-field">
        <label>服务账号密码{ldap.hasBindPassword ? "（已保存）" : "（可选）"}</label>
        <input
          type="password"
          value={ldap.bindPassword ?? ""}
          placeholder={ldap.hasBindPassword ? "已保存，留空保持不变" : "匿名 bind 可留空"}
          autoComplete="new-password"
          onChange={(e) => patch({ bindPassword: e.target.value })}
        />
        <div className="cfg-field-hint">仅存本地密钥库，随引擎启动注入，配置文件不明文保存</div>
      </div>

      <div className="cfg-field">
        <label>用户过滤模板</label>
        <input
          type="text"
          value={ldap.userFilter ?? ""}
          placeholder="(uid=%s)；AD 可用 (sAMAccountName=%s)"
          onChange={(e) => patch({ userFilter: e.target.value })}
        />
        <div className="cfg-field-hint">
          支持 <code>%s</code> 占位替换为登录用户名（自动做 LDAP 注入转义）； 无占位时追加 <code>(uid=用户名)</code>{" "}
          组合过滤。
        </div>
      </div>

      <div className="cfg-token-row">
        <div className="cfg-field">
          <label>连接超时（毫秒）</label>
          <input
            type="number"
            min={1000}
            max={60000}
            value={ldap.timeoutMs ?? ""}
            placeholder="默认 10000"
            onChange={(e) => {
              const raw = e.target.value.trim();
              const n = raw === "" ? null : Number(raw);
              patch({ timeoutMs: n !== null && Number.isFinite(n) ? n : null });
            }}
          />
        </div>
        <div className="cfg-field">
          <label>展示名属性映射</label>
          <input
            type="text"
            value={ldap.displayNameAttr ?? ""}
            placeholder="默认 displayName"
            onChange={(e) => patch({ displayNameAttr: e.target.value })}
          />
        </div>
        <div className="cfg-field">
          <label>邮箱属性映射</label>
          <input
            type="text"
            value={ldap.mailAttr ?? ""}
            placeholder="默认 mail"
            onChange={(e) => patch({ mailAttr: e.target.value })}
          />
        </div>
      </div>

      <p className="cfg-hint">
        启用后登录页将优先尝试 LDAP 认证（服务账号 bind → 搜索用户条目 → 用户 DN + 密码二次验证），LDAP
        不可用时仍可走本地用户兜底。保存后约 5 秒内自动生效，
        无需重启引擎；本地账号（本地用户名单内）登录始终直连本地校验。
      </p>
    </div>
  );
}
