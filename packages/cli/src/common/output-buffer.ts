/**
 * OutputBuffer - 共享输出缓冲器
 *
 * 收集命令执行期间的 stdout 和 stderr 输出，避免直接写终端。
 * 当 printToTerminal=true 时，同时写入真实终端；
 * 当 printToTerminal=false 时，仅收集到缓冲区，由调用方处理。
 *
 * 设计目的：
 *   - 测试时可关闭终端输出，通过返回值断言输出内容
 *   - TUI 模式（/quality-check、/review 等）需要将输出作为消息内容返回，而非直接打印
 *
 * 架构师审查 L2 修复（2026-07-27）：
 *   之前 quality-cmd.ts 和 review-cmd.ts 中有完全相同的 OutputBuffer 类实现（约 40 行），
 *   现提取到共享模块，避免代码重复，便于后续维护。
 */

/**
 * 输出缓冲器
 *
 * 收集 stdout 和 stderr 输出，可选同时写入真实终端。
 */
export class OutputBuffer {
  /** stdout 缓冲 */
  private readonly stdoutChunks: string[] = [];
  /** stderr 缓冲 */
  private readonly stderrChunks: string[] = [];
  /** 是否同时写入真实终端 */
  private readonly printToTerminal: boolean;

  /**
   * 构造 OutputBuffer
   *
   * @param printToTerminal 是否同时写入真实终端（默认 true）
   */
  constructor(printToTerminal: boolean = true) {
    this.printToTerminal = printToTerminal;
  }

  /**
   * 写入 stdout
   *
   * @param text 输出文本
   */
  writeStdout(text: string): void {
    this.stdoutChunks.push(text);
    if (this.printToTerminal) {
      process.stdout.write(text);
    }
  }

  /**
   * 写入 stderr
   *
   * @param text 错误文本
   */
  writeStderr(text: string): void {
    this.stderrChunks.push(text);
    if (this.printToTerminal) {
      process.stderr.write(text);
    }
  }

  /**
   * 获取收集到的 stdout
   *
   * @returns stdout 文本
   */
  getStdout(): string {
    return this.stdoutChunks.join("");
  }

  /**
   * 获取收集到的 stderr
   *
   * @returns stderr 文本
   */
  getStderr(): string {
    return this.stderrChunks.join("");
  }
}
