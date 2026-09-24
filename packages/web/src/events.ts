/**
 * SSE 事件总线（docs/dev/web-ui.md §3.1 D2 / §3.5）。
 *
 * per-chatId 维护订阅者集合：
 * - subscribe(chatId, res)：写 SSE 响应头（text/event-stream、no-cache），注册 15s 心跳
 *   comment ping，连接断开自动清理，返回退订函数；
 * - publish(chatId, event, data)：向该 chatId 的全部订阅者推送 event/data 帧；
 * - 内部经 addSink(chatId, sink) 缝合点注册订阅者（依赖注入缝合点：
 *   单元测试可注入真实受控 sink 而无需构造 HTTP 连接）。
 */

import type { ServerResponse } from "node:http";
import type { SseEventName } from "./types";

/** 心跳间隔（毫秒）：SSE comment ping，防代理/连接空闲超时 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** 订阅者抽象：HTTP ServerResponse 与测试受控 sink 的共同最小接口 */
export type SseSink = {
  /**
   * 原样写出一帧字节（已按 SSE 协议编码）。
   *
   * @param chunk 待写字节
   * @returns 连接是否仍然有效（失效时总线会在 publish 时剔除并 close 该订阅者）。
   *          注意：HTTP 实现不得把 res.write 的背压返回值（false = 缓冲满）当作失效，
   *          失效判据应为 res.destroyed / res.writableEnded。
   */
  write(chunk: string | Uint8Array): boolean;
  /** 关闭底层连接（publish 时发现订阅者失效/服务关闭时调用） */
  close(): void;
};

/** 单个订阅者内部记录（sink + 心跳定时器） */
type SseSubscriber = {
  sink: SseSink;
  heartbeat: ReturnType<typeof setInterval>;
};

/**
 * SSE 事件总线。
 */
export class SseHub {
  /** chatId → 订阅者集合 */
  private readonly subscribers = new Map<string, Set<SseSubscriber>>();

  /**
   * 注册一个底层 sink 订阅者（依赖注入缝合点）。
   *
   * sink 需自行保证 write 失败时可通过返回 false 通知总线；总线在 publish 时
   * 检测到失败会主动剔除并 close 该订阅者。
   *
   * @param chatId 聊天会话 id
   * @param sink 数据汇目标
   * @returns 退订函数（幂等）
   */
  addSink(chatId: string, sink: SseSink): () => void {
    const subscriber: SseSubscriber = {
      sink,
      // 15s 心跳 comment ping：保持连接活跃并探测断连
      heartbeat: setInterval(() => {
        const alive = sink.write(`: ping ${Date.now()}\n\n`);
        if (!alive) {
          this.remove(chatId, subscriber);
        }
      }, HEARTBEAT_INTERVAL_MS),
    };
    let set = this.subscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.subscribers.set(chatId, set);
    }
    set.add(subscriber);

    // 返回退订函数（幂等）
    return () => {
      this.remove(chatId, subscriber);
    };
  }

  /**
   * 为 HTTP 响应建立 SSE 订阅。
   *
   * 写入 SSE 标准响应头并 flush，随后按 addSink 语义注册；
   * 连接 close 事件自动清理订阅与心跳定时器。
   *
   * @param chatId 聊天会话 id
   * @param res HTTP 响应对象
   * @returns 退订函数（幂等）
   */
  subscribe(chatId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // 禁用 Nginx 等反向代理的响应缓冲
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    const unsubscribe = this.addSink(chatId, {
      // 关键语义：res.write 返回 false 仅代表「内核/Node 发送缓冲已满（背压）」，
      // 连接仍然健康。若把 false 当作失效并剔除订阅者，大流量 delta 洪峰（长回复）
      // 会误删订阅者，导致后续 status / done 帧永远无法送达（前端收不到收尾事件）。
      // 这里以 destroyed / writableEnded 作为失效判据；背压数据由 Node 内部缓冲
      // 自然排空，无需手动等待 drain（SSE 帧体量小，内存占用可忽略）。
      write: (chunk) => {
        if (res.destroyed || res.writableEnded) {
          return false;
        }
        res.write(chunk);
        return true;
      },
      close: () => res.end(),
    });
    // 连接断开自动清理（退订 + 心跳定时器）。
    // T7 语义边界：此处只做订阅簿记清理——浏览器断开 ≠ 用户中断，
    // 绝不触发引擎 interrupt/abort；轮次继续在服务端执行到自然完成。
    res.on("close", unsubscribe);
    return unsubscribe;
  }

  /**
   * 向指定 chatId 的全部订阅者推送一帧 SSE 事件。
   *
   * 帧格式（docs/dev/web-ui.md §3.5）：
   *   event: <event>\n
   *   data: <json>\n\n
   *
   * @param chatId 聊天会话 id
   * @param event 事件名（llm_delta / assistant_message / permission_request / status / done 等）
   * @param data 事件载荷（JSON 序列化）
   */
  publish(chatId: string, event: SseEventName, data: unknown): void {
    const set = this.subscribers.get(chatId);
    if (!set || set.size === 0) {
      return;
    }
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    // 拷贝集合快照遍历，避免退订过程中修改集合导致跳过/重入问题
    for (const subscriber of [...set]) {
      const alive = subscriber.sink.write(frame);
      if (!alive) {
        this.remove(chatId, subscriber);
      }
    }
  }

  /**
   * 当前指定 chatId 的订阅者数量（测试/观测用）。
   *
   * @param chatId 聊天会话 id
   * @returns 订阅者数量
   */
  subscriberCount(chatId: string): number {
    return this.subscribers.get(chatId)?.size ?? 0;
  }

  /**
   * 关闭全部订阅（服务器优雅关闭时调用）：清心跳并关闭底层连接。
   */
  closeAll(): void {
    for (const [chatId, set] of this.subscribers) {
      for (const subscriber of [...set]) {
        clearInterval(subscriber.heartbeat);
        try {
          subscriber.sink.close();
        } catch {
          // 连接可能已关闭，尽力而为
        }
      }
      set.clear();
      this.subscribers.delete(chatId);
    }
  }

  /**
   * 移除单个订阅者（内部方法）：清心跳并从集合剔除。
   *
   * @param chatId 聊天会话 id
   * @param subscriber 订阅者记录
   */
  private remove(chatId: string, subscriber: SseSubscriber): void {
    clearInterval(subscriber.heartbeat);
    const set = this.subscribers.get(chatId);
    if (!set) {
      return;
    }
    set.delete(subscriber);
    if (set.size === 0) {
      this.subscribers.delete(chatId);
    }
  }
}
