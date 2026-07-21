/**
 * CodeMap 性能基准测试种子文件 - 配置管理
 */

export interface AppConfig {
  appName: string;
  version: string;
  environment: "development" | "staging" | "production";
  port: number;
  databaseUrl: string;
  redisUrl?: string;
  logLevel: string;
  features: {
    enableAuth: boolean;
    enableCache: boolean;
    enableMetrics: boolean;
  };
}

export class ConfigManager {
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  get<T extends keyof AppConfig>(key: T): AppConfig[T] {
    return this.config[key];
  }

  set<T extends keyof AppConfig>(key: T, value: AppConfig[T]): void {
    this.config[key] = value;
  }

  update(partial: Partial<AppConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  toJSON(): AppConfig {
    return { ...this.config };
  }
}

export function createDefaultConfig(): AppConfig {
  return {
    appName: "deepcode-bench",
    version: "1.0.0",
    environment: "development",
    port: 3000,
    databaseUrl: "postgres://localhost:5432/deepcode",
    logLevel: "info",
    features: {
      enableAuth: true,
      enableCache: true,
      enableMetrics: false,
    },
  };
}
