/**
 * InterventionLedger —— 干预台账（P6，Better Harness 增强方案 §P6）
 *
 * 职责：记录「建议 → 已实施」的干预动作，支撑后续可比 Episode 回访验证
 * （Outcome-supported 结论可追溯至前因 finding）。
 *
 * 存储约定（共识采纳）：
 * - **新写统一 `.deepcodeX`**：`<homeRoot>/.deepcodeX/eag/intervention-ledger.json`；
 * - **双读单写不迁移**：读取时兼容旧根 `<homeRoot>/.deepcode/eag/intervention-ledger.json`
 *   （新文件缺失才回退旧根），写入永远走新根，不做存量迁移；
 * - 原子写：tmp 文件 + rename，避免并发/中断写坏台账；
 * - 容错读：文件缺失/损坏/坏条目逐条跳过，绝不抛出（读取失败按空台账降级）。
 *
 * @module eag/intervention-ledger
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 回访验证状态（与 BH Repair Progress 对齐） */
export type LedgerVerificationState = "outcome-supported" | "partial" | "blocked";

/** 台账条目：一次干预动作（建议已实施） */
export type LedgerEntry = {
  /** 关联的 Finding id（P3 契约的 AgentFinding.id） */
  findingId: string;
  /** 实施时间（ISO 8601） */
  appliedAt: string;
  /** 实施者（owner 对齐：user / agent / 资产名） */
  owner: string;
  /** 预期效果（中文，可回访比对） */
  expectedEffect: string;
  /** 可选：资产落盘路径（skill/rule 等） */
  assetPath?: string;
  /** 可选：回访验证结果（后续 Episode 比对后回填） */
  verification?: {
    /** 验证时间（ISO 8601） */
    verifiedAt: string;
    /** 验证结论 */
    state: LedgerVerificationState;
    /** 可选：验证说明（中文） */
    note?: string;
  };
  /**
   * 可选：verification 解析告警（P2 修复新增）。
   *
   * 当原始 verification 字段存在但形态非法（verifiedAt 为空或 state 不在白名单）时写入，
   * 明确标注「解析失败」而非静默丢弃，避免台账损坏被当成「该条目本就没有验证结果」。
   */
  verificationParseWarning?: string;
  /** 可选：解析失败时保留的原始 verification 值（不伪造合法结构，供人工核对） */
  rawVerification?: unknown;
};

/** 台账文件名（新旧根共用相对路径） */
const LEDGER_RELATIVE_PATH = path.join("eag", "intervention-ledger.json");

/** 台账条目上限（防无限增长；超出时丢弃最旧的非 verified 条目优先） */
export const MAX_LEDGER_ENTRIES = 500;

/** 新根台账路径（唯一写入目标） */
export function ledgerFilePath(homeRoot: string): string {
  return path.join(homeRoot, ".deepcodeX", LEDGER_RELATIVE_PATH);
}

/** 旧根兼容路径（仅读取回退） */
export function legacyLedgerFilePath(homeRoot: string): string {
  return path.join(homeRoot, ".deepcode", LEDGER_RELATIVE_PATH);
}

