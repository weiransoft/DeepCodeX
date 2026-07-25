/**
 * InterruptQueue 单元测试 —— ADR-DI-001 §9.1
 *
 * 测试范围（对齐 ADR-DI-001 §9.1 单元测试用例）：
 * - TC-IQ-001: enqueue + drain 基本流程，drain 返回按入队顺序排列
 * - TC-IQ-002: 超过 MAX_QUEUE_SIZE 抛 QueueOverflowError
 * - TC-IQ-003: drain 后队列清空
 * - TC-IQ-004: peek 不消费
 * - TC-IQ-005: onEnqueue 回调触发
 * - TC-IQ-006: 并发 enqueue（连续多次）顺序正确
 * - TC-IQ-007: clear 清空队列
 * - TC-IQ-008: 入队空文本抛错
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 真实组件：直接 new InterruptQueue()，不通过 mock 框架
 * - 所有 fixture 使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 * - 中文注释
 *
 * 设计依据：
 * - ADR-DI-001 §3.1 InterruptQueue 数据结构
 * - ADR-DI-001 §9.1 单元测试用例
 *
 * @module tests/interrupt-queue
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { InterruptQueue } from "../interrupts/interrupt-queue";
import { QueueOverflowError } from "../interrupts/types";
import type { InjectedInstruction } from "../interrupts/types";

// ============================================================================
// 测试辅助：构造真实 InjectedInstruction fixture
// ============================================================================

/**
 * 构造测试用 InjectedInstruction
 *
 * 真实结构（非 mock），使用 crypto.randomUUID() 生成 id。
 *
 * @param text 指令文本
 * @param source 注入来源（默认 user）
 * @returns 真实 InjectedInstruction 对象（冻结）
 */
function createInstruction(text: string, source: "user" | "llm" = "user"): InjectedInstruction {
  return Object.freeze({
    id: crypto.randomUUID(),
    text,
    enqueuedAt: new Date().toISOString(),
    source,
  });
}

// ============================================================================
// TC-IQ-001: enqueue + drain 基本流程
// ============================================================================

test("TC-IQ-001: enqueue + drain 基本流程，drain 返回按入队顺序排列", () => {
  const queue = new InterruptQueue();
  const a = createInstruction("加上错误处理");
  const b = createInstruction("使用 TypeScript");
  const c = createInstruction("添加测试用例");

  queue.enqueue(a);
  queue.enqueue(b);
  queue.enqueue(c);

  assert.equal(queue.size, 3, "队列长度应为 3");

  const drained = queue.drain();
  assert.equal(drained.length, 3, "drain 应返回 3 条指令");
  // 验证 FIFO 顺序
  assert.equal(drained[0].id, a.id, "第 1 条指令应为 a");
  assert.equal(drained[1].id, b.id, "第 2 条指令应为 b");
  assert.equal(drained[2].id, c.id, "第 3 条指令应为 c");
  // 验证文本与来源保持不变
  assert.equal(drained[0].text, "加上错误处理");
  assert.equal(drained[1].text, "使用 TypeScript");
  assert.equal(drained[2].text, "添加测试用例");
});

// ============================================================================
// TC-IQ-002: 超过 MAX_QUEUE_SIZE 抛 QueueOverflowError
// ============================================================================

test("TC-IQ-002: 超过 MAX_QUEUE_SIZE 抛 QueueOverflowError", () => {
  const queue = new InterruptQueue();
  // 填满队列
  for (let i = 0; i < InterruptQueue.MAX_QUEUE_SIZE; i++) {
    queue.enqueue(createInstruction(`指令-${i}`));
  }
  assert.equal(queue.size, InterruptQueue.MAX_QUEUE_SIZE, "队列应已满");

  // 再入队应抛 QueueOverflowError
  assert.throws(
    () => queue.enqueue(createInstruction("溢出指令")),
    (err) => {
      assert.ok(err instanceof QueueOverflowError, "应抛 QueueOverflowError");
      assert.equal(err.name, "QueueOverflowError");
      assert.equal(err.currentSize, InterruptQueue.MAX_QUEUE_SIZE);
      assert.equal(err.maxSize, InterruptQueue.MAX_QUEUE_SIZE);
      return true;
    },
    "第 65 条入队应抛 QueueOverflowError"
  );

  // 队列长度仍为 MAX_QUEUE_SIZE（拒绝入队后不变）
  assert.equal(queue.size, InterruptQueue.MAX_QUEUE_SIZE);
});

