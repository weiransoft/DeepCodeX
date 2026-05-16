import { McpClient, type McpToolDefinition, type McpPromptDefinition, type McpResourceDefinition } from "./mcp-client";
import type { McpServerConfig } from "../settings";

const MCP_STARTUP_TIMEOUT_MS = 30_000;
const MCP_CALL_TOOL_TIMEOUT_MS = 60_000;

type McpToolEntry = {
  serverName: string;
  originalName: string;
  namespacedName: string;
  definition: McpToolDefinition;
  client: McpClient;
};

export type McpServerStatus = {
  name: string;
  status: "starting" | "ready" | "failed";
  connected: boolean;
  error?: string;
  toolCount: number;
  tools: string[];
  promptCount: number;
  prompts: string[];
  resourceCount: number;
  resources: string[];
};

export class McpManager {
  private clients: McpClient[] = [];
  private tools: McpToolEntry[] = [];
  private prompts: Array<{
    serverName: string;
    namespacedName: string;
    definition: McpPromptDefinition;
    client: McpClient;
  }> = [];
  private resources: Array<{
    serverName: string;
    namespacedName: string;
    definition: McpResourceDefinition;
    client: McpClient;
  }> = [];
  private initialized = false;
  private disposed = false;
  private configuredServerNames: string[] = [];
  private serverStatuses: McpServerStatus[] = [];
  private onToolsListChanged: (() => void) | null = null;
  private onStatusChanged: (() => void) | null = null;

  prepare(servers?: Record<string, McpServerConfig>): void {
    if (!servers || Object.keys(servers).length === 0) return;
    // Clear the disposed flag — a re-prepare means we are live again.
    // (disconnect() sets disposed=true to stop a stale initialize() loop,
    // but prepare+initialize must be able to start a new one.)
    this.disposed = false;

    for (const name of Object.keys(servers)) {
      if (!this.configuredServerNames.includes(name)) {
        this.configuredServerNames.push(name);
      }
      if (this.serverStatuses.some((status) => status.name === name)) {
        continue;
      }
      this.setStatus({
        name,
        status: "starting",
        connected: false,
        toolCount: 0,
        tools: [],
        promptCount: 0,
        prompts: [],
        resourceCount: 0,
        resources: [],
      });
    }
  }

  async initialize(servers?: Record<string, McpServerConfig>): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;

    if (!servers || Object.keys(servers).length === 0) return;

    const entries = Object.entries(servers);
    this.prepare(servers);

