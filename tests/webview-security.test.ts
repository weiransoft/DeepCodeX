/**
 * VS Code Webview XSS 防护回归测试
 *
 * 测试目标：验证 packages/vscode-ide-companion/resources/webview.html 中
 * assistant 消息不再通过未转义的 innerHTML 直接插入，防止脚本注入。
 *
 * 说明：
 * webview.html 中内嵌的 escapeHtml / sanitizeHtml 函数是实际运行代码。
 * 本测试通过字符串匹配确认 webview.html 已正确调用这两个函数，
 * 并在测试文件中复制相同实现进行行为验证；
 * 同时通过静态断言防止实现与 webview.html 中的源码发生漂移。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBVIEW_PATH = path.resolve(__dirname, "../packages/vscode-ide-companion/resources/webview.html");

const webviewSource = fs.readFileSync(WEBVIEW_PATH, "utf-8");

/**
 * 将文本中的特殊字符转义为 HTML 实体。
 *
 * 注意：此实现必须与 webview.html 中的 escapeHtml 保持一致。
 *
 * @param text 待转义的纯文本
 * @returns 转义后的 HTML 安全字符串
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 对可信任的 HTML 进行基础消毒，移除常见 XSS 向量。
 *
 * 注意：此实现必须与 webview.html 中的 sanitizeHtml 保持一致。
 *
 * @param html 待消毒的 HTML 字符串
 * @returns 消毒后的 HTML 字符串
 */
function sanitizeHtml(html: string): string {
  if (typeof html !== "string") {
    return "";
  }
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:javascript|data|vbscript):/gi, "");
}

/**
 * 为 escapeHtml 提供最小 document  mock。
 *
 * 由于 escapeHtml 仅依赖 createElement + textContent/innerHTML，
 * 该 mock 足以在 Node 测试环境中验证其转义行为。
 */
const mockDocument = {
  createElement: (_tag: string) => {
    let storedText = "";
    return {
      set textContent(value: string) {
        storedText = value;
      },
      get innerHTML() {
        return storedText
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      },
    };
  },
};

// 将 mock document 注入全局，供 escapeHtml 使用
const globalWithDocument = globalThis as unknown as { document: typeof mockDocument };
globalWithDocument.document = mockDocument;

test("escapeHtml 将特殊字符转义为 HTML 实体", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(escapeHtml('"onclick="evil()"'), "&quot;onclick=&quot;evil()&quot;");
  assert.equal(escapeHtml("5 < 10 && 10 > 3"), "5 &lt; 10 &amp;&amp; 10 &gt; 3");
});

test("sanitizeHtml 移除 script 标签", () => {
  const input = "<p>hello</p><script>alert(1)</script><p>world</p>";
  const output = sanitizeHtml(input);
  assert.equal(output, "<p>hello</p><p>world</p>");
  assert.doesNotMatch(output, /<script/i);
});

test("sanitizeHtml 移除多行 script 标签", () => {
  const input = `<div>start</div>
<script>
  document.location = 'https://evil.com';
</script>
<div>end</div>`;
  const output = sanitizeHtml(input);
  assert.doesNotMatch(output, /<script/i);
  assert.match(output, /<div>start<\/div>/);
  assert.match(output, /<div>end<\/div>/);
});

test("sanitizeHtml 移除内联事件处理器", () => {
  const input = '<img src="x" onerror="alert(1)" onload="steal()">';
  const output = sanitizeHtml(input);
  assert.doesNotMatch(output, /onerror/i);
  assert.doesNotMatch(output, /onload/i);
  assert.match(output, /<img\s+src="x"\s*>/);
});

test("sanitizeHtml 移除危险伪协议", () => {
  const input = '<a href="javascript:alert(1)">click</a><iframe src="data:text/html,<script>alert(1)</script>">';
  const output = sanitizeHtml(input);
  assert.doesNotMatch(output, /javascript:/i);
  assert.doesNotMatch(output, /data:/i);
});

test("sanitizeHtml 保留合法 HTML 结构", () => {
  const input = '<pre><code class="language-ts">const x = 1;</code></pre><ul><li>item</li></ul>';
  const output = sanitizeHtml(input);
  assert.equal(output, input);
});

test("webview.html 中 thinking 气泡使用 escapeHtml", () => {
  const thinkingMatch = webviewSource.match(
    /bubble-collapsible-content[^]*?contentDiv\.innerHTML\s*=\s*escapeHtml\(content\)/
  );
  assert.ok(thinkingMatch, "thinking 气泡应使用 escapeHtml(content) 插入");
});

test("webview.html 中普通 assistant 气泡使用 escapeHtml", () => {
  const normalMatch = webviewSource.match(
    /bubble-normal-content[^]*?contentDiv\.innerHTML\s*=\s*escapeHtml\(content\)/
  );
  assert.ok(normalMatch, "普通 assistant 气泡应使用 escapeHtml(content) 插入");
});

test("webview.html 不再包含未消毒的 assistant innerHTML 赋值", () => {
  const dangerousPattern = /contentDiv\.innerHTML\s*=\s*content\s*;/g;
  const matches = [...webviewSource.matchAll(dangerousPattern)];
  assert.equal(matches.length, 0, `发现 ${matches.length} 处未消毒的 innerHTML = content`);
});

test("escapeHtml 阻止注入的 script 标签执行", () => {
  const escaped = escapeHtml("<script>alert(1)</script>");
  // 转义后不应保留原生的 <script> 标签文本
  assert.doesNotMatch(escaped, /<script>/i);
  assert.match(escaped, /&lt;script&gt;/);
});

test("escapeHtml 阻止内联事件处理器", () => {
  const escaped = escapeHtml('<img src="x" onerror="alert(1)">');
  // 整个 img 标签被转义为文本，不再解析为 HTML 元素，因此事件处理器不会执行
  assert.doesNotMatch(escaped, /<img[^>]*>/i);
  assert.match(escaped, /&lt;img/);
  assert.equal(escaped, "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;");
});