// ============================================================================
// TC-IQ-003: drain 后队列清空
// ============================================================================

test("TC-IQ-003: drain 后队列清空", () => {
  const queue = new InterruptQueue();
  queue.enqueue(createInstruction("指令 1"));
  queue.enqueue(createInstruction("指令 2"));
  assert.equal(queue.size, 2, "drain 前队列长度应为 2");

  const drained = queue.drain();
  assert.equal(drained.length, 2, "drain 应返回 2 条指令");
  assert.equal(queue.size, 0, "drain 后队列长度应为 0");

  // 再次 drain 返回空数组（不抛错）
  const drainedAgain = queue.drain();
  assert.equal(drainedAgain.length, 0, "再次 drain 应返回空数组");
});

// ============================================================================
// TC-IQ-004: peek 不消费
// ============================================================================

test("TC-IQ-004: peek 不消费", () => {
  const queue = new InterruptQueue();
  const a = createInstruction("指令 A");
  const b = createInstruction("指令 B");
  queue.enqueue(a);
  queue.enqueue(b);
  assert.equal(queue.size, 2, "peek 前队列长度应为 2");

  const peeked = queue.peek();
  assert.equal(peeked.length, 2, "peek 应返回 2 条指令");
  assert.equal(peeked[0].id, a.id, "peek 第 1 条应为 a");
  assert.equal(peeked[1].id, b.id, "peek 第 2 条应为 b");

  // peek 后队列长度不变
  assert.equal(queue.size, 2, "peek 后队列长度应仍为 2");

  // 再次 peek 仍返回原内容
  const peekedAgain = queue.peek();
  assert.equal(peekedAgain.length, 2, "再次 peek 应仍返回 2 条指令");
  assert.equal(peekedAgain[0].id, a.id);

  // drain 验证队列内容未被 peek 修改
  const drained = queue.drain();
  assert.equal(drained.length, 2);
  assert.equal(drained[0].id, a.id);
});

// ============================================================================
// TC-IQ-005: onEnqueue 回调触发
// ============================================================================

test("TC-IQ-005: onEnqueue 回调触发", () => {
  let callCount = 0;
  const receivedInstructions: string[] = [];
  const queue = new InterruptQueue({
    onEnqueue: () => {
      callCount++;
      receivedInstructions.push(`call-${callCount}`);
    },
  });

  queue.enqueue(createInstruction("指令 1"));
  assert.equal(callCount, 1, "第 1 次 enqueue 后回调应被调用 1 次");
  assert.deepEqual(receivedInstructions, ["call-1"]);

  queue.enqueue(createInstruction("指令 2"));
  queue.enqueue(createInstruction("指令 3"));
  assert.equal(callCount, 3, "3 次 enqueue 后回调应被调用 3 次");
  assert.deepEqual(receivedInstructions, ["call-1", "call-2", "call-3"]);
});

// ============================================================================
// TC-IQ-006: 并发 enqueue（连续多次）顺序正确
// ============================================================================

test("TC-IQ-006: 并发 enqueue（连续多次）顺序正确", () => {
  const queue = new InterruptQueue();
  const instructions: InjectedInstruction[] = [];
  // 连续入队 20 条指令
  for (let i = 0; i < 20; i++) {
    const inst = createInstruction(`指令-${i.toString().padStart(2, "0")}`);
    instructions.push(inst);
    queue.enqueue(inst);
  }
  assert.equal(queue.size, 20, "队列长度应为 20");

  const drained = queue.drain();
  assert.equal(drained.length, 20, "drain 应返回 20 条指令");

  // 验证 FIFO 顺序严格保持
  for (let i = 0; i < 20; i++) {
    assert.equal(drained[i].id, instructions[i].id, `第 ${i + 1} 条指令应按入队顺序返回（期望 instructions[${i}]）`);
    assert.equal(drained[i].text, `指令-${i.toString().padStart(2, "0")}`);
  }
});

// ============================================================================
// TC-IQ-007: clear 清空队列
// ============================================================================

