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
 * **默认开**（2026-11-06 第二轮）。流式首字延迟实测 3.59s → 0.41s（约 8.7×）。
 * 上一轮之所以临时关掉，是因为 `speed != 1.0` 时服务端对每个 0.8s chunk
 * 独立做一次 WSOLA 保调变速，而 WSOLA 是重叠相加算法、状态不能跨块延续：
 * 块边界样本跳变中位 2.8%/最大 19.4%（speed=1.0 只有 0.1%/1.2%），听感是
 * 「前后两句语速不一样」「讲了几句中间像断了一下」。
 *
 * 现在服务端 `StreamingWsola` 让整个请求共用一条变速时间轴，分块喂入与整段
 * 一次变速**逐样本相等**（`test_streaming_wsola.py` 锁住），边界不再重启窗
 * 函数。根因消除，默认切回流式；整块链路仍作为用户手动关闭时的回退。
 *
 * ## 为什么换存储键
 *
 * 上一版默认关，可能有人手动关过、留下 `"0"`。这次是**修复后重新默认开**，
 * 不该让旧版本的实验性选择继续压着新默认值，所以升到 `.v2`：读到旧键就
 * 一次性删掉并采用新默认。用户之后手动关会写 v2 的 `"0"`，仍会被尊重。
 */
export const STREAM_PLAYBACK_KEY = "dcx.voice.streamPlayback.v2";
/** 上一版（逐块独立变速）的键：升级时一次性清理，不继承值 */
const LEGACY_STREAM_PLAYBACK_KEY = "dcx.voice.streamPlayback";
export const STREAM_PLAYBACK_EVENT = "dcx:voice-stream-playback";

/** 流式播放默认值：开（跨 chunk 有状态 WSOLA 已消除边界失真） */
export function defaultStreamPlayback(): boolean {
  return true;
}

/**
 * 读取流式播放偏好
 *
 * @param fallback 存储不可用时的默认值
 * @returns 是否启用流式播放
 */
export function readStreamPlayback(fallback = defaultStreamPlayback()): boolean {
  try {
    const store = globalThis.localStorage;
    const raw = store?.getItem(STREAM_PLAYBACK_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    // 没有 v2 值 = 升级后的第一次读取。旧键是上一版「逐块独立变速」时代
    // 留下的实验性开关，不继承（见文件头说明），清掉后回到新的默认开。
    store?.removeItem(LEGACY_STREAM_PLAYBACK_KEY);
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
    // 旧键被清理时也会跨标签页广播，顺带让那一页重读一次新默认值
    if (key === null || key === STREAM_PLAYBACK_KEY || key === LEGACY_STREAM_PLAYBACK_KEY) {
      handler(readStreamPlayback());
    }
  };
  globalThis.addEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
