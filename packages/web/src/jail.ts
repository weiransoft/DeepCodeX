/**
 * 路径牢笼（docs/dev/web-ui.md §3.1 D5 / §3.6）。
 *
 * 目录浏览/上传/下载与项目根校验统一经由本模块：
 * - 目标路径先做 ~ 展开与 path.resolve 归一；
 * - fs.realpath 消解符号链接（目标不存在时对最近存在的祖先 realpath 再拼剩余段）；
 * - 以 path.relative 做前缀包含判断，杜绝 `..` 与 symlink 逃逸（CWE-22 防护）。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { expandHomePath } from "./config";

/**
 * 牢笼越界类型化错误（上层统一映射 HTTP 403）。
 */
export class JailViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JailViolationError";
  }
}

/**
 * 对白名单根目录列表做 realpath 归一。
 *
 * 在服务器启动时调用一次，产出 resolveInJail 使用的真实根集合；
 * realpath 失败（目录不存在/不可达）的根被跳过——该根下的所有访问将自然越界（403），
 * 符合"白名单失效即拒绝"的安全取向，且不拖垮其他可用根。
 *
 * @param allowRoots 已展开的绝对路径白名单
 * @returns realpath 成功的根目录列表
 */
export async function buildJailRoots(allowRoots: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const root of allowRoots) {
    try {
      roots.push(await realpath(root));
    } catch {
      // 跳过不可用根：resolveInJail 对空集合一律 403
    }
  }
  return roots;
}

/**
 * 计算目标路径的真实路径（目标不存在时回退到最近存在祖先 + 剩余段拼接）。
 *
 * 该策略同时覆盖"目录浏览已存在路径"与"上传到尚未创建的子目录"两类场景：
 * 未存在段不可能是符号链接（尚未创建），对存在祖先做 realpath 已足够消解链接逃逸。
 *
 * @param target 已归一（resolve 展开）的目标绝对路径
 * @returns 真实路径（可能包含尚未存在的末段）
 */
async function realpathAllowMissing(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // 目标不存在：逐级向上找最近存在的祖先
    let current = target;
    const missing: string[] = [];
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        // 到达文件系统根仍不存在（理论上不可能）：按原样返回，由牢笼校验拒绝
        return target;
      }
      missing.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = await realpath(current);
        return path.join(realParent, ...missing);
      } catch {
        // 祖先也不存在，继续向上
      }
    }
  }
}

/**
 * 校验目标路径落在某个白名单根之内，并返回消解符号链接后的真实路径。
 *
 * 判定规则：realpath(target) 对每个 root 的 path.relative 结果必须为空串（相等）
 * 或非 ".." 开头的相对路径（在根内）。`..` 开头或绝对路径均视为越界。
 *
 * @param allowRootsRealpaths realpath 后的白名单根集合（buildJailRoots 产物）
 * @param target 用户请求的目标路径（支持 ~ 展开；相对路径按进程 cwd 归一）
 * @returns 校验通过的真实绝对路径
 * @throws JailViolationError 当目标越出白名单（映射 403）
 */
export async function resolveInJail(allowRootsRealpaths: string[], target: string): Promise<string> {
  // 归一：~ 展开 + path.resolve（消除 . / .. 与重复分隔符）
  const normalized = path.resolve(expandHomePath(target));
  // 消解符号链接（目标可不存在：回退到最近存在祖先）
  const resolved = await realpathAllowMissing(normalized);

  for (const root of allowRootsRealpaths) {
    const rel = path.relative(root, resolved);
    // rel === "" 表示目标即根；非 ".." 开头且非绝对路径表示位于根内
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return resolved;
    }
  }
  throw new JailViolationError(`路径越界：${JSON.stringify(target)} 不在允许访问的目录白名单内`);
}
