/**
 * Provider 工厂（原生 Claude API 支持 · 路由层）
 *
 * 职责：按 ResolvedDeepcodingSettings.provider 创建对应 LLMClient。
 * - 路由表驱动，新增 provider 仅需注册一行；
 * - 配置校验委托各 provider 的 createClient（fail-fast 语义集中在实现侧）；
 * - 无状态：每次调用创建新客户端（settings 为不可变快照，无共享可变状态）。
 *
 * @module providers/provider-factory
 */

import type { ResolvedDeepcodingSettings } from "../settings";
import { AnthropicProvider } from "./anthropic-provider";
import type { LLMClient, LLMProvider, ProviderName } from "./llm-provider";
import { OpenAIProvider } from "./openai-provider";

/** provider 注册表（新增 provider 在此注册） */
const PROVIDERS: Record<ProviderName, LLMProvider> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
};

export class ProviderFactory {
  /**
   * 按 settings.provider 创建 LLMClient
   *
   * @throws 未知 provider 或 provider 侧配置校验失败（如 anthropic 缺 API_KEY）
   */
  static create(settings: ResolvedDeepcodingSettings): LLMClient {
    const provider = PROVIDERS[settings.provider];
    if (!provider) {
      // 防御性分支：settings.provider 类型已收敛为联合类型，此处理论不可达，
      // 但运行时 settings.json 可被手改为任意字符串，需显式报错而非 undefined 崩溃
      throw new Error(`未知的 LLM provider: ${String(settings.provider)}`);
    }
    return provider.createClient(settings);
  }
}
