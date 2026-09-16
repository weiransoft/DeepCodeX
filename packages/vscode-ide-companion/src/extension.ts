import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import MarkdownIt from "markdown-it";
import type { SessionMessage } from "@vegamo/deepcode-core";
import {
  SessionManager,
  type LlmRetryEvent,
  type LlmStreamProgress,
  type PermissionScope,
  type SessionEntry,
  type SkillInfo,
  type UserPromptContent,
  type UserToolPermission,
  readDeepcodePlusApiKey,
  resolveOpenAIConnection,
  resolveSettingsSources,
  type DeepcodingSettings,
  type ReasoningEffort,
  type ResolvedDeepcodingSettings,
  setShellIfWindows,
} from "@vegamo/deepcode-core";
import { getNonce, isAllowedExternalUrl } from "./utils.js";
import { handleWebviewMessage } from "./provider.js";
import { createSharpLoader } from "./sharp-loader.js";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

type ReasoningMessageParams = {
  reasoning_content?: string;
};

export class DeepCodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "deepcode.chatView";

  private readonly context: vscode.ExtensionContext;
  private webviewView: vscode.WebviewView | undefined;
  private readonly md: MarkdownIt;
  private readonly sessionManager: SessionManager;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.md = new MarkdownIt({
      html: false,
      linkify: false,
      breaks: true,
    });
    this.sessionManager = new SessionManager({
      projectRoot: this.getWorkspaceRoot(),
      loadSharp: createSharpLoader({
        workspaceRoot: this.getWorkspaceRoot(),
        storageRoot: context.globalStorageUri.fsPath,
        sharpVersion: __DEEPCODE_SHARP_VERSION__,
        notifyInstalling: async (task) =>
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Deep Code: Installing ReadImage dependencies",
            },
            async (progress) => {
              let reportedPercent = 0;
              return await task(({ percent, message }) => {
                const nextPercent = Math.max(reportedPercent, Math.min(100, Math.round(percent)));
                progress.report({
                  increment: nextPercent - reportedPercent,
                  message: `${nextPercent}% - ${message}`,
                });
                reportedPercent = nextPercent;
              });
            }
          ),
      }),
      createOpenAIClient: () => this.createOpenAIClient(),
      getResolvedSettings: () => this.resolveCurrentSettings(),
      renderMarkdown: (text) => this.md.render(text),
      onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => {
        if (!this.webviewView) {
          return;
        }
        if (message.visible === false) {
          return;
        }
        if (message.role !== "tool") {
          const reasoningContent = (message.messageParams as ReasoningMessageParams | null)?.reasoning_content;
          message.html = this.md.render(message.content || reasoningContent || "");
        }
        this.webviewView.webview.postMessage({ type: "appendMessage", message, shouldConnect });
      },
      onSessionEntryUpdated: (entry) => {
        if (!this.webviewView) {
          return;
        }
        this.webviewView.webview.postMessage({
          type: "sessionStatus",
          sessionId: entry.id,
          status: entry.status,
          pluginRateLimitedTool: entry.pluginRateLimitedTool ?? null,
          askPermissions: entry.askPermissions,
          processes: this.serializeProcesses(entry.processes),
          tokenTelemetry: this.buildTokenTelemetry(entry),
        });
      },
      onLlmStreamProgress: (progress: LlmStreamProgress) => {
        if (!this.webviewView) {
          return;
        }
        this.webviewView.webview.postMessage({
          type: "llmStreamProgress",
          progress,
        });
      },
      onLlmRetry: (event: LlmRetryEvent) => {
        if (!this.webviewView) {
          return;
        }
        this.webviewView.webview.postMessage({
          type: "llmRetry",
          event,
        });
      },
    });
    void this.initializeMcpServers();
  }

  dispose(): void {
    this.sessionManager.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const msg = message as Record<string, unknown> | undefined;

      // openFile requires vscode API, handle here directly
      if (msg?.type === "openFile") {
        const filePath = String(msg.filePath || "").trim();
        const line = Number(msg.line || 1);
        if (filePath) {
          await this.openFileInEditor(filePath, line);
        }
        return;
      }

      if (msg?.type === "openExternal") {
        if (isAllowedExternalUrl(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
      }

      const handled = await handleWebviewMessage(message, {
        sessionManager: this.sessionManager,
        postMessage: (m) => this.webviewView?.webview.postMessage(m),
        renderMarkdown: (text) => this.md.render(text),
        copyToClipboard: (text) => void vscode.env.clipboard.writeText(text),
      });

      if (!handled) {
        // unrecognized message type — no-op
      }
    });
  }

  private async loadInitialSession(): Promise<void> {
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    if (sessions.length === 0) {
      // 没有历史会话，显示新对话界面
      this.sendMessage({
        type: "initializeEmpty",
        sessions: sessionsList,
        status: null,
        tokenTelemetry: this.buildTokenTelemetry(null),
      });
      return;
    }

    // 显示最新的对话
    const latestSession = sessions[0];
    this.loadSession(latestSession.id);
  }

  private loadSession(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }

    // 设置为活动会话
    this.sessionManager.setActiveSessionId(sessionId);

    const messages = this.sessionManager.listSessionMessages(sessionId);

    // 获取所有会话列表
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    // 发送对话信息到 webview
    this.sendMessage({
      type: "loadSession",
      sessionId,
      summary: session.summary || "Untitled",
      status: session.status,
      pluginRateLimitedTool: session.pluginRateLimitedTool ?? null,
      askPermissions: session.askPermissions,
      processes: this.serializeProcesses(session.processes),
      tokenTelemetry: this.buildTokenTelemetry(session),
      sessions: sessionsList,
      messages: messages
        .filter((m) => m.visible)
        .map((m) => ({
          role: m.role,
          content: m.content,
          html:
            m.role !== "tool"
              ? this.md.render(m.content || (m.messageParams as ReasoningMessageParams | null)?.reasoning_content || "")
              : undefined,
          meta: m.meta,
        })),
    });
  }

  private showSessionsList(): void {
    const sessions = this.sessionManager.listSessions();
    this.sendMessage({
      type: "showSessionsList",
      sessions: sessions.map((s) => ({
        id: s.id,
        summary: s.summary || "Untitled",
        createTime: s.createTime,
        updateTime: s.updateTime,
        status: s.status,
      })),
    });
  }

  private async createNewSession(): Promise<void> {
    // 清除当前活动会话
    this.sessionManager.setActiveSessionId(null);

    // 获取所有会话列表
    const sessions = this.sessionManager.listSessions();
    const sessionsList = sessions.map((s) => ({
      id: s.id,
      summary: s.summary || "Untitled",
      createTime: s.createTime,
      updateTime: s.updateTime,
      status: s.status,
    }));

    this.sendMessage({
      type: "initializeEmpty",
      sessions: sessionsList,
      status: null,
      tokenTelemetry: this.buildTokenTelemetry(null),
    });
    await this.sendSkillsList();
  }

  private sendMessage(message: unknown): void {
    if (!this.webviewView) {
      return;
    }
    this.webviewView.webview.postMessage(message);
  }

  private async sendSkillsList(sessionId?: string): Promise<void> {
    if (!this.webviewView) {
      return;
    }
    const skills = await this.sessionManager.listSkills(
      sessionId ?? this.sessionManager.getActiveSessionId() ?? undefined
    );
    this.sendMessage({ type: "skillsList", skills });
  }

  private async handlePrompt(
    prompt: string,
    skills?: SkillInfo[],
    imageUrls?: string[],
    options: { permissions?: UserToolPermission[]; alwaysAllows?: PermissionScope[] } = {}
  ): Promise<void> {
    if (!this.webviewView) {
      return;
    }

    const webview = this.webviewView.webview;
    const normalizedImages = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
    const displayPrompt = prompt || (normalizedImages.length > 0 ? "粘贴的图像" : "");
    const isPermissionContinue =
      prompt === "/continue" &&
      normalizedImages.length === 0 &&
      ((options.permissions?.length ?? 0) > 0 || (options.alwaysAllows?.length ?? 0) > 0);

    // 先显示用户消息（原始文本，不做 HTML 格式化）
    if (displayPrompt && !isPermissionContinue) {
      webview.postMessage({ type: "userMessage", content: displayPrompt });
    }

    webview.postMessage({ type: "loading", value: true });

    try {
      const userPrompt: UserPromptContent = {
        text: prompt,
        skills,
        imageUrls: normalizedImages,
        permissions: options.permissions,
        alwaysAllows: options.alwaysAllows,
      };
      await this.sessionManager.handleUserPrompt(userPrompt);
      await this.sendSkillsList();

      const activeSessionId = this.sessionManager.getActiveSessionId();
      const activeSession = activeSessionId ? this.sessionManager.getSession(activeSessionId) : null;
      if (activeSessionId && activeSession) {
        webview.postMessage({
          type: "sessionStatus",
          sessionId: activeSessionId,
          status: activeSession.status,
          pluginRateLimitedTool: activeSession.pluginRateLimitedTool ?? null,
          askPermissions: activeSession.askPermissions,
          processes: this.serializeProcesses(activeSession.processes),
          tokenTelemetry: this.buildTokenTelemetry(activeSession),
        });
      }

      // 发送更新后的会话列表（可能创建了新会话）
      const sessions = this.sessionManager.listSessions();
      const sessionsList = sessions.map((s) => ({
        id: s.id,
        summary: s.summary || "Untitled",
        createTime: s.createTime,
        updateTime: s.updateTime,
        status: s.status,
      }));
      webview.postMessage({
        type: "showSessionsList",
        sessions: sessionsList,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webview.postMessage({
        type: "assistant",
        html: this.md.render(`Request failed: ${message}`),
      });
    } finally {
      webview.postMessage({ type: "loading", value: false });
    }
  }

  private handlePermissionDenied(sessionId: string): void {
    this.sessionManager.denySessionPermission(sessionId);
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      this.sendMessage({
        type: "sessionStatus",
        sessionId,
        status: session.status,
        pluginRateLimitedTool: session.pluginRateLimitedTool ?? null,
        askPermissions: session.askPermissions,
        processes: this.serializeProcesses(session.processes),
        tokenTelemetry: this.buildTokenTelemetry(session),
      });
    }
    this.showSessionsList();
  }

  private createOpenAIClient(): {
    client: OpenAI | null;
    apiKey?: string;
    model: string;
    baseURL: string;
    thinkingEnabled: boolean;
    reasoningEffort: ReasoningEffort;
    debugLogEnabled: boolean;
    notify?: string;
    webSearchTool?: string;
    env?: Record<string, string>;
    machineId?: string;
    plusApiKey?: string;
  } {
    const settings = this.resolveCurrentSettings();
    const plusApiKey = readDeepcodePlusApiKey();
    const connection = resolveOpenAIConnection(settings, plusApiKey);

    const { model, thinkingEnabled, reasoningEffort, debugLogEnabled, notify, webSearchTool, env } = settings;
    const { apiKey, baseURL } = connection;
    // 隐私加固（2026-09-17 审计）：不再使用 vscode.env.machineId 作为遥测标识。
    // vscode.env.machineId 是 VS Code 生成的稳定设备唯一标识符，可跨会话持续追踪用户，
    // 属于设备指纹信息。改为使用扩展全局状态中持久化的纯随机 UUID（首次使用时生成），
    // 该标识不含任何设备/用户特征，且可随扩展数据清除。
    const machineId = this.getAnonymousMachineId();

    if (!apiKey) {
      return {
        client: null,
        apiKey: undefined,
        model,
        baseURL,
        thinkingEnabled,
        reasoningEffort,
        debugLogEnabled,
        notify,
        webSearchTool,
        env,
        machineId,
        plusApiKey,
      };
    }

    const client = new OpenAI({
      apiKey,
      baseURL: baseURL || undefined,
    });

    return {
      client,
      apiKey,
      model,
      baseURL,
      thinkingEnabled,
      reasoningEffort,
      debugLogEnabled,
      notify,
      webSearchTool,
      env,
      machineId,
      plusApiKey,
    };
  }

  /**
   * 获取（或首次生成）扩展级匿名标识 machineId。
   *
   * 隐私加固（2026-09-17 审计）：替代 vscode.env.machineId（稳定设备指纹）。
   * 实现方式：在扩展 globalState 中持久化一个纯随机 UUID（crypto.randomUUID），
   * - 标识本身不含主机名、MAC、VS Code 设备 ID 等任何可识别信息；
   * - 首次生成后跨窗口复用，保证同一扩展安装内的会话连贯性；
   * - 用户清除扩展数据即同步清除该标识。
   *
   * @returns 持久化的随机 UUID；globalState 不可用时返回 undefined（调用方须容忍缺失）
   */
  private getAnonymousMachineId(): string | undefined {
    try {
      const key = "deepcode.anonymousMachineId";
      const existing = this.context.globalState.get<string>(key);
      if (typeof existing === "string" && existing.trim()) {
        return existing.trim();
      }
      const generated = randomUUID();
      void this.context.globalState.update(key, generated);
      return generated;
    } catch {
      return undefined;
    }
  }

  private buildTokenTelemetry(session: SessionEntry | null): {
    model: string;
    thinkingEnabled: boolean;
    reasoningEffort: ReasoningEffort;
    activeTokens: number;
    contextWindow: number;
    compactPromptTokenThreshold: number;
    usage: unknown | null;
  } {
    const settings = this.resolveCurrentSettings();
    return {
      model: settings.model,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      activeTokens: session?.activeTokens ?? 0,
      contextWindow: settings.contextWindow,
      compactPromptTokenThreshold: settings.autoCompactWindow,
      usage: session?.usage ?? null,
    };
  }

  private async initializeMcpServers(): Promise<void> {
    try {
      await this.sessionManager.initMcpServers(this.resolveCurrentSettings().mcpServers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Failed to initialize MCP servers: ${message}`);
    }
  }

  private resolveCurrentSettings(): ResolvedDeepcodingSettings {
    return resolveSettingsSources(
      this.readUserSettings(),
      this.readProjectSettings(),
      {
        model: DEFAULT_MODEL,
        baseURL: DEFAULT_BASE_URL,
      },
      process.env
    );
  }

  private readUserSettings(): DeepcodingSettings | null {
    try {
      const settingsPath = path.join(os.homedir(), ".deepcode", "settings.json");
      if (!fs.existsSync(settingsPath)) {
        return null;
      }

      const raw = fs.readFileSync(settingsPath, "utf8");
      return JSON.parse(raw) as DeepcodingSettings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to read ~/.deepcode/settings.json: ${message}`);
      return null;
    }
  }

  private readProjectSettings(): DeepcodingSettings | null {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      const settingsPath = path.join(workspaceRoot, ".deepcode", "settings.json");
      if (!fs.existsSync(settingsPath)) {
        return null;
      }

      const raw = fs.readFileSync(settingsPath, "utf8");
      return JSON.parse(raw) as DeepcodingSettings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to read ${path.join(workspaceRoot, ".deepcode", "settings.json")}: ${message}`
      );
      return null;
    }
  }

  private getWorkspaceRoot(): string {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (workspace) {
      return workspace.uri.fsPath;
    }
    return process.cwd();
  }

  private serializeProcesses(
    processes: Map<string, { startTime: string; command: string }> | null
  ): Record<string, { startTime: string; command: string }> | null {
    if (!processes || processes.size === 0) {
      return null;
    }

    const serialized: Record<string, { startTime: string; command: string }> = {};
    for (const [pid, entry] of processes.entries()) {
      serialized[pid] = entry;
    }
    return serialized;
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;

    // 读取 HTML 模板文件
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview.html");
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    // 获取 CSS 文件 URI
    const cssPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "webview.css");
    const cssUri = webview.asWebviewUri(cssPath);
    const attachmentsJsPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "prompt-attachments.js");
    const attachmentsJsUri = webview.asWebviewUri(attachmentsJsPath);
    const thinkingPreviewJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "thinking-preview.js")
    );

    // 获取 Logo 文件 URI
    const iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "deepcoding_icon.png");
    const iconUri = webview.asWebviewUri(iconPath);

    // 替换占位符
    html = html.replace(/\{\{nonce\}\}/g, nonce);
    html = html.replace(/\{\{cspSource\}\}/g, csp);
    html = html.replace(/\{\{cssUri\}\}/g, cssUri.toString());
    html = html.replace(/\{\{attachmentsJsUri\}\}/g, attachmentsJsUri.toString());
    html = html.replace(/\{\{thinkingPreviewJsUri\}\}/g, thinkingPreviewJsUri.toString());
    html = html.replace(/\{\{iconUri\}\}/g, iconUri.toString());
    html = html.replace(/\{\{workspaceRoot\}\}/g, JSON.stringify(this.getWorkspaceRoot()));

    return html;
  }

  private async openFileInEditor(filePath: string, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });

    const targetLine = Number.isFinite(line) && line > 0 ? Math.floor(line) - 1 : 0;
    const safeLine = Math.min(Math.max(0, targetLine), Math.max(0, document.lineCount - 1));
    const position = new vscode.Position(safeLine, 0);
    const selection = new vscode.Selection(position, position);
    editor.selection = selection;
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
  try {
    setShellIfWindows();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }

  const provider = new DeepCodeViewProvider(context);
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(DeepCodeViewProvider.viewType, provider));
  context.subscriptions.push(
    vscode.commands.registerCommand("deepcode.openView", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.deepcode");
      await vscode.commands.executeCommand("deepcode.chatView.focus");
    })
  );
}

export function deactivate(): void {
  // no-op
}
