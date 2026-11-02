/**
 * 对话内全局搜索单测（web/src/search.ts）
 *
 * 覆盖点（对齐用户可见的检索诉求：用户输入 / 模型输出 / 思考 / 修改文件 / 报告）：
 * - 五类内容各自能被检索到，且「思考」不会和「正文」混在同一个类别里；
 * - 工具条目（写文件、跑命令）的可读输出与原始事件都在索引内，文件路径搜得到；
 * - 多关键词 AND、大小写不敏感、空查询无命中；
 * - 片段截断与高亮偏移（snippetMatchStart 必须真的指向命中词）；
 * - 类别筛选、类别计数、命中上限。
 *
 * 全部走真实数据形状（无 mock）：条目对象按 ChatEntry 契约构造。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEntry } from "../web/src/chat-model";
import {
  buildSearchDocuments,
  countHitsByCategory,
  searchEntries,
  tokenizeQuery,
  SEARCH_CATEGORIES,
} from "../web/src/search";

/**
 * 构造用户消息条目
 *
 * @param id 条目 id
 * @param text 正文
 * @param attachments 附件名列表
 * @returns 用户条目
 */
function userEntry(id: string, text: string, attachments: string[] = []): ChatEntry {
  return {
    kind: "user",
    id,
    text,
    attachments: attachments.map((name) => ({ name, source: "local" as const, image: false })),
  };
}

/**
 * 构造助手条目
 *
 * @param id 条目 id
 * @param content 正文（null 表示流式中）
 * @param thinking 思考文本
 * @param preview 流式预览
 * @returns 助手条目
 */
function assistantEntry(
  id: string,
  content: string | null,
  thinking?: string,
  preview: string | null = null
): ChatEntry {
  return { kind: "assistant", id, content, preview, thinking, done: content !== null };
}

/**
 * 构造工具条目（历史形态：raw.content 为引擎序列化的工具结果）
 *
 * @param id 条目 id
 * @param label 工具名（展示标签）
 * @param payload 工具结果对象（会被序列化进 raw.content）
 * @returns 工具条目
 */
function toolEntry(id: string, label: string, payload: Record<string, unknown>): ChatEntry {
  return { kind: "tool", id, label, status: "completed", raw: { content: JSON.stringify(payload) } };
}

// ============================================================================
// S1：用户输入
// ============================================================================

test("S1. 用户输入可命中，附件名同样在索引内", () => {
  const entries: ChatEntry[] = [userEntry("u1", "帮我重构一下登录模块", ["auth-service.ts"])];
  const byText = searchEntries(entries, "登录模块");
  assert.equal(byText.length, 1);
  assert.equal(byText[0]!.category, "user");
  assert.equal(byText[0]!.label, "我的输入");

  const byAttachment = searchEntries(entries, "auth-service");
  assert.equal(byAttachment.length, 1, "附件名应当可检索（用户常按文件名回忆）");
  assert.ok(byAttachment[0]!.snippet.includes("auth-service.ts"));
});

// ============================================================================
// S2：模型输出 与 思考 分属两个类别
// ============================================================================

test("S2. 思考与正文分别入索引，筛选「思考」只出思考", () => {
  const entries: ChatEntry[] = [
    assistantEntry("a1", "最终结论：应当引入缓存层。", "先看是否有并发写入……缓存层能降低重复查询。"),
  ];
  const docs = buildSearchDocuments(entries);
  assert.equal(docs.filter((d) => d.entryId === "a1").length, 2, "正文与思考各自成文档");

  // 「缓存层」两边都出现 → 两条命中，类别不同
  const both = searchEntries(entries, "缓存层");
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((h) => h.category).sort(), ["assistant", "thinking"]);

  // 只搜思考
  const thinkingOnly = searchEntries(entries, "缓存层", { categories: ["thinking"] });
  assert.equal(thinkingOnly.length, 1);
  assert.equal(thinkingOnly[0]!.label, "思考过程");
});

test("S2b. 流式中（content=null）按 preview 检索，仍归入模型输出", () => {
  const entries: ChatEntry[] = [assistantEntry("a2", null, undefined, "正在写入 config.json")];
  const hits = searchEntries(entries, "config.json");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.category, "assistant");
});

