/**
 * 日志工具模块
 * 提供统一的日志格式: [LEVEL] [timestamp] message
 */

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

class Logger {
  /**
   * 格式化日志输出
   * @param level 日志级别
   * @param message 日志内容
   */
  private log(level: LogLevel, message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${level}] [${timestamp}] ${message}`);
  }

  info(message: string): void {
    this.log("INFO", message);
  }

  warn(message: string): void {
    this.log("WARN", message);
  }

  error(message: string): void {
    this.log("ERROR", message);
  }

  debug(message: string): void {
    this.log("DEBUG", message);
  }
}

// 导出单例
export const logger = new Logger();
