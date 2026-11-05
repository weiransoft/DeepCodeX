/**
 * 司南形象与声音配置的读取 hook
 *
 * 为什么单独一层：头像要显示在对话页（ChatPane）、语音开关要显示在输入框
 * （Composer）、完整配置在设置页（SoulPane）。三处都需要同一份数据，
 * 但都不该把配置往上提到 App 再逐层透传——那会让 App 多两个必填 props，
 * 每个用到 ChatPane 的地方都得跟着改。
 *
 * 读失败时**静默回落默认值**：配置读不到不该让对话页白屏，默认头像
 * 永远是可用状态。
 *
 * @module web/useSoulConfig
 */

import { useCallback, useEffect, useState } from "react";
import { fetchSoulConfig, type SoulConfigView } from "./api";
import { isAppleClient } from "./voice/preference";

/** 默认回落值（与后端 DEFAULT_SOUL_CONFIG 对齐；仅用于读失败时展示） */
const FALLBACK: SoulConfigView = {
  avatar: { kind: "default" },
  voice: {
    // 与后端同一套平台判断：本机有 MLX 语音模型的平台默认开
    enabled: isAppleClient(),
    engine: "qwen3-voicedesign",
    voice: "",
    speed: 1,
    endpoint: "",
    hasToken: false,
    speakReplies: isAppleClient(),
    wakeEnabled: false,
    wakeWord: "司南",
  },
  mode: "work",
  companion: { addressAs: "", warmth: 0.85, proactivity: 0.55, encourageHumanContact: true },
  filePath: "",
  presets: [],
  modes: [],
  companionPresets: [],
};

/**
 * 读取配置
 *
 * @returns 配置 + 重新加载函数 + 加载态
 */
export function useSoulConfig(): {
  config: SoulConfigView;
  loading: boolean;
  reload: () => void;
} {
  const [config, setConfig] = useState<SoulConfigView>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSoulConfig()
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        if (!cancelled) setConfig(FALLBACK);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { config, loading, reload };
}
