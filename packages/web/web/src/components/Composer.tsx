/**
 * 底部输入框 Composer（设计文档 §4）：
 * - 多行文本（自适应高度；Enter 发送 / Shift+Enter 换行；中文输入法 composition 保护）；
 * - 本地附件：点击回形针选择 / 拖拽高亮上传 / 图片粘贴（paste 捕获 clipboardData.files 中 image/*）；
 * - 附件 chips（图标直显，图片带缩略预览，URL.createObjectURL 并在移除时 revoke）；
 * - 服务器附件（文件抽屉"作为附件插入对话"）以 serverFiles 传入，一并展示与发送；
 * - 发送/停止按钮位：生成中显示停止（中断请求由 App 转发到 POST /interrupt）；
 * - steering F1（docs/dev/web-steering.md）：steeringEnabled 时生成中不禁用输入，
 *   用户可随时发送补充指令（后端分类注入或排队），发送与停止按钮并排同显；
 * - @ 提及补全（web-capability T2）：输入 @ 触发候选面板（技能 / Agent / MCP 服务器），
 *   键盘上下选择、Enter/Tab 补全、Esc 关闭；数据源 GET /api/capabilities（懒加载缓存）。
 * - 斜杠命令补全（2026-11-02 接线审查 D3）：输入以 `/` 开头时提示可用命令
 *   （当前为 /team 体系）。清单由服务端下发、来源是 core 的命令描述符单一数据源，
 *   前端不再自己维护一份命令表。
 * - 「+」能力菜单（2026-11-02，对齐 WorkBuddy 输入框）：一个入口切换 模型 / 技能 / 智能体。
 *   技能与智能体等价于插入 @token（与 @ 补全同源）；模型为桌面壳侧默认模型切换
 *   （模型经进程环境变量注入引擎，切换必然重启，故先确认）。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { humanSize } from "../format";
import type { UserAttachment } from "../chat-model";
import { fetchCapabilities, type Capabilities, type CapabilityCommand } from "../api";
import { agentDisplayName, agentMentionHint } from "../agent-display";
import { listModels, setDefaultModel, type ModelOption } from "../desktopConfig";
import {
  BotAvatarIcon,
  CloseIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  WrenchIcon,
} from "./icons";

/** Composer 组件属性 */
export interface ComposerProps {
  /** 生成中：发送按钮切换为停止（steeringEnabled 时发送与停止并排同显） */
  streaming: boolean;
  /** 任务执行中补充指令开关（docs/dev/web-steering.md W7）：false 时生成中禁用输入（旧行为） */
  steeringEnabled: boolean;
  /** 单文件大小上限（来自 /api/config，超出即拒绝并提示） */
  maxUploadBytes: number;
  /** 服务器附件（文件抽屉插入的路径引用） */
  serverFiles: UserAttachment[];
  /** 移除服务器附件 */
  onRemoveServerFile: (index: number) => void;
  /**
   * 发送回调。
   * @param text        文本内容
   * @param localFiles  本地附件（走 multipart file 字段）
   * @param serverFiles 服务器路径附件（图片走 imageUrls，其余并入文本引用）
   */
  onSend: (text: string, localFiles: File[], serverFiles: UserAttachment[]) => void;
  /** 停止生成 */
  onStop: () => void;
}

/** @ 提及候选条目（统一技能 / Agent / MCP 三类为同一展示模型） */
interface MentionItem {
  /** 补全后插入的名字（@ 后面的 token） */
  token: string;
  /** 展示名（Agent 有中文名时与 token 不同；技能/MCP 同 token） */
  label: string;
  /** 种类徽标文案 */
  kindLabel: string;
  /** 说明（技能 description / MCP command） */
  description: string;
  /** 种类样式类（mention-badge-skill / -agent / -mcp） */
  kindClass: string;
}

/** 从文件名猜测展示图标（图片/代码/普通文件） */
function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) return <FileImageIcon size={14} />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|c|cpp|h|css|html|md|sh|ya?ml|toml)$/i.test(name)) {
    return <FileCodeIcon size={14} />;
  }
  return <FileIcon size={14} />;
}