// ============================================================================
// S3：工具与文件（「修改文件」的核心场景）
// ============================================================================

test("S3. write 工具的输出里能搜到文件路径，归入「工具与文件」", () => {
  const entries: ChatEntry[] = [
    toolEntry("t1", "write_file", {
      ok: true,
      name: "write_file",
      metadata: { path: "src/auth/session-store.ts", bytesWritten: 2048 },
    }),
  ];
  const hits = searchEntries(entries, "session-store.ts");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.category, "tool");
  assert.equal(hits[0]!.label, "工具：write_file");
  // 无 output 字段的形态走的是原始 JSON 回退，路径必须仍在
  assert.ok(hits[0]!.snippet.includes("session-store.ts"));
});

test("S3b. bash 工具的可读 output 参与检索（不是只搜 JSON 外壳）", () => {
  const entries: ChatEntry[] = [
    toolEntry("t2", "bash", {
      ok: true,
      name: "bash",
      output: "modified: packages/core/src/session.ts",
      metadata: { exitCode: 0 },
    }),
  ];
  const hits = searchEntries(entries, "packages/core/src/session.ts");
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.snippet.includes("packages/core/src/session.ts"));
});

// ============================================================================
// S4：计划与报告
// ============================================================================

test("S4. 执行计划与后台任务归入「计划与报告」", () => {
  const entries: ChatEntry[] = [
    { kind: "plan", id: "p1", plan: "- [x] 补齐会话分发\n- [ ] 补测试", explanation: "本阶段聚焦 L0-3" },
    {
      kind: "bgtask",
      id: "b1",
      notice: {
        status: "failed",
        exitText: "exit code 1",
        command: "npm test -- --grep orchestrator",
        duration: "1m 20s",
        outputPath: "/tmp/bg-1.log",
        logTail: "AssertionError: budget exceeded",
      },
    },
  ];
  const planHits = searchEntries(entries, "本阶段聚焦");
  assert.equal(planHits[0]!.category, "plan");
  assert.equal(planHits[0]!.label, "执行计划");

  const taskHits = searchEntries(entries, "orchestrator");
  assert.equal(taskHits.length, 1);
  assert.equal(taskHits[0]!.label, "后台任务");

  const logHits = searchEntries(entries, "budget exceeded");
  assert.equal(logHits.length, 1, "失败日志尾同样可检索");
});

// ============================================================================
// S5：匹配语义
// ============================================================================

test("S5. 多关键词 AND 匹配，任一词缺失则不命中", () => {
  const entries: ChatEntry[] = [userEntry("u2", "把 session.ts 里的 budget 逻辑抽出来")];
  assert.equal(searchEntries(entries, "session.ts budget").length, 1);
  assert.equal(searchEntries(entries, "session.ts cache").length, 0, "缺一个关键词即不命中");
});

test("S5b. 大小写不敏感，中文子串直接匹配", () => {
  const entries: ChatEntry[] = [userEntry("u3", "把 UpdatePlan 的 Explanation 显示出来")];
  assert.equal(searchEntries(entries, "updateplan").length, 1);
  assert.equal(searchEntries(entries, "EXPLANATION").length, 1);
  assert.equal(searchEntries(entries, "显示出来").length, 1);
});

test("S5c. 空查询 / 纯空白查询不产生命中", () => {
  const entries: ChatEntry[] = [userEntry("u4", "任意内容")];
  assert.equal(searchEntries(entries, "").length, 0);
  assert.equal(searchEntries(entries, "   \n\t ").length, 0);
  assert.deepEqual(tokenizeQuery("  a  a   b "), ["a", "b"], "关键词去重且去空");
});

test("S5d. 同一条文档内重复出现只产出一条命中（跳转可预期）", () => {
  const entries: ChatEntry[] = [userEntry("u5", "token token token")];
  assert.equal(searchEntries(entries, "token").length, 1);
});

// ============================================================================
// S6：片段与高亮偏移
// ============================================================================

