/**
 * 语音偏好：免按住开关的单一来源
 *
 * ## 为什么不用服务端配置
 *
 * 「点一下说话」是**这台设备上的交互习惯**，不是人格设定：手机想免按住、
 * 坐在嘈杂工位想按住说话，换台机器就该有不同的默认。放 localStorage，
 * 跟着浏览器走；放 `~/.deepcode/soul/config.json` 反而会让另一台机器莫名其妙。
 *
 * ## 为什么要有事件
 *
 * 开关在设置面板，生效在输入框，两个组件各自持有一个 `useVoiceTalk`/状态。
 * 不给它们建 provider（为一个小开关包一层 Context 不划算），改用
 * 「写 localStorage + 派发一个自定义事件」：面板写，输入区订阅。同页内即时生效，
 * 跨标签页再由 `storage` 事件兜住。
 *
 * @module web/voice/preference
 */

/** 存储键 */
export const HANDS_FREE_KEY = "dcx.voice.handsFree";

/** 同页内广播的事件名 */
export const HANDS_FREE_EVENT = "dcx:voice-hands-free";

/**
 * 客户端是否 Apple 平台
 *
 * 只看 UA，不问服务端：这个默认值是**设备上的交互习惯**，跟服务端跑在
 * 哪台机器无关。desktop 版两者同机，结论一致；Web 版也不该因为服务器
 * 是 Linux 就把 Mac 用户的免按住关掉。
 *
 * @returns 是否 Apple 设备（Mac / iPad，iPad 的 UA 也含 Macintosh）
 */
export function isAppleClient(): boolean {
  try {
    const ua = globalThis.navigator?.userAgent ?? "";
    return /Macintosh|Mac OS X|iPhone|iPad/.test(ua);
  } catch {
    return false;
  }
}

/**
 * 免按住的平台默认值
 *
 * Mac 默认开、Windows 默认关——与语音总开关同一条判断：
 * 没有本地语音模型时这个开关调了也没有意义。
 *
 * @returns 默认是否免按住
 */
export function defaultHandsFree(): boolean {
  return isAppleClient();
}

/**
 * 读取免按住偏好
 *
 * @param fallback 存储不可用时的默认值（默认按平台）
 * @returns 是否免按住
 */
export function readHandsFree(fallback = defaultHandsFree()): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(HANDS_FREE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // 隐私模式/无 localStorage：用默认值
  }
  return fallback;
}

/**
 * 写入免按住偏好并广播
 *
 * @param value 是否免按住
 */
export function writeHandsFree(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(HANDS_FREE_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(HANDS_FREE_EVENT, { detail: value }));
  } catch {
    // 无 window（测试环境）时忽略
  }
}

/**
 * 订阅免按住变化（同页事件 + 跨标签页 storage 事件）
 *
 * @param handler 变化回调
 * @returns 取消订阅
 */
export function subscribeHandsFree(handler: (value: boolean) => void): () => void {
  const onCustom = (event: Event): void => {
    handler((event as CustomEvent<boolean>).detail === true);
  };
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    if (key === null || key === HANDS_FREE_KEY) handler(readHandsFree());
  };
  globalThis.addEventListener?.(HANDS_FREE_EVENT, onCustom);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(HANDS_FREE_EVENT, onCustom);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/*
 * 流式播放开关
 *
 * 同样是「这台设备上的偏好」而不是人格设定，所以跟着 localStorage 走。
 *
 * **默认关**（2026-11-06 真机反馈后改的）。流式首字延迟确实好（实测
 * 3.59s → 0.41s），但 `speed != 1.0` 时服务端要对每个 0.8s chunk 独立
 * 做一次 WSOLA 保调变速，而 WSOLA 是离线算法、状态不能跨块延续：实测
 * 块边界样本跳变从 speed=1.0 的中位 0.1%/最大 1.2% 涨到 2.8%/19.4%。
 * 用户听到的就是「前后两句语速不一样」「讲了几句中间像断了一下」。
 *
 * 整块链路对整段波形只做一次 WSOLA，没有这个边界问题。先把默认切回
 * 稳定链路，流式留作可选项；等变速改成跨 chunk 有状态再默认打开。
 */
export const STREAM_PLAYBACK_KEY = "dcx.voice.streamPlayback";
export const STREAM_PLAYBACK_EVENT = "dcx:voice-stream-playback";

/** 流式播放默认值：关（见上方实测说明） */
export function defaultStreamPlayback(): boolean {
  return false;
}

/**
 * 读取流式播放偏好
 *
 * @param fallback 存储不可用时的默认值
 * @returns 是否启用流式播放
 */
export function readStreamPlayback(fallback = defaultStreamPlayback()): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(STREAM_PLAYBACK_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // 隐私模式/无 localStorage：用默认值
  }
  return fallback;
}

/** 写入流式播放偏好并广播 */
export function writeStreamPlayback(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(STREAM_PLAYBACK_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(STREAM_PLAYBACK_EVENT, { detail: value }));
  } catch {
    // 无 window（测试环境）时忽略
  }
}

/** 订阅流式播放变化（同页事件 + 跨标签页 storage 事件） */
export function subscribeStreamPlayback(handler: (value: boolean) => void): () => void {
  const onCustom = (event: Event): void => {
    handler((event as CustomEvent<boolean>).detail === true);
  };
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    if (key === null || key === STREAM_PLAYBACK_KEY) handler(readStreamPlayback());
  };
  globalThis.addEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