/**
 * 解析光标前的 @ 提及上下文：
 * 匹配「行首或空白后的 @token」（token 不含空白与 @），返回 token 起止下标
 * （含 @）与查询词；光标不在 @ token 内时返回 null。
 */
function parseMentionContext(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m === null) return null;
  const atStart = before.length - m[0].length + m[0].indexOf("@");
  return { start: atStart, end: caret, query: m[1] ?? "" };
}

/**
 * 解析斜杠命令补全上下文（2026-11-02 接线审查 D3）。
 *
 * 触发条件刻意收紧：命令必须从**输入开头**（允许前导空白）开始，且光标仍在
 * 第一个 token 内。理由——对话里经常出现路径（`/usr/local/bin`）、分数
 * （`10/12`）这类文本，宽松匹配会让补全面板在正常打字时反复弹出。
 *
 * @param text 全文
 * @param caret 光标位置
 * @returns 替换区间（start 指向 `/`）与查询词；不处于命令输入态时返回 null
 */
function parseSlashContext(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /^(\s*)(\/[^\s]*)$/.exec(before);
  if (m === null) return null;
  const start = (m[1] ?? "").length;
  // 命令 token 后若还有内容（已带参数），收窄到当前 token 末
  const rest = text.slice(caret);
  const tail = /^[^\s]*/.exec(rest)?.[0] ?? "";
  return { start, end: caret + tail.length, query: `${m[2] ?? ""}${tail}` };
}

/**
 * 由命令清单构建斜杠候选（2026-11-02 接线审查 D3）。
 *
 * 命中规则：命令名以查询词开头优先（用户通常从左往右敲），完整包含次之。
 * 额外补一条裸 `/team`——它是帮助入口，而 core 的描述符里只有带子命令的项，
 * 不补的话用户敲 `/team` 后看到空面板。
 *
 * 描述里的 Markdown 强调标记（`**真实执行**`）在补全面板里没有渲染管线，
 * 直接显示会露出星号，这里统一剥掉。
 *
 * @param commands 服务端下发的命令清单
 * @param query 当前输入的命令前缀（形如 `/te`，空串表示刚敲下 `/`）
 * @returns 最多 8 条候选（起始匹配在前、包含匹配在后）
 */
export function buildSlashCandidates(commands: readonly CapabilityCommand[], query: string): CapabilityCommand[] {
  const q = query.toLowerCase();
  const starts: CapabilityCommand[] = [];
  const contains: CapabilityCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) starts.push(command);
    else if (q !== "" && name.includes(q)) contains.push(command);
  }
  const items = [...starts, ...contains];
  if ("/team".startsWith(q) && !items.some((item) => item.name === "/team")) {
    items.unshift({ name: "/team", description: "团队模式命令总览（等价 /team help）" });
  }
  return items.slice(0, 8).map((item) => ({
    ...item,
    description: item.description.replace(/\*\*/g, ""),
    ...(item.args !== undefined ? { args: [...item.args] } : {}),
  }));
}

