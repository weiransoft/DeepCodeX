/**
 * 生成物图片的内联渲染（a2ui/image-src + parser 的裸路径识别）
 *
 * ## 为什么这件事需要测
 *
 * 助手生成图片后给的是磁盘路径。`<img src="/Users/x/out.png">` 在浏览器里
 * 会被当成站内相对地址去请求，必然 404——图就在机器上，对话里却显示不出来。
 * 把路径改写成 `/api/files/raw?...` 是个纯字符串操作，但**判定边界必须稳**：
 * 判宽了会把正文里的普通文件名当成图片去请求，判窄了生成物还是看不见。
 *
 * ## 两个反例同样是需求
 *
 * - 已经是网络地址 / data: / blob: 的不能改写，否则本来能显示的图反而坏掉；
 * - 一行里有多个路径（文件清单）或带空格（一句正文）不能当图片，
 *   否则用户会看到一串莫名其妙的图片占位。
 *
 * @module tests/a2ui-image-src
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalImagePath, localImageSrc, resolveImageSrc } from "../web/src/a2ui/image-src";
import { parseMarkdownToA2ui } from "../web/src/a2ui/parser";

test("E1 绝对路径、相对路径、裸文件名都算本地图片", () => {
  for (const url of [
    "/Users/me/out.png",
    "/tmp/chart.svg",
    "./figures/a.webp",
    "../shots/b.jpg",
    "out.png",
    "charts/monthly.svg",
  ]) {
    assert.equal(isLocalImagePath(url), true, `${url} 应识别为本地图片`);
  }
});

test("E2 网络地址、内嵌数据、对象地址不改写", () => {
  for (const url of [
    "https://example.com/a.png",
    "http://127.0.0.1:3210/x.jpg",
    "data:image/png;base64,AAAA",
    "blob:http://localhost/abc",
    "//cdn.example.com/a.png",
  ]) {
    assert.equal(isLocalImagePath(url), false, `${url} 不应被改写`);
  }
});

test("E3 非图片扩展名、锚点、站内接口不改写", () => {
  for (const url of ["/tmp/a.md", "README.txt", "#anchor", "/api/files/raw?path=x.png", ""]) {
    assert.equal(isLocalImagePath(url), false, `${url} 不应被当作本地图片`);
  }
});

test("E4 带查询串/锚点的本地图片仍能识别", () => {
  assert.equal(isLocalImagePath("/tmp/a.png?raw=1"), true);
  assert.equal(isLocalImagePath("/tmp/a.png#fig"), true);
});

test("E5 改写后的地址走 raw 端点，路径被 URL 编码", () => {
  const src = localImageSrc("/Users/me/图 1.png");
  assert.ok(src.startsWith("/api/files/raw?scope=shared&path="));
  // 空格必须编码，否则 img 请求会被截断
  assert.ok(src.includes("%20") || src.includes("%E5"), "路径需要编码");
  assert.equal(src.includes(" "), false);
});

test("E6 personal 作用域能正确落到参数上", () => {
  const src = localImageSrc("out.png", "personal");
  assert.ok(src.includes("scope=personal"));
});

test("E7 resolveImageSrc 对网络地址原样返回", () => {
  const url = "https://example.com/a.png";
  assert.equal(resolveImageSrc(url), url);
});

test("E8 parser：Markdown 图片语法里的本地路径被翻译成 raw 地址", () => {
  const messages = parseMarkdownToA2ui("![示意图](/tmp/out.png)", "s");
  const json = JSON.stringify(messages);
  assert.ok(json.includes("/api/files/raw?"), "应改写成内联地址");
  assert.ok(json.includes("%2Ftmp%2Fout.png"), "原始路径应被编码后带入");
});

test("E9 parser：整行只有一个图片路径时也渲染成图片", () => {
  const messages = parseMarkdownToA2ui("/tmp/chart.png", "s");
  const json = JSON.stringify(messages);
  assert.ok(json.includes('"Image"'), "裸路径应生成 Image 组件");
  assert.ok(json.includes("/api/files/raw?"), "应走内联地址");
});

test("E10 parser：一行多个路径（文件清单）不当作图片", () => {
  const messages = parseMarkdownToA2ui("/tmp/a.png /tmp/b.png", "s");
  const json = JSON.stringify(messages);
  assert.equal(json.includes('"Image"'), false, "多路径行应保持文本");
});

test("E11 parser：正文里提到图片路径（带空格）不当作图片", () => {
  const messages = parseMarkdownToA2ui("已生成 /tmp/a.png 请查收", "s");
  const json = JSON.stringify(messages);
  assert.equal(json.includes('"Image"'), false, "带空格的句子不该变成图片");
});

test("E12 parser：网络图片地址保持原样", () => {
  const messages = parseMarkdownToA2ui("![x](https://example.com/a.png)", "s");
  const json = JSON.stringify(messages);
  assert.ok(json.includes("https://example.com/a.png"));
  assert.equal(json.includes("/api/files/raw?"), false);
});
