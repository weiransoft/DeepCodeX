/**
 * 领域专家注入接线测试（L1-2，2026-11-02）
 *
 * ## 这个文件守的是什么
 *
 * `domain-expert-*.test.ts`（9 个文件）已经覆盖了匹配器与注册表**本身**的正确性。
 * 但那套能力此前在生产代码里**零引用**——`core/src/index.ts` 甚至没 re-export，
 * 属于"写好了、测好了、没人调"的死代码。
 *
 * 本文件的断言重心是**接线**（方案 §6.2 验收 D1/D2/D3）：
 * - D1：`resolveDomainExpertInjection` 可从 team 公共入口 import
 * - D2：相关任务产出含专家段的 prompt 片段
 * - D3：低相关任务不注入（阈值门槛），且关掉开关时**不触达**专家子系统
 *
 * 不硬编码专家 ID 与关键词：先从注册表取真实专家再反构造任务，
 * 避免专家数据调整后测试变成"改一处数据崩一个用例"。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DomainExpertRegistry } from "../team/domain-expert-registry";
import { registerAllExperts } from "../team/domain-experts/index";
import { listRoleIds } from "../team/role-registry";
import { buildTask, resolveDomainExpertInjection } from "../team/team-adapter";

/**
 * 构造带真实专家数据的注册表（**与生产接线一致**：不注入 roleRegistry）
 *
 * 为什么不传 `listRoleIds`：见同文件「守卫误伤」用例。
 */
async function buildRegistry(): Promise<DomainExpertRegistry> {
  const registry = new DomainExpertRegistry();
  await registerAllExperts(registry);
  return registry;
}

/** 注入配置（与 dispatch 默认值一致） */
function injectionConfig(patch: Partial<{ enabled: boolean; minScore: number; maxExperts: number }> = {}) {
  return { enabled: true, minScore: 0.6, maxExperts: 1, ...patch };
}

test("接线守卫：v1.1 P1-7 冲突校验会误伤本仓库自带数据，故生产接线不注入 roleRegistry", async () => {
  // 这条用例把"为什么 team-adapter 里 `new DomainExpertRegistry()` 不带参数"钉住。
  // 若有人"顺手补上" roleRegistry，注册链会在 product 类别直接抛错，
  // 而注入层的 catch 会把它降级成"永不注入"——功能静默死亡。
  const withRoleGuard = new DomainExpertRegistry({ listRoleIds: () => listRoleIds() });
  await assert.rejects(
    () => registerAllExperts(withRoleGuard),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "DOMAIN_EXPERT_ROLE_ID_COLLISION");
      return true;
    },
    "内置专家与核心角色存在合法并行（domain-product-manager ↔ product-manager），校验必然触发"
  );

  // 不注入守卫时，同一份数据可以完整注册
  const plain = new DomainExpertRegistry();
  await registerAllExperts(plain);
  assert.ok(plain.size() > 0);
});

test("D1/D2：相关任务按专家自身关键词构造时命中，并产出专家 prompt 段", async () => {
  const registry = await buildRegistry();
  assert.ok(registry.size() > 0, "注册表应至少有一个内置领域专家");

  const expertId = registry.listExpertIds()[0]!;
  const expert = registry.getExpert(expertId)!;

  // 用专家自己的关键词/专长构造任务 —— 保证"相关"这件事由数据本身定义
  const task = buildTask({
    title: expert.specialty,
    description: `${expert.specialty} ${expert.capabilities.slice(0, 6).join(" ")}`,
  });

  const injection = await resolveDomainExpertInjection(task, {
    expertInjection: injectionConfig({ minScore: 0 }),
  });

  assert.ok(injection, "相关任务应命中专家并注入");
  assert.equal(typeof injection.expertId, "string");
  assert.ok(injection.confidence >= 0, "置信度应在 [0,1] 区间");
  assert.ok(
    injection.section.includes("领域专家视角"),
    `注入段应带明确小标题，便于 prompt 审计：${injection.section.slice(0, 120)}`
  );
  assert.ok(injection.section.includes(injection.name), "注入段应含专家名");
});

test("D3：低相关任务不注入（阈值门槛），保持原行为", async () => {
  const task = buildTask({ title: "把这段文本翻译成日语", description: "翻译一句问候语" });
  const injection = await resolveDomainExpertInjection(task, {
    expertInjection: injectionConfig({ minScore: 0.99 }),
  });
  assert.equal(injection, null, "阈值卡死后不应注入任何专家");
});

test("D3b：开关关闭时不触达专家子系统（一键回滚）", async () => {
  const registry = await buildRegistry();
  const expert = registry.getExpert(registry.listExpertIds()[0]!)!;
  const task = buildTask({ title: expert.specialty, description: expert.specialty });

  const injection = await resolveDomainExpertInjection(task, {
    expertInjection: injectionConfig({ enabled: false }),
  });
  assert.equal(injection, null, "enabled=false 必须直接返回 null");
});

test("D4：maxExperts 限制注入段数量（控制 prompt 膨胀）", async () => {
  const registry = await buildRegistry();
  const expert = registry.getExpert(registry.listExpertIds()[0]!)!;
  const task = buildTask({ title: expert.specialty, description: expert.specialty });

  const injection = await resolveDomainExpertInjection(task, {
    expertInjection: injectionConfig({ minScore: 0, maxExperts: 1 }),
  });
  assert.ok(injection);
  // 单次只返回一个专家 → 只能出现一个小标题（防止后续改动把 topK 悄悄放大）
  const headingCount = injection.section.split("领域专家视角").length - 1;
  assert.equal(headingCount, 1, "一次 dispatch 最多注入一段专家视角");
});
