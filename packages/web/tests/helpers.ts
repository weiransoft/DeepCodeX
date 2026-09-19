/**
 * 测试公共辅助（packages/web/tests）。
 *
 * 原则（用户硬性规则）：严禁 mock 框架——所有桩均为真实受控实现：
 * - ScriptedLLMClient：完整实现 core LLMClient 接口的受控客户端（按脚本产出流式事件），
 *   与 packages/core/src/tests/session-anthropic-stream-safety.test.ts 的注入模式一致；
 * - createControlledOpenAIClientHandle：构造真实结构的 OpenAI 连接句柄
 *   （SessionManager.activateSession 要求 client 非空，测试环境无凭据时经
 *   createOpenAIClient 缝合点注入）。
 */

import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent } from "@vegamo/deepcode-core";
import type { createOpenAIClient } from "@vegamo/deepcode-core";
import type { ResolvedWebSettings } from "../src/types";

/** createOpenAIClient 返回句柄类型（与 session-pool.ts 内部定义一致） */
export type OpenAIClientHandle = ReturnType<typeof createOpenAIClient>;

/** sha256 hex 小写摘要（构造 localUsers 的 passwordHash 用） */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").toLowerCase();
}

/**
 * 构造受控 OpenAI 连接句柄（真实结构，经 createOpenAIClient 缝合点注入）。
 *
 * client 字段仅需为 truthy 对象（core 测试同款）；本测试路径始终由
 * createLLMClient 注入的 ScriptedLLMClient 承担实际 LLM 交互。
 *
 * @returns OpenAIClientHandle 受控句柄
 */
export function createControlledOpenAIClientHandle(): OpenAIClientHandle {
  return {
    client: { chat: { completions: { create: async () => ({}) } } } as unknown as OpenAIClientHandle["client"],
    model: "test-openai-model",
    baseURL: "http://localhost:8000/v1",
    thinkingEnabled: false,
    reasoningEffort: undefined,
    temperature: 0.7,
    debugLogEnabled: false,
    notify: false,
    env: {},
  } as unknown as OpenAIClientHandle;
}

/**
 * 受控脚本化 LLM 客户端（完整实现 LLMClient 接口，非 mock 框架产物）。
 *
 * - createMessageStream 按脚本（事件数组或按请求产出事件的函数）逐个 yield；
 * - 每次流迭代前检查 request.signal.aborted，已中断时抛 AbortError（模拟真实 SDK）；
 * - requestLog 记录每次请求的起止时间与请求体（串行化与附件注入断言依据）。
 */
export class ScriptedLLMClient implements LLMClient {
  readonly providerName = "anthropic" as const;
  readonly model = "claude-test";
  readonly baseURL = "http://localhost:8000/v1";
  readonly supportsThinking = true;
  readonly supportsPromptCaching = false;

  /** 已收到的请求日志（start/end 毫秒时间戳 + 请求对象引用） */
  readonly requestLog: Array<{ start: number; end: number | null; request: LLMRequest }> = [];

  /** 当前事件脚本（setScript 可在用例间切换，供同一服务器实例测试中断等场景） */
  private script: LLMStreamEvent[] | ((request: LLMRequest) => LLMStreamEvent[]);

  /**
   * @param script 事件脚本：固定数组，或按请求动态产出（无限流中断测试用）
   * @param yieldDelayMs 每个事件 yield 后的让出延时（串行化测试拉开时长用）
   */
  constructor(
    script: LLMStreamEvent[] | ((request: LLMRequest) => LLMStreamEvent[]),
    private readonly yieldDelayMs = 0
  ) {
    this.script = script;
  }

  /**
   * 切换事件脚本（用例间共享同一服务器/客户端实例时使用）。
   *
   * @param script 新的事件脚本
   */
  setScript(script: LLMStreamEvent[] | ((request: LLMRequest) => LLMStreamEvent[])): void {
    this.script = script;
  }

  /** 非流式调用（本测试路径不触达，返回最小合法响应） */
  async createMessage(_request: LLMRequest): Promise<LLMResponse> {
    return { content: "", thinking: "", toolCalls: [], stopReason: null, usage: null };
  }

  /** 流式调用：记录请求日志并按脚本产出事件，signal 中断时抛错 */
  async *createMessageStream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const logEntry = { start: Date.now(), end: null as number | null, request };
    this.requestLog.push(logEntry);
    try {
      const events = typeof this.script === "function" ? this.script(request) : this.script;
      for (const event of events) {
        if (request.signal?.aborted) {
          throw new Error("AbortError: stream aborted by consumer");
        }
        yield event;
        if (this.yieldDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.yieldDelayMs));
        }
        if (request.signal?.aborted) {
          throw new Error("AbortError: stream aborted by consumer");
        }
      }
    } finally {
      logEntry.end = Date.now();
    }
  }
}

/**
 * 构造测试用 ResolvedWebSettings（全部字段显式受控，绕开本机 settings.json 影响）。
 *
 * @param overrides 覆盖项（浅合并到默认受控值）
 * @returns 完整 ResolvedWebSettings
 */
export function createResolvedSettings(overrides: Partial<ResolvedWebSettings> = {}): ResolvedWebSettings {
  const base: ResolvedWebSettings = {
    projectRoot: "/tmp/deepcode-web-test-project",
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    allowRoots: [],
    uploadDir: "/tmp/deepcode-web-test-uploads",
    maxUploadBytes: 1024 * 1024,
    auth: {
      jwtSecret: "test-jwt-secret",
      sessionTtlSeconds: 3600,
      localUsers: [],
    },
    ldap: {
      enabled: false,
      server: "",
      port: 389,
      useSsl: false,
      baseDn: "",
      userFilter: "(uid=%s)",
      timeoutMs: 1000,
      attrs: {},
    },
  };
  return {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
    ldap: { ...base.ldap, ...(overrides.ldap ?? {}) },
  };
}