    for (const [name, config] of entries) {
      if (this.disposed) break;
      let client: McpClient | null = null;
      try {
        client = new McpClient(name, config.command, config.args ?? [], config.env, (method) => {
          if (method === "notifications/tools/list_changed") {
            this.refreshServerTools(name, client!).catch(() => {
              // swallow refresh errors
            });
          }
        });
        await client.connect(MCP_STARTUP_TIMEOUT_MS);
        if (this.disposed) {
          client.disconnect();
          break;
        }
        this.clients.push(client);

        // Discover tools
        const serverTools = await client.listTools(MCP_STARTUP_TIMEOUT_MS);
        if (this.disposed) break;
        const toolNamespacedNames: string[] = [];
        for (const tool of serverTools) {
          const namespacedName = `mcp__${name}__${tool.name}`;
          this.tools.push({
            serverName: name,
            originalName: tool.name,
            namespacedName,
            definition: tool,
            client,
          });
          toolNamespacedNames.push(namespacedName);
        }

        // Discover prompts
        let serverPrompts: McpPromptDefinition[] = [];
        try {
          serverPrompts = await client.listPrompts(MCP_STARTUP_TIMEOUT_MS);
        } catch {
          // Server may not support prompts — safe to ignore
        }
        if (this.disposed) break;
        const promptNamespacedNames: string[] = [];
        for (const prompt of serverPrompts) {
          const namespacedName = `mcp__${name}__${prompt.name}`;
          this.prompts.push({
            serverName: name,
            namespacedName,
            definition: prompt,
            client,
          });
          promptNamespacedNames.push(namespacedName);
        }

        // Discover resources
        let serverResources: McpResourceDefinition[] = [];
        try {
          serverResources = await client.listResources(MCP_STARTUP_TIMEOUT_MS);
        } catch {
          // Server may not support resources — safe to ignore
        }
        if (this.disposed) break;
        const resourceNamespacedNames: string[] = [];
        for (const resource of serverResources) {
          const namespacedName = `mcp__${name}__${resource.name}`;
          this.resources.push({
            serverName: name,
            namespacedName,
            definition: resource,
            client,
          });
          resourceNamespacedNames.push(namespacedName);
        }

        this.setStatus({
          name,
          status: "ready",
          connected: true,
          toolCount: serverTools.length,
          tools: toolNamespacedNames,
          promptCount: serverPrompts.length,
          prompts: promptNamespacedNames,
          resourceCount: serverResources.length,
          resources: resourceNamespacedNames,
        });
      } catch (err) {
        if (this.disposed) break;
        client?.disconnect();
        const message = err instanceof Error ? err.message : String(err);
        // 不在控制台输出错误日志，避免暴露敏感信息
        // process.stderr.write(`[deepcode] MCP server "${name}" failed to initialize: ${message}\n`);
        this.setStatus({
          name,
          status: "failed",
          connected: false,
          error: message,
          toolCount: 0,
          tools: [],
          promptCount: 0,
          prompts: [],
          resourceCount: 0,
          resources: [],
        });
      }
    }
  }

  getStatus(): McpServerStatus[] {
    const result = [...this.serverStatuses];
    const knownNames = new Set(result.map((s) => s.name));
    for (const name of this.configuredServerNames) {
      if (!knownNames.has(name)) {
        result.push({
          name,
          status: "starting",
          connected: false,
          toolCount: 0,
          tools: [],
          promptCount: 0,
          prompts: [],
          resourceCount: 0,
          resources: [],
        });
      }
    }
    return result;
  }

  getMcpToolDefinitions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    };
  }> {
    return this.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.namespacedName,
        description: t.definition.description ?? `${t.serverName}: ${t.originalName}`,
        parameters: {
          type: "object" as const,
          properties: t.definition.inputSchema.properties,
          required: t.definition.inputSchema.required,
          ...(t.definition.inputSchema.additionalProperties !== undefined
            ? { additionalProperties: t.definition.inputSchema.additionalProperties }
            : {}),
        },
      },
    }));
  }

  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  async executeMcpTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = MCP_CALL_TOOL_TIMEOUT_MS
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const tool = this.tools.find((t) => t.namespacedName === name);
    if (!tool) {
      return { ok: false, name, error: `Unknown MCP tool: ${name}` };
    }

    try {
      const result = await tool.client.callTool(tool.originalName, args, timeoutMs);
      const text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      return {
        ok: !result.isError,
        name,
        output: text || JSON.stringify(result.content),
      };
    } catch (err) {
      return {
        ok: false,
        name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getMcpPrompt(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const prompt = this.prompts.find((p) => p.namespacedName === name);
    if (!prompt) {
      return { ok: false, name, error: `Unknown MCP prompt: ${name}` };
    }

    try {
      const result = await prompt.client.getPrompt(prompt.definition.name, args);
      const text = result.messages
        .filter((m) => m.content.type === "text" && m.content.text)
        .map((m) => `[${m.role}] ${m.content.text}`)
        .join("\n");
      return {
        ok: true,
        name,
        output: text || JSON.stringify(result),
      };
    } catch (err) {
      return {
        ok: false,
        name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async readMcpResource(
    name: string,
    uri: string
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const resource = this.resources.find((r) => r.namespacedName === name);
    if (!resource) {
      return { ok: false, name, error: `Unknown MCP resource: ${name}` };
    }

    try {
      const result = await resource.client.readResource(uri);
      const text = result.contents
        .filter((c) => c.text)
        .map((c) => c.text)
        .join("\n");
      return {
        ok: true,
        name,
        output: text || JSON.stringify(result.contents),
      };
    } catch (err) {
      return {
        ok: false,
        name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  disconnect(): void {
    this.disposed = true;
    for (const client of this.clients) {
      client.disconnect();
    }
    this.clients = [];
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.serverStatuses = [];
    this.configuredServerNames = [];
    this.initialized = false;
  }

  private async refreshServerTools(serverName: string, client: McpClient): Promise<void> {
    const serverTools = await client.listTools(MCP_STARTUP_TIMEOUT_MS);
    // Remove old tool entries for this server
    this.tools = this.tools.filter((t) => t.serverName !== serverName);
    const toolNamespacedNames: string[] = [];
    for (const tool of serverTools) {
      const namespacedName = `mcp__${serverName}__${tool.name}`;
      this.tools.push({
        serverName,
        originalName: tool.name,
        namespacedName,
        definition: tool,
        client,
      });
      toolNamespacedNames.push(namespacedName);
    }
    // Update status
    const existing = this.serverStatuses.find((s) => s.name === serverName);
    if (existing) {
      existing.toolCount = serverTools.length;
      existing.tools = toolNamespacedNames;
    }
    // Notify listener
    this.onToolsListChanged?.();
  }

  setOnToolsListChanged(handler: () => void): void {
    this.onToolsListChanged = handler;
  }

  setOnStatusChanged(handler: () => void): void {
    this.onStatusChanged = handler;
  }

  private setStatus(status: McpServerStatus): void {
    if (this.disposed) return;
    const index = this.serverStatuses.findIndex((s) => s.name === status.name);
    if (index === -1) {
      this.serverStatuses.push(status);
    } else {
      this.serverStatuses[index] = status;
    }
    // 触发状态变更回调
    this.onStatusChanged?.();
  }
}