/** Composer：底部输入框 */ export function Composer(props: ComposerProps) {
  const { streaming, steeringEnabled, maxUploadBytes, serverFiles, onRemoveServerFile, onSend, onStop } = props;
  /**
   * 输入区是否禁用（steering F1）：steeringEnabled 时生成中仍可输入补充指令；
   * 关闭时回退旧行为（生成中禁用 textarea/附件/发送）。
   * 注意：不存在「无会话禁用」——无选中会话时发送由 App 自动新建会话承载。
   */
  const inputBlocked = streaming && !steeringEnabled;

  /** 输入文本 */
  const [text, setText] = useState("");
  /** 本地附件列表 */
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  /** 图片缩略预览的 ObjectURL（name → url，移除/卸载时 revoke 防泄漏） */
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  /** 拖拽悬停高亮 */
  const [dragOver, setDragOver] = useState(false);
  /** 行内错误提示（超限文件名等） */
  const [error, setError] = useState("");
  /** 隐藏的文件选择 input 引用 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** textarea 引用：自适应高度 */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 中文输入法组合输入中（回车不应触发发送/补全） */
  const composingRef = useRef(false);
  /** 全部已创建的 ObjectURL 登记（卸载时统一 revoke，防内存泄漏） */
  const allObjectUrlsRef = useRef<Set<string>>(new Set());

  /** 能力清单（技能/Agent/MCP；首个 @ 懒加载，30s TTL 缓存） */
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const capsFetchedAtRef = useRef(0);
  const capsLoadingRef = useRef(false);
  /** @ 提及状态：null = 面板关闭；否则为解析出的替换区间 + 候选 + 高亮项 */
  const [mention, setMention] = useState<{
    range: { start: number; end: number; query: string };
    items: MentionItem[];
    active: number;
  } | null>(null);
  /**
   * 斜杠命令补全状态（2026-11-02 接线审查 D3）：null = 面板关闭。
   * 与 @ 提及互斥——命令只在输入开头出现，两个面板不会同时打开。
   */
  const [slash, setSlash] = useState<{
    range: { start: number; end: number; query: string };
    items: CapabilityCommand[];
    active: number;
  } | null>(null);

  /**
   * 「+」能力菜单（模型 / 技能 / 智能体）。null = 关闭。
   * 模型列表懒加载（首次打开才向桌面壳要），非桌面环境（纯浏览器）恒为空 → 只显示技能/智能体。
   */
  const [menu, setMenu] = useState<null | { tab: "model" | "skill" | "agent" }>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [menuError, setMenuError] = useState("");
  /** 模型切换中（重启引擎需 1~3s，期间禁重复点击） */
  const [switchingModel, setSwitchingModel] = useState(false);

  /** 懒加载能力清单（30s TTL；失败静默——面板仅展示空态） */
  const ensureCaps = (): void => {
    const now = Date.now();
    if (capsLoadingRef.current || now - capsFetchedAtRef.current < 30_000) return;
    capsLoadingRef.current = true;
    fetchCapabilities()
      .then((data) => {
        setCaps(data);
        capsFetchedAtRef.current = Date.now();
      })
      .catch(() => {
        // 失败不缓存：下次 @ 再试
        capsFetchedAtRef.current = 0;
      })
      .finally(() => {
        capsLoadingRef.current = false;
      });
  };

  /** 由能力清单构建候选（按查询词过滤；技能/Agent/MCP 依次排列） */
  const buildMentionItems = (data: Capabilities | null, query: string): MentionItem[] => {
    if (data === null) return [];
    const q = query.toLowerCase();
    const hit = (name: string): boolean => q === "" || name.toLowerCase().includes(q);
    const items: MentionItem[] = [];
    for (const s of data.skills) {
      if (s.kind === "skill" && hit(s.name)) {
        items.push({
          token: s.name,
          label: s.name,
          kindLabel: "技能",
          description: s.description,
          kindClass: "mention-badge-skill",
        });
      }
    }
    for (const s of data.skills) {
      if (s.kind === "agent") {
        // 中文名与英文标识都能过滤：用户可能记得「产品经理」，也可能记得 token
        const label = agentDisplayName(s);
        if (!hit(s.name) && !hit(label)) continue;
        items.push({
          token: s.name,
          label,
          kindLabel: "Agent",
          description: s.description,
          kindClass: "mention-badge-agent",
        });
      }
    }
    for (const m of data.mcpServers) {
      if (hit(m.name)) {
        items.push({
          token: m.name,
          label: m.name,
          kindLabel: "MCP",
          description: m.command,
          kindClass: "mention-badge-mcp",
        });
      }
    }
    return items.slice(0, 8);
  };

  /**
   * 刷新 @ 提及面板：按光标位置重新解析上下文并计算候选。
   * 光标位置从 textarea 实时读取（change / click / keyup 后均为最新）。
   */
  const refreshMention = (value: string): void => {
    const el = textareaRef.current;
    const caret = el !== null ? (el.selectionStart ?? value.length) : value.length;
    const ctx = parseMentionContext(value, caret);
    if (ctx === null) {
      setMention(null);
      return;
    }
    ensureCaps();
    const items = buildMentionItems(caps, ctx.query);
    if (items.length === 0) {
      setMention({ range: ctx, items, active: -1 });
      return;
    }
    setMention((prev) => ({ range: ctx, items, active: prev !== null ? Math.min(prev.active, items.length - 1) : 0 }));
  };

  /** 应用选中候选：把 @query 替换为 @token 并把光标落到补全文本之后 */
  const applyMention = (item: MentionItem): void => {
    const el = textareaRef.current;
    if (mention === null) return;
    const { start, end } = mention.range;
    const inserted = `@${item.token} `;
    const next = text.slice(0, start) + inserted + text.slice(end);
    setText(next);
    setMention(null);
    if (el !== null) {
      const caret = start + inserted.length;
      // React 受控更新后异步定位光标
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  };

  /**
   * 由服务端命令清单构建斜杠候选（2026-11-02 接线审查 D3）。
   *
   * 命中规则：命令名以查询词开头优先（用户通常从左往右敲），完整包含次之。
   * 额外补一条裸 `/team`——它是帮助入口，而 core 的描述符里只有带子命令的项，
   * 不补的话用户敲 `/team` 后看到空面板。
   */
  const buildSlashItems = (data: Capabilities | null, query: string): CapabilityCommand[] =>
    buildSlashCandidates(data?.commands ?? [], query);

  /** 刷新斜杠命令面板：光标处于命令输入态时打开，否则关闭 */
  const refreshSlash = (value: string): void => {
    const el = textareaRef.current;
    const caret = el !== null ? (el.selectionStart ?? value.length) : value.length;
    const ctx = parseSlashContext(value, caret);
    if (ctx === null) {
      setSlash(null);
      return;
    }
    ensureCaps();
    const items = buildSlashItems(caps, ctx.query);
    setSlash((prev) => ({
      range: ctx,
      items,
      active: prev !== null ? Math.min(prev.active, Math.max(items.length - 1, 0)) : 0,
    }));
    // 与 @ 提及互斥（命令在输入开头，@ 不会同时在光标前）
    setMention(null);
  };

  /** 应用选中命令：把当前命令 token 替换为完整命令名并把光标落到其后 */
  const applySlash = (item: CapabilityCommand): void => {
    const el = textareaRef.current;
    if (slash === null) return;
    const { start, end } = slash.range;
    const inserted = `${item.name} `;
    const next = text.slice(0, start) + inserted + text.slice(end);
    setText(next);
    setSlash(null);
    if (el !== null) {
      const caret = start + inserted.length;
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }
  };

  // 组件卸载时释放全部 ObjectURL
  useEffect(() => {
    const urls = allObjectUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  /**
   * 在光标处插入 `@token `（技能 / 智能体统一入口）。
   *
   * 与 @ 补全的区别只在于触发方式：菜单点选时若光标正好停在一个 @ 片段上，
   * 复用同一替换区间（避免出现 `@old@new`）；否则纯插入。
   */
  const insertToken = (token: string): void => {
    const el = textareaRef.current;
    const caret = el !== null ? (el.selectionStart ?? text.length) : text.length;
    const ctx = parseMentionContext(text, caret);
    const inserted = `@${token} `;
    const start = ctx !== null ? ctx.start : caret;
    const next =
      ctx !== null
        ? text.slice(0, start) + inserted + text.slice(ctx.end)
        : text.slice(0, caret) + inserted + text.slice(caret);
    setText(next);
    setMention(null);
    if (el !== null) {
      const nextCaret = start + inserted.length;
      window.requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
      });
    }
  };

  /**
   * 打开「+」菜单：技能/智能体复用能力缓存（与 @ 补全同源），模型向桌面壳懒加载。
   * 加载失败不阻塞菜单（降级为空列表 + 一句可操作提示），技能/智能体仍可用。
   */
  const openMenu = (tab: "model" | "skill" | "agent"): void => {
    setMenuError("");
    setMenu({ tab });
    if (tab !== "model") {
      ensureCaps();
      return;
    }
    if (models !== null) return;
    listModels()
      .then(setModels)
      .catch((e: unknown) => {
        // 纯浏览器 / 隧道页：壳侧会拒绝——明确告诉用户去哪儿配置，而不是静默空列表
        setModels([]);
        setMenuError(e instanceof Error ? e.message : "模型列表不可用");
      });
  };

  /**
   * 切换默认模型：确认 → 壳侧改写配置并重启引擎（页面随后自动跳转到新引擎）。
   *
   * 为什么要确认：模型是进程环境变量注入的，切换必然重启，进行中的对话会中断。
   */
  const switchModel = (item: ModelOption): void => {
    if (switchingModel || item.isDefault || !item.enabled) return;
    const ok = window.confirm(`切换到「${item.name}」需要重启引擎（进行中的对话会中断），是否继续？`);
    if (!ok) return;
    setSwitchingModel(true);
    setMenuError("");
    setDefaultModel(item.id)
      .then(() => {
        // 壳已重启并导航到新引擎地址：页面即将重载，这里无需更新状态
        setMenu(null);
      })
      .catch((e: unknown) => {
        setMenuError(e instanceof Error ? e.message : "切换模型失败");
      })
      .finally(() => setSwitchingModel(false));
  };

  /** 追加本地文件：校验大小上限；图片建立缩略预览 */
  const addFiles = (files: FileList | File[]): void => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(files)) {
      // 仅在拿到有效上限时校验（配置未就绪时不误拒）
      if (maxUploadBytes > 0 && f.size > maxUploadBytes) {
        // 超出服务端上限：明确拒绝并提示（避免 202 后上传才失败）
        rejected.push(`${f.name}（超过 ${humanSize(maxUploadBytes)}）`);
        continue;
      }
      accepted.push(f);
    }
    if (rejected.length > 0) setError(`以下文件未添加：${rejected.join("、")}`);
    else setError("");
    if (accepted.length === 0) return;

    setLocalFiles((prev) => [...prev, ...accepted]);
    setPreviews((prev) => {
      const next = new Map(prev);
      for (const f of accepted) {
        if (f.type.startsWith("image/")) {
          const url = URL.createObjectURL(f);
          allObjectUrlsRef.current.add(url);
          next.set(f.name, url);
        }
      }
      return next;
    });
  };

  /** 移除本地附件（同时释放预览 URL） */
  const removeFile = (index: number): void => {
    setLocalFiles((prev) => {
      const target = prev[index];
      if (target !== undefined) {
        setPreviews((m) => {
          const url = m.get(target.name);
          if (url !== undefined) {
            URL.revokeObjectURL(url);
            const next = new Map(m);
            next.delete(target.name);
            return next;
          }
          return m;
        });
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  /** 粘贴：捕获剪贴板中的图片文件（image/*）加入附件 */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = e.clipboardData?.files;
    if (files !== undefined && files.length > 0) {
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (images.length > 0) {
        e.preventDefault(); // 阻止默认插入文件路径文本
        addFiles(images);
      }
    }
  };

  /** 拖拽放下：收集全部文件 */
  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  /** 键盘发送：Enter 发送（IME 组合中除外），Shift+Enter 换行；
   *  @ 面板 / 斜杠命令面板打开时优先消费方向键 / Enter / Tab / Escape（不发送）。 */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
      // 斜杠命令面板打开且有高亮候选：Enter = 补全（不发送）
      if (slash !== null && slash.active >= 0 && slash.items.length > 0) {
        e.preventDefault();
        applySlash(slash.items[slash.active]!);
        return;
      }
      // @ 面板打开且有高亮候选：Enter = 补全（不发送）
      if (mention !== null && mention.active >= 0 && mention.items.length > 0) {
        e.preventDefault();
        void applyMention(mention.items[mention.active]);
        return;
      }
      e.preventDefault();
      doSend();
      return;
    }
    // 斜杠命令面板优先（与 @ 面板互斥，正常不会同时打开）
    if (slash !== null && slash.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlash((s) => (s !== null ? { ...s, active: (s.active + 1) % s.items.length } : s));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlash((s) => (s !== null ? { ...s, active: (s.active - 1 + s.items.length) % s.items.length } : s));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applySlash(slash.items[Math.max(slash.active, 0)]!);
        return;
      }
    }
    if (mention !== null && mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) => (m !== null ? { ...m, active: (m.active + 1) % m.items.length } : m));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => (m !== null ? { ...m, active: (m.active - 1 + m.items.length) % m.items.length } : m));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        void applyMention(mention.items[Math.max(mention.active, 0)]);
        return;
      }
    }
    if (e.key === "Escape" && slash !== null) {
      e.preventDefault();
      setSlash(null);
      return;
    }
    if (e.key === "Escape" && mention !== null) {
      e.preventDefault();
      setMention(null);
      return;
    }
    if (e.key === "Escape" && menu !== null) {
      e.preventDefault();
      setMenu(null);
    }
  };

  /** 执行发送：有内容或附件才触发；发送后清空本地状态 */
  const doSend = (): void => {
    if (inputBlocked) return;
    const trimmed = text.trim();
    if (trimmed === "" && localFiles.length === 0 && serverFiles.length === 0) return;
    onSend(trimmed, localFiles, serverFiles);
    setText("");
    setLocalFiles([]);
    setPreviews((m) => {
      for (const url of m.values()) URL.revokeObjectURL(url);
      return new Map();
    });
    setError("");
    setMention(null);
    setSlash(null);
  };

  /** textarea 自适应高度（上限 200px 后内部滚动） */
  const autoResize = (): void => {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  /** 可发送：输入未被阻塞（生成中且 steering 关闭时阻塞）且有文本或附件 */
  const canSend = !inputBlocked && (text.trim() !== "" || localFiles.length > 0 || serverFiles.length > 0);

  return (
    <div
      className={`composer${dragOver ? " composer-dragover" : ""}`}
      // 拖拽上传：dragover 必须阻止默认行为，drop 事件才会触发
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 仅当离开整个 composer 容器时取消高亮（子元素间移动不触发）
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {/* 拖拽高亮遮罩文案 */}
      {dragOver && <div className="composer-drag-tip">松开以添加附件</div>}

      {/* 斜杠命令候选面板（2026-11-02 接线审查 D3）：
          清单来自服务端下发的 core 命令描述符，选中即把命令名补进输入框，
          用户接着敲参数（如 `--task "..."`）。 */}
      {slash !== null && (
        <div className="composer-mention" role="listbox" aria-label="斜杠命令候选">
          <div className="composer-mention-title">命令（↑↓ 选择，Enter 补全，Esc 关闭）</div>
          {slash.items.length === 0 ? (
            <div className="composer-mention-empty">
              {caps === null ? "正在加载可用命令…" : `没有匹配「${slash.range.query}」的命令`}
            </div>
          ) : (
            slash.items.map((item, i) => (
              <button
                type="button"
                key={item.name}
                className={`composer-mention-item${i === slash.active ? " active" : ""}`}
                role="option"
                aria-selected={i === slash.active}
                onMouseEnter={() => setSlash((s) => (s !== null ? { ...s, active: i } : s))}
                onMouseDown={(e) => {
                  // mousedown 防止 textarea 失焦导致面板先关闭
                  e.preventDefault();
                  applySlash(item);
                }}
              >
                <span className="mention-badge mention-badge-skill">命令</span>
                <span className="mention-token">{item.name}</span>
                <span className="composer-slash-desc">{item.description}</span>
                {item.args !== undefined && item.args.length > 0 && (
                  <span className="mention-id" title={item.args.join(" ")}>
                    {item.args[0]}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {/* @ 提及候选面板（悬浮于输入框上方；空态提示可输入内容过滤） */}
      {mention !== null && (
        <div className="composer-mention" role="listbox" aria-label="@ 提及候选">
          <div className="composer-mention-title">技能 / Agent / MCP（↑↓ 选择，Enter 补全，Esc 关闭）</div>
          {mention.items.length === 0 ? (
            <div className="composer-mention-empty">{caps === null ? "正在加载可用能力…" : "无匹配项"}</div>
          ) : (
            mention.items.map((item, i) => (
              <button
                type="button"
                key={`${item.kindLabel}-${item.token}`}
                className={`composer-mention-item${i === mention.active ? " active" : ""}`}
                role="option"
                aria-selected={i === mention.active}
                onMouseEnter={() => setMention((m) => (m !== null ? { ...m, active: i } : m))}
                onMouseDown={(e) => {
                  // mousedown 防止 textarea 失焦导致面板先关闭
                  e.preventDefault();
                  void applyMention(item);
                }}
              >
                <span className={`mention-badge ${item.kindClass}`}>{item.kindLabel}</span>
                <span className="mention-token">{item.label}</span>
                {item.label !== item.token && (
                  <span className="mention-id" title={`补全插入 ${item.token}`}>
                    @{item.token}
                  </span>
                )}
                <span className="mention-desc">{item.description}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 「+」能力菜单（模型 / 技能 / 智能体）：一个入口覆盖「换模型」与「插能力」 */}
      {menu !== null && (
        <div className="composer-menu" role="menu" aria-label="能力选择">
          <div className="composer-menu-tabs" role="tablist">
            {(
              [
                ["model", "模型"],
                ["skill", "技能"],
                ["agent", "智能体"],
              ] as const
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                role="tab"
                aria-selected={menu.tab === key}
                className={`composer-menu-tab${menu.tab === key ? " active" : ""}`}
                onClick={() => openMenu(key)}
              >
                {label}
              </button>
            ))}
            <span className="composer-menu-spacer" />
            <button type="button" className="composer-menu-close" title="关闭" onClick={() => setMenu(null)}>
              <CloseIcon size={12} />
            </button>
          </div>

          {menuError !== "" && <div className="composer-menu-error">{menuError}</div>}

          <div className="composer-menu-list">
            {menu.tab === "model" ? (
              models === null ? (
                <div className="composer-menu-empty">正在加载模型…</div>
              ) : models.length === 0 ? (
                <div className="composer-menu-empty">
                  当前没有可切换的模型。桌面版可在「设置 → 系统管理 → 模型管理」添加。
                </div>
              ) : (
                models.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`composer-menu-item${m.isDefault ? " active" : ""}`}
                    disabled={!m.enabled || switchingModel}
                    title={`${m.model} · ${m.baseUrl}`}
                    onClick={() => switchModel(m)}
                  >
                    <WrenchIcon size={13} />
                    <span className="composer-menu-name">{m.name}</span>
                    <span className="composer-menu-meta">{m.model}</span>
                    {m.isDefault && <span className="composer-menu-badge">当前</span>}
                    {!m.enabled && <span className="composer-menu-badge">已停用</span>}
                  </button>
                ))
              )
            ) : (
              (() => {
                const kind = menu.tab === "agent" ? "agent" : "skill";
                const items = (caps?.skills ?? []).filter((s) => s.kind === kind);
                if (caps === null) return <div className="composer-menu-empty">正在加载可用能力…</div>;
                if (items.length === 0) {
                  return (
                    <div className="composer-menu-empty">
                      {kind === "agent"
                        ? "还没有智能体。可在「设置 → 系统管理 → 智能体」创建或导入预置智能体。"
                        : "还没有可用技能。可将 SKILL.md 放入 ~/.deepcode/skills。"}
                    </div>
                  );
                }
                return items.map((s) => (
                  <button
                    type="button"
                    key={`${kind}-${s.name}`}
                    className="composer-menu-item"
                    title={kind === "agent" ? `${agentMentionHint(s)} · ${s.path}` : s.path}
                    onClick={() => insertToken(s.name)}
                  >
                    {kind === "agent" ? <BotAvatarIcon size={13} /> : null}
                    <span className="composer-menu-name">{kind === "agent" ? agentDisplayName(s) : s.name}</span>
                    {kind === "agent" && (
                      <span className="composer-menu-id" title={`插入 ${agentMentionHint(s)}`}>
                        {agentMentionHint(s)}
                      </span>
                    )}
                    <span className="composer-menu-meta">{s.description}</span>
                  </button>
                ));
              })()
            )}
          </div>
        </div>
      )}

      {/* 附件 chips 区（本地 + 服务器路径） */}
      {(localFiles.length > 0 || serverFiles.length > 0) && (
        <div className="composer-chips">
          {localFiles.map((f, i) => {
            const previewUrl = previews.get(f.name);
            return (
              <span key={`${f.name}-${i}`} className="composer-chip" title={`${f.name} · ${humanSize(f.size)}`}>
                {previewUrl !== undefined ? (
                  <img className="composer-chip-thumb" src={previewUrl} alt={f.name} />
                ) : (
                  <span className="composer-chip-icon">{fileIcon(f.name)}</span>
                )}
                <span className="composer-chip-name">{f.name}</span>
                <button type="button" className="chip-remove" title="移除附件" onClick={() => removeFile(i)}>
                  <CloseIcon size={11} />
                </button>
              </span>
            );
          })}
          {serverFiles.map((sf, i) => (
            <span key={`${sf.name}-server-${i}`} className="composer-chip composer-chip-server" title={sf.name}>
              <span className="composer-chip-icon">{fileIcon(sf.name)}</span>
              <span className="composer-chip-name">{sf.name}</span>
              <button type="button" className="chip-remove" title="移除附件" onClick={() => onRemoveServerFile(i)}>
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 行内错误提示（超限文件等） */}
      {error !== "" && <div className="composer-error">{error}</div>}

      <div className="composer-main">
        {/* 能力菜单入口（模型 / 技能 / 智能体）：与附件按钮并列，避免把常用操作藏进二级菜单 */}
        <button
          type="button"
          className={`icon-btn composer-plus${menu !== null ? " active" : ""}`}
          title="选择模型 / 技能 / 智能体"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          disabled={inputBlocked}
          onClick={() => (menu === null ? openMenu("model") : setMenu(null))}
        >
          <PlusIcon size={17} />
        </button>
        {/* 附件选择按钮（图标直显；生成中在 steering 模式下仍可添加附件） */}
        <button
          type="button"
          className="icon-btn composer-attach"
          title="添加附件"
          disabled={inputBlocked}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon size={17} />
        </button>
        {/* 隐藏文件选择器：multiple 支持多选 */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files !== null) addFiles(e.target.files);
            e.target.value = ""; // 允许重复选择同一文件
          }}
        />

        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder="输入消息，@ 唤起技能 / 智能体，/ 唤起命令，+ 切换模型，Enter 发送，Shift+Enter 换行"
          rows={1}
          value={text}
          disabled={inputBlocked}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
            refreshMention(e.target.value);
            refreshSlash(e.target.value);
          }}
          onKeyUp={(e) => {
            // 方向键移动光标后重算 @ / 命令补全上下文（不改值，仅按当前值重解析）
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
              refreshMention(text);
              refreshSlash(text);
            }
          }}
          onClick={() => {
            refreshMention(text);
            refreshSlash(text);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />

        {/* 发送 / 停止按钮位：
            - steering 关闭（旧行为）：生成中只显示停止；
            - steering 开启：生成中 发送 + 停止 并排同显（补充指令随时可发）。 */}
        {streaming && !steeringEnabled ? (
          <button type="button" className="composer-send composer-send-stop" title="停止生成" onClick={onStop}>
            <StopIcon size={15} />
          </button>
        ) : (
          <>
            {streaming && (
              <button type="button" className="composer-send composer-send-stop" title="停止生成" onClick={onStop}>
                <StopIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className="composer-send"
              title={streaming ? "发送补充指令" : "发送"}
              disabled={!canSend}
              onClick={doSend}
            >
              <SendIcon size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