/** 单条容错解析：字段形态非法返回 undefined */
function parseEntry(raw: unknown): LedgerEntry | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const findingId = typeof obj.findingId === "string" ? obj.findingId.trim() : "";
  const appliedAt = typeof obj.appliedAt === "string" ? obj.appliedAt.trim() : "";
  const owner = typeof obj.owner === "string" ? obj.owner.trim() : "";
  const expectedEffect = typeof obj.expectedEffect === "string" ? obj.expectedEffect.trim() : "";
  if (!findingId || !appliedAt || !owner || !expectedEffect) {
    return undefined;
  }
  const entry: LedgerEntry = { findingId, appliedAt, owner, expectedEffect };
  if (typeof obj.assetPath === "string" && obj.assetPath.trim()) {
    entry.assetPath = obj.assetPath.trim();
  }
  if (obj.verification && typeof obj.verification === "object") {
    const v = obj.verification as Record<string, unknown>;
    const verifiedAt = typeof v.verifiedAt === "string" ? v.verifiedAt.trim() : "";
    const state = v.state;
    if (verifiedAt && (state === "outcome-supported" || state === "partial" || state === "blocked")) {
      entry.verification = {
        verifiedAt,
        state,
        note: typeof v.note === "string" ? v.note : undefined,
      };
    } else {
      // P2 修复：verification 存在但形态非法时，不再静默整个丢弃且无日志。
      // 保留原始值 + 写解析告警标注，避免「看起来没有 verification」掩盖台账损坏/
      // 格式不兼容（诚实降级，不伪造合法 verification）。
      entry.rawVerification = obj.verification;
      entry.verificationParseWarning =
        "verification 形态非法（verifiedAt 为空或 state 不在 outcome-supported/partial/blocked 白名单），已保留原始值待人工核对";
    }
  }
  // 容错读回：若条目已带解析告警（上一轮解析保留），原样透传，保证 roundtrip 不丢诊断信息
  if (typeof obj.verificationParseWarning === "string" && obj.verificationParseWarning.length > 0) {
    entry.verificationParseWarning = obj.verificationParseWarning;
    if (obj.rawVerification !== undefined) {
      entry.rawVerification = obj.rawVerification;
    }
  }
  return entry;
}

/** 容错解析台账文件内容（损坏/形态非法 → 空数组） */
function parseLedgerContent(content: string): LedgerEntry[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(parseEntry).filter((e): e is LedgerEntry => e !== undefined);
  } catch {
    return [];
  }
}

/**
 * 读取台账（双读：新根优先，缺失才回退旧根；两端都缺失 → 空数组）。
 */
export function readLedger(homeRoot: string): LedgerEntry[] {
  const primary = ledgerFilePath(homeRoot);
  try {
    if (fs.existsSync(primary)) {
      return parseLedgerContent(fs.readFileSync(primary, "utf8"));
    }
  } catch {
    // 读新根失败不回退旧根（避免新旧混合产生歧义），按空台账降级
    return [];
  }
  try {
    const legacy = legacyLedgerFilePath(homeRoot);
    if (fs.existsSync(legacy)) {
      return parseLedgerContent(fs.readFileSync(legacy, "utf8"));
    }
  } catch {
    // 旧根读失败同样降级
  }
  return [];
}

/** 原子写（tmp + rename；失败返回 false 不抛出） */
function atomicWrite(filePath: string, content: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加台账条目（写入新根；容量超限时丢弃最旧的无验证条目）。
 *
 * @returns true = 写入成功；false = IO 失败（调用方降级，不阻断主流程）
 */
export function appendLedgerEntry(homeRoot: string, entry: LedgerEntry): boolean {
  if (!entry.findingId || !entry.appliedAt || !entry.owner || !entry.expectedEffect) {
    return false;
  }
  const entries = readLedger(homeRoot);
  entries.push(entry);
  let trimmed = entries;
  if (trimmed.length > MAX_LEDGER_ENTRIES) {
    // 先丢最旧的无验证条目；仍超限再按时间丢最旧
    const withoutVerification = trimmed.filter((e) => !e.verification);
    if (withoutVerification.length > 0) {
      const dropped = new Set(withoutVerification.slice(0, trimmed.length - MAX_LEDGER_ENTRIES));
      trimmed = trimmed.filter((e) => !dropped.has(e));
    }
    if (trimmed.length > MAX_LEDGER_ENTRIES) {
      trimmed = trimmed.slice(trimmed.length - MAX_LEDGER_ENTRIES);
    }
  }
  return atomicWrite(ledgerFilePath(homeRoot), JSON.stringify(trimmed, null, 2) + "\n");
}

/**
 * 回填回访验证结果（按 findingId 匹配最近一条未验证条目）。
 *
 * @returns true = 回填成功；false = 无匹配条目或 IO 失败
 */
export function recordVerification(
  homeRoot: string,
  findingId: string,
  verification: NonNullable<LedgerEntry["verification"]>
): boolean {
  if (!findingId) {
    return false;
  }
  const entries = readLedger(homeRoot);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].findingId === findingId && !entries[i].verification) {
      entries[i] = { ...entries[i], verification };
      return atomicWrite(ledgerFilePath(homeRoot), JSON.stringify(entries, null, 2) + "\n");
    }
  }
  return false;
}