test("TC-IQ-007: clear 清空队列", () => {
  const queue = new InterruptQueue();
  queue.enqueue(createInstruction("指令 1"));
  queue.enqueue(createInstruction("指令 2"));
  queue.enqueue(createInstruction("指令 3"));
  assert.equal(queue.size, 3, "clear 前队列长度应为 3");

  queue.clear();
  assert.equal(queue.size, 0, "clear 后队列长度应为 0");

  // clear 后可继续入队
  queue.enqueue(createInstruction("指令 4"));
  assert.equal(queue.size, 1, "clear 后入队应正常工作");

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, "指令 4");
});

// ============================================================================
// TC-IQ-008: 入队空文本抛错
// ============================================================================

test("TC-IQ-008: 入队空文本抛错", () => {
  const queue = new InterruptQueue();

  // 空字符串抛错
  assert.throws(
    () =>
      queue.enqueue(
        Object.freeze({
          id: crypto.randomUUID(),
          text: "",
          enqueuedAt: new Date().toISOString(),
          source: "user",
        })
      ),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("text") || err.message.includes("空字符串"),
        `错误信息应包含 text 或 空字符串，实际：${err.message}`
      );
      return true;
    },
    "空字符串应抛错"
  );

  // 队列长度仍为 0（拒绝入队后不变）
  assert.equal(queue.size, 0);

  // 正常文本可入队
  queue.enqueue(createInstruction("正常指令"));
  assert.equal(queue.size, 1);
});

// ============================================================================
// 额外测试：onEnqueue 回调中重入调用 enqueue 抛错
// ============================================================================

test("额外测试：onEnqueue 回调中重入调用 enqueue 抛错（防止递归）", () => {
  const queue = new InterruptQueue({
    onEnqueue: () => {
      // 回调中再次入队应抛错（重入保护）
      assert.throws(
        () => queue.enqueue(createInstruction("重入指令")),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("重入") || err.message.includes("reentrant"),
            `错误信息应包含 重入，实际：${err.message}`
          );
          return true;
        },
        "回调中再次 enqueue 应抛重入错误"
      );
    },
  });

  // 触发回调
  queue.enqueue(createInstruction("正常指令"));
  assert.equal(queue.size, 1, "重入保护下原指令应已入队");
});

// ============================================================================
// 额外测试：drain / peek 返回值不可变
// ============================================================================

test("额外测试：drain / peek 返回值不可变（Object.freeze）", () => {
  const queue = new InterruptQueue();
  queue.enqueue(createInstruction("指令 1"));
  queue.enqueue(createInstruction("指令 2"));

  const peeked = queue.peek();
  const drained = queue.drain();

  // 验证返回值被 Object.freeze 冻结
  assert.ok(Object.isFrozen(peeked), "peek 返回值应被冻结");
  assert.ok(Object.isFrozen(drained), "drain 返回值应被冻结");

  // 修改冻结对象应抛错（严格模式下）
  // 注意：TypeScript 编译期无法检测对 Object.freeze 数组的修改，因此这里
  // 通过 cast 到可变数组绕过类型检查，运行时会抛出 TypeError。
  assert.throws(
    () => {
      (peeked as InjectedInstruction[]).push(createInstruction("指令 3"));
    },
    TypeError,
    "向冻结数组 push 应抛 TypeError"
  );

  assert.throws(
    () => {
      // @ts-expect-error 测试意图：修改只读字段
      (drained as InjectedInstruction[])[0].text = "篡改";
    },
    TypeError,
    "修改冻结对象的 readonly 字段应抛 TypeError"
  );
});

// ============================================================================
// 额外测试：onEnqueue 回调抛错不影响入队主流程
// ============================================================================

test("额外测试：onEnqueue 回调抛错不影响入队主流程（错误被吞掉）", () => {
  const queue = new InterruptQueue({
    onEnqueue: () => {
      throw new Error("回调模拟抛错");
    },
  });

  // 入队应成功（回调错误被吞掉）
  queue.enqueue(createInstruction("指令 1"));
  assert.equal(queue.size, 1, "回调抛错不应影响入队");

  queue.enqueue(createInstruction("指令 2"));
  assert.equal(queue.size, 2, "回调抛错不应影响后续入队");

  // drain 验证内容正确
  const drained = queue.drain();
  assert.equal(drained.length, 2);
  assert.equal(drained[0].text, "指令 1");
  assert.equal(drained[1].text, "指令 2");
});
