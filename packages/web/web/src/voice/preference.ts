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
 * 读取免按住偏好
 *
 * @param fallback 存储不可用时的默认值
 * @returns 是否免按住
 */
export function readHandsFree(fallback = true): boolean {
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