/** fetchJson 结果（状态码 / 响应头 / 解析后的 JSON 体） */
export type FetchJsonResult = {
  status: number;
  headers: Headers;
  body: any;
};

/**
 * 发送 JSON 请求并解析响应（测试用极简客户端，真实 HTTP IO）。
 *
 * @param port 目标端口
 * @param method HTTP 方法
 * @param pathname 请求路径
 * @param body 请求体对象（undefined 时不带 body）
 * @param cookie 可选 Cookie 头值
 * @returns 状态码 / 响应头 / JSON 体（body 解析失败时为 null）
 */
export async function fetchJson(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
  cookie?: string
): Promise<FetchJsonResult> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers["cookie"] = cookie;
  }
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

/**
 * 从登录响应提取认证 Cookie 值（deepcode_web_token=... 原样串，供后续请求回带）。
 *
 * @param headers 登录响应头
 * @returns Cookie 头值（如 "deepcode_web_token=xxx"）；未找到返回 null
 */
export function extractAuthCookie(headers: Headers): string | null {
  const cookies = headers.getSetCookie();
  for (const cookie of cookies) {
    if (cookie.startsWith("deepcode_web_token=")) {
      const pair = cookie.split(";")[0];
      return pair.trim();
    }
  }
  return null;
}

/** SSE 收集器：解析 event:/data: 帧并按名等待 */
export class SseCollector {
  /** 已解析的完整事件 */
  readonly events: Array<{ event: string; data: any }> = [];
  private readonly controller: AbortController;
  private readonly waiters: Array<{ event: string; resolve: (value: { event: string; data: any }) => void }> = [];

  constructor(controller: AbortController) {
    this.controller = controller;
  }

  /**
   * 启动后台消费 SSE 流（fetch 响应体按行解析）。
   *
   * @param response fetch 响应（body 为 SSE 文本流）
   */
  consume(response: Response): void {
    void (async () => {
      try {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // SSE 帧以空行分隔：逐帧解析 event:/data:
          let frameEnd: number;
          while ((frameEnd = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            const lines = frame.split("\n");
            let eventName = "message";
            let dataText = "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataText += line.slice(5).trim();
              }
            }
            if (dataText === "") {
              continue; // 心跳 comment 帧无 data，跳过
            }
            let data: any = null;
            try {
              data = JSON.parse(dataText);
            } catch {
              data = dataText;
            }
            const record = { event: eventName, data };
            this.events.push(record);
            // 唤醒等待该事件的 waiter（只匹配首个）
            const waiterIndex = this.waiters.findIndex((item) => item.event === eventName);
            if (waiterIndex >= 0) {
              const [waiter] = this.waiters.splice(waiterIndex, 1);
              waiter.resolve(record);
            }
          }
        }
      } catch {
        // 流被中断（abort/服务器关闭）即停止收集，测试以已收事件断言
      }
    })();
  }

  /**
   * 等待指定事件到达（已收到则立即返回）。
   *
   * @param event 事件名
   * @param timeoutMs 超时毫秒（超时 abort 流并 reject）
   * @returns 首个匹配的事件记录
   */
  async waitFor(event: string, timeoutMs: number): Promise<{ event: string; data: any }> {
    const existing = this.events.find((item) => item.event === event);
    if (existing) {
      return existing;
    }
    return new Promise<{ event: string; data: any }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.event === event);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        this.controller.abort();
        reject(
          new Error(
            `等待 SSE 事件 ${event} 超时（${timeoutMs}ms）；已收到：${this.events.map((e) => e.event).join(",")}`
          )
        );
      }, timeoutMs);
      this.waiters.push({
        event,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  /** 统计指定事件名出现次数 */
  countOf(event: string): number {
    return this.events.filter((item) => item.event === event).length;
  }
}

/**
 * 建立到 Web 服务器的 SSE 订阅（真实 HTTP 长连接）。
 *
 * @param port 目标端口
 * @param chatId 会话 id
 * @param cookie 认证 Cookie
 * @returns 收集器与 abort 控制器
 */
export async function openSseStream(
  port: number,
  chatId: string,
  cookie: string
): Promise<{ collector: SseCollector; controller: AbortController }> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/chats/${chatId}/stream`, {
    method: "GET",
    headers: { cookie },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    throw new Error(`SSE 订阅失败：HTTP ${response.status}`);
  }
  const collector = new SseCollector(controller);
  collector.consume(response);
  return { collector, controller };
}

/**
 * 在随机端口启动一个临时 HTTP 服务器（multipart 单测的接收端，真实 IO）。
 *
 * @param handler 请求处理函数（req/res 原样交给被测函数）
 * @returns { port, close }
 */
export async function startCaptureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * 手工构造 multipart/form-data 请求体（字节级真实协议，非工具库）。
 *
 * @param boundary boundary 字符串
 * @param parts part 列表（name 必填；filename 出现即为文件 part）
 * @returns 完整请求体 Buffer
 */
export function buildMultipartBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>
): Buffer {
  const segments: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      head += `; filename="${part.filename}"`;
    }
    head += "\r\n";
    if (part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType}\r\n`;
    }
    head += "\r\n";
    segments.push(Buffer.from(head, "utf8"), part.data, Buffer.from("\r\n", "utf8"));
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(segments);
}