test("S6. 片段以命中词为中心，snippetMatchStart 指向的正是命中词", () => {
  const long = `${"前".repeat(300)}目标关键词${"后".repeat(300)}`;
  const entries: ChatEntry[] = [userEntry("u6", long)];
  const hits = searchEntries(entries, "目标关键词");
  assert.equal(hits.length, 1);
  const { snippet, snippetMatchStart, snippetMatchLength } = hits[0]!;
  assert.equal(snippet.slice(snippetMatchStart, snippetMatchStart + snippetMatchLength), "目标关键词");
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), "两侧截断应带省略号");
  assert.ok(snippet.length <= 160, `片段应有上限，实际 ${snippet.length}`);
});

test("S6b. 片段折叠换行与缩进，多行工具输出不会撑破单行", () => {
  const entries: ChatEntry[] = [
    toolEntry("t3", "bash", { ok: true, name: "bash", output: "line1\n\n   line2 命中\nline3" }),
  ];
  const hit = searchEntries(entries, "命中")[0]!;
  assert.ok(!hit.snippet.includes("\n"), "片段内不应保留换行");
  assert.ok(!/\s{2,}/.test(hit.snippet), "连续空白应折叠为单空格");
});

test("S6c. 短文本不截断，不加省略号", () => {
  const entries: ChatEntry[] = [userEntry("u7", "短句命中")];
  const hit = searchEntries(entries, "命中")[0]!;
  assert.equal(hit.snippet, "短句命中");
  assert.equal(hit.snippetMatchStart, 2);
});

// ============================================================================
// S7：筛选、计数、上限
// ============================================================================

test("S7. 类别筛选与类别计数", () => {
  const entries: ChatEntry[] = [
    userEntry("u8", "缓存 方案"),
    assistantEntry("a3", "缓存 建议使用 LRU"),
    toolEntry("t4", "write_file", { ok: true, name: "write_file", metadata: { path: "cache.ts" } }),
  ];
  const all = searchEntries(entries, "缓存");
  assert.equal(all.length, 2, "工具条目不含该词");

  const counts = countHitsByCategory(all);
  assert.equal(counts.user, 1);
  assert.equal(counts.assistant, 1);
  assert.equal(counts.thinking, 0);
  assert.equal(counts.tool, 0);
  assert.equal(counts.plan, 0);

  const onlyUser = searchEntries(entries, "缓存", { categories: ["user"] });
  assert.equal(onlyUser.length, 1);
  assert.equal(onlyUser[0]!.category, "user");

  // 空类别数组 = 不过滤（与缺省一致）
  assert.equal(searchEntries(entries, "缓存", { categories: [] }).length, 2);
});

test("S7b. limit 生效（超长会话不全量返回）", () => {
  const entries: ChatEntry[] = Array.from({ length: 10 }, (_, i) => userEntry(`u-limit-${i}`, `重复词 ${i}`));
  assert.equal(searchEntries(entries, "重复词").length, 10);
  assert.equal(searchEntries(entries, "重复词", { limit: 3 }).length, 3);
});

test("S7c. 权限卡片不入索引（无内容可检索）", () => {
  const entries: ChatEntry[] = [
    {
      kind: "permission",
      id: "perm-1",
      request: { toolCallId: "call-1", toolName: "bash", reason: "需要执行命令" } as never,
      submitting: false,
    },
  ];
  assert.equal(buildSearchDocuments(entries).length, 0);
});

test("S7d. 命中顺序与对话顺序一致（可上下顺跳）", () => {
  const entries: ChatEntry[] = [
    userEntry("u9", "第一处 关键词"),
    assistantEntry("a4", "中间无关内容"),
    userEntry("u10", "第二处 关键词"),
  ];
  const hits = searchEntries(entries, "关键词");
  assert.deepEqual(
    hits.map((h) => h.entryId),
    ["u9", "u10"]
  );
});

test("S7e. 类别枚举顺序稳定（筛选栏依赖）", () => {
  assert.deepEqual([...SEARCH_CATEGORIES], ["user", "assistant", "thinking", "tool", "plan"]);
});
