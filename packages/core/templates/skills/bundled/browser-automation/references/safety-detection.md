# 浏览器自动化安全检测（详细参考）

本文件收纳 `browser-automation` Skill 的危险操作关键词检测实现示例。
SKILL.md 仅保留安全红线规则表，详细 TS 实现集中在本文件，便于：

- 减少 SKILL.md 的 token 消耗
- 避免关键词列表与函数签名随代码演进不同步
- 让 SKILL.md 聚焦于"安全规则 + 工作流"

## 危险操作关键词检测

在 `fill` / `fill_form` / `click` 等可能触发副作用的工具调用前，必须执行危险操作检测：

```typescript
// 危险操作关键词检测（在 fill/fill_form/click 前检查）
const DANGEROUS_KEYWORDS = [
  "delete", "remove", "clear", "reset", "destroy", "drop",
  "pay", "checkout", "purchase", "transfer",
];

const SENSITIVE_INPUT_TYPES = ["password", "credit-card", "cvv"];

// 检测到危险操作时调用 AskUserQuestion
if (isDangerousAction(action)) {
  await askUserQuestion({
    question: `检测到敏感操作：${action.description}，是否继续？`,
    options: ["确认执行", "取消操作"],
  });
}
```

## 检测规则映射

| 场景 | 触发条件 | 检测字段 |
|------|---------|---------|
| 凭据输入 | `input.type === "password"` 或支付页面 | `SENSITIVE_INPUT_TYPES` |
| 删除类操作 | 按钮/链接文本命中 `DANGEROUS_KEYWORDS` | `delete/remove/clear/reset/destroy/drop` |
| 支付操作 | URL 或按钮文本命中支付关键词 | `pay/checkout/purchase/transfer` |
| CAPTCHA | 页面存在 CAPTCHA 元素 | reCAPTCHA / hCaptcha / 腾讯验证码 |

## 检测后处置

| 检测结果 | 处置方式 |
|----------|---------|
| 命中 `DANGEROUS_KEYWORDS` | 调用 `AskUserQuestion` 请求用户确认 |
| 命中 `SENSITIVE_INPUT_TYPES` | 调用 `AskUserQuestion` 请求用户确认 |
| 检测到 CAPTCHA | 立即停止自动化，提示用户手动处理 |
| 命中支付关键词 | 立即停止自动化流程 |
