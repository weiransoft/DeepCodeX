/**
 * EAG-P5 任务卡租约（task lease）—— 跨 run 并发防护（2026-10-20 修复"并发 run 互相
 * 把对方在途 AUTO 卡 blocked 导致永久死锁"事故，run 68acea2de182 × 90611ca5db4e）。
 *
 * 背景：tasks.md 是项目级共享可变状态，多个 /eag-autonomous run 在同一 projectRoot
 * 并发时，plan 3.5 AUTO 相关性守卫会把"与**自己的** objective 无关"的 pending AUTO 卡
 * blocked 落盘——而该卡恰恰是另一个并发 run 正在 dev 执行的在途卡（两 run objective
 * 互不相同，各自的守卫都视对方的卡为"无关旧卡"）。blocked 在本地规则下是单向门
 * （pickNextPendingTask 只认 pending，3.6 恢复守卫只救 completed AUTO 卡），
 * 被误伤的卡所属 run 下一轮 plan 直接判 tasks-blocked 死锁。
 *
 * 机制：run 每轮真实选中任务卡后写入租约文件
 * `.eag/p5/leases/<runId>.json`（含 taskCardId / objective / updatedAt）；
 * 其他 run 的 3.5 守卫在 blocked 落盘前查询"其他 run 的存活租约"
 * （mtime 距今 < LEASE_TTL_MS 视为存活），命中在途卡则跳过拦截（不动对方正在
 * 执行的卡，本轮由下游 fail-closed 诚实透出）。run 退出（finally）删除自己的租约。
 *
 * 防"僵尸租约永久阻塞守卫"：租约不续期于阶段内部，仅每轮 plan 选中时刷新；
 * 崩溃残留的租约随 TTL（默认 30 分钟，远大于单阶段最长执行时间）自然过期。
 *
 * 设计约束：
 * - 全部 I/O 容错（任何异常不得影响 plan/run 主流程——租约是尽力而为的防护，
 *   不是正确性前提；读写失败仅降级为"无租约信息"）。
 * - 不引入文件锁：租约文件按 runId 命名，每个 run 只写自己的文件，无竞争。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 租约目录（相对 projectRoot） */
export const P5_LEASES_DIR = ".eag/p5/leases" as const;

/** 租约存活 TTL（毫秒，默认 30 分钟）：mtime 距今超过该值视为僵尸租约 */
export const P5_LEASE_TTL_MS: number = 30 * 60 * 1000;

/** 租约文件内容结构 */
export interface P5TaskLease {
  /** 持有租约的 run id */
  readonly runId: string;
  /** 该 run 当前的 objective（诊断用） */
  readonly objective: string;
  /** 当前正在执行的 AUTO 合成任务卡 ID（null = 本轮未选中任务卡） */
  readonly taskCardId: string | null;
  /** 迭代轮次（诊断用） */
  readonly iterIndex: number;
  /** 写入时间（ISO 8601） */
  readonly updatedAt: string;
}

/** 租约目录绝对路径 */
export function p5LeasesDir(projectRoot: string): string {
  return path.join(projectRoot, P5_LEASES_DIR);
}

/** 单个 run 的租约文件路径 */
export function p5LeasePath(projectRoot: string, runId: string): string {
  return path.join(p5LeasesDir(projectRoot), `${runId}.json`);
}

/**
 * 写入（刷新）本 run 的租约。容错：目录/写入失败静默降级，不影响主流程。
 *
 * @param projectRoot 项目根（绝对路径）
 * @param lease 租约内容（updatedAt 由本函数统一填充）
 */
export function writeP5TaskLease(
  projectRoot: string,
  lease: Readonly<{ runId: string; objective: string; taskCardId: string | null; iterIndex: number }>
): void {
  try {
    const dir = p5LeasesDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const payload: P5TaskLease = {
      runId: lease.runId,
      objective: lease.objective.slice(0, 500),
      taskCardId: lease.taskCardId,
      iterIndex: lease.iterIndex,
      updatedAt: new Date().toISOString(),
    };
    // 直接 writeFile：文件按 runId 命名（单写者），tmp+rename 反而制造半截文件风险
    fs.writeFileSync(p5LeasePath(projectRoot, lease.runId), JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    // 租约写入失败：尽力而为失败，降级为"该 run 无租约信息"（守卫按无租约处理）
  }
}

/**
 * 删除本 run 的租约（run 退出时在 finally 中调用）。容错：不存在/删除失败静默跳过。
 *
 * @param projectRoot 项目根（绝对路径）
 * @param runId 运行 ID
 */
export function removeP5TaskLease(projectRoot: string, runId: string): void {
  try {
    fs.rmSync(p5LeasePath(projectRoot, runId), { force: true });
  } catch {
    // 清理失败不影响 run 退出
  }
}

/**
 * 读取"其他 run"当前声明为在途的任务卡 ID 集合（存活租约）。
 *
 * 存活判定：租约文件 mtime 距今 < ttlMs。解析失败/过期/自身 runId 一律跳过。
 *
 * @param projectRoot 项目根（绝对路径）
 * @param selfRunId 当前 run id（排除自身租约）
 * @param ttlMs 存活 TTL（默认 {@link P5_LEASE_TTL_MS}）
 * @returns 其他存活 run 的在途 taskCardId 集合（非 AUTO 卡也可能包含——调用方只在自己
 *          准备 blocked 该卡时查询，查询本身无害）
 */
export function readForeignActiveLeaseTaskIds(
  projectRoot: string,
  selfRunId: string,
  ttlMs: number = P5_LEASE_TTL_MS
): ReadonlySet<string> {
  const result = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(p5LeasesDir(projectRoot));
  } catch {
    return result; // 目录不存在 = 无并发租约
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(p5LeasesDir(projectRoot), entry);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs >= ttlMs) continue; // 僵尸租约：过期即视为无主
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<P5TaskLease>;
      if (typeof raw.runId !== "string" || raw.runId === selfRunId) continue;
      if (typeof raw.taskCardId === "string" && raw.taskCardId.length > 0) {
        result.add(raw.taskCardId);
      }
    } catch {
      // 单个租约损坏：跳过该文件（尽力而为语义），不影响其他租约判定
    }
  }
  return result;
}
