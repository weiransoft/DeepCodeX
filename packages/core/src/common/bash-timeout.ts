/**
 * bash 工具调用默认超时（毫秒）。
 *
 * 修复"工具调用卡死"2026-10-03：从 10 分钟降到 2 分钟——
 * 90% 日常 git/pip/ls/cat/npm test 命令在此窗口内完成；
 * 真正长任务（npm install 大包 / git clone 大仓库 / docker pull）应显式
 * run_in_background:true 走另一条无超时路径。
 * 用户可在 ~/.deepcode/settings.json 配 `bashTimeoutMs` 或
 * `env.BASH_TIMEOUT_MS="3m"` 覆盖。
 */
export const DEFAULT_BASH_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * bash 工具超时下限（毫秒）。防止用户配 `BASH_TIMEOUT_MS="5s"` 误把任何
 * 稍慢的命令（git clone 几 MB）判为超时——60s 是"短到可疑"的临界。
 */
export const MIN_BASH_TIMEOUT_MS = 60 * 1000;
export const BASH_TIMEOUT_INCREMENT_MS = 5 * 60 * 1000;
export const BASH_TIMEOUT_DECREMENT_MS = 60 * 1000;

/**
 * 运行中命令的"卡顿提示"阶梯（毫秒）——修复"工具调用卡死"2026-10-03。
 *
 * CLI loading 文案在命令仍在运行时按 elapsed 阶梯切换：
 *   <10s           → `(Ns) <command>`  （已有，不提示）
 *   10s~30s        → `(Ns) <command> · 运行中，可 Ctrl+C 中断`
 *   30s~60s        → `(Ns) <command> · 较慢，建议中断或走 run_in_background`
 *   ≥60s           → `(Ns) <command> · 已卡住？Ctrl+C 中断 + 改用 run_in_background:true`
 * 阶梯是"提示用户主动处置"，不替代硬超时（DEFAULT_BASH_TIMEOUT_MS=120s 兜底强杀）。
 */
export const BASH_RUNNING_HINT_SLOW_MS = 10_000;
export const BASH_RUNNING_HINT_VERY_SLOW_MS = 30_000;
export const BASH_RUNNING_HINT_STUCK_MS = 60_000;

export function clampBashTimeoutMs(timeoutMs: number, minTimeoutMs: number = MIN_BASH_TIMEOUT_MS): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  const minimum = Number.isFinite(minTimeoutMs) ? Math.max(1, Math.round(minTimeoutMs)) : MIN_BASH_TIMEOUT_MS;
  return Math.max(minimum, Math.round(timeoutMs));
}
