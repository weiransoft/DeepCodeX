/**
 * EAG-P5 原子文件写入工具（方案 A §3.2/§3.3，架构师 P2-3：统一原子写）
 *
 * tasks.md 由 plan 阶段合成、由 orchestrator 在全绿后改写任务状态，
 * 属于跨阶段共享状态文件。直接 writeFileSync 若在写入中途进程退出/断电，
 * 会留下截断的半文件，使下一阶段解析到残缺任务卡。
 *
 * 本工具采用「同目录临时文件 + rename 原子替换」：
 * - 临时文件与目标文件位于同一目录，保证 rename 在同一文件系统内（POSIX 同卷 rename 原子）；
 * - rename 成功前目标文件保持旧内容完整；
 * - 临时文件名带 pid/时间戳/随机串，并发执行不会互相覆盖临时文件。
 *
 * @module eag/p5/common/atomic-file
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 原子写入文本文件（UTF-8）。
 *
 * 步骤：确保父目录存在 → 写同目录临时文件 → renameSync 替换目标 → 异常时清理临时文件。
 *
 * @param filePath 目标文件绝对路径
 * @param content 文件完整文本内容
 */
export function atomicWriteTextFile(filePath: string, content: string): void {
  // 递归确保父目录存在（首次合成时 .eag/p5/ 目录尚不存在）
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // 同目录临时文件：跨卷 rename 会退化为非原子复制，同目录可严格规避
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`
  );

  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8" });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // 写入/替换失败：尽力清理临时文件，清理失败不掩盖原始错误
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 临时文件清理失败无需上抛：目标文件未被替换，语义仍是"本次写入失败"
    }
    throw error;
  }
}
