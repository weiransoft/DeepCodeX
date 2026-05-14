import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { McpServerStatus } from "../mcp/mcp-manager";

type Props = {
  statuses: McpServerStatus[];
  onCancel: () => void;
};

type FlatItem =
  | { kind: "server"; status: McpServerStatus; serverIndex: number }
  | { kind: "tool"; name: string; serverName: string }
  | { kind: "prompt"; name: string; serverName: string }
  | { kind: "resource"; name: string; serverName: string };

function buildFlatItems(statuses: McpServerStatus[]): FlatItem[] {
  const items: FlatItem[] = [];
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    items.push({ kind: "server", status, serverIndex: i });
    if (status.status === "ready") {
      for (const tool of status.tools) {
        items.push({ kind: "tool", name: tool, serverName: status.name });
      }
      for (const prompt of status.prompts) {
        items.push({ kind: "prompt", name: prompt, serverName: status.name });
      }
      for (const resource of status.resources) {
        items.push({ kind: "resource", name: resource, serverName: status.name });
      }
    }
  }
  return items;
}

export function McpStatusList({ statuses, onCancel }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);
  const { columns, rows } = useWindowSize();

  const flatItems = useMemo(() => buildFlatItems(statuses), [statuses]);

  const maxVisible = useMemo(() => {
    const reservedLines = 8;
    const linesPerItem = 2;
    const availableLines = Math.max(0, Math.min(rows, 30) - reservedLines);
    return Math.max(1, Math.floor(availableLines / linesPerItem));
  }, [rows]);

  const safeIndex = useMemo(() => {
    if (flatItems.length === 0) return 0;
    return Math.max(0, Math.min(index, flatItems.length - 1));
  }, [index, flatItems.length]);

  const scrollOffset = useMemo(() => {
    if (safeIndex < maxVisible) return 0;
    return safeIndex - maxVisible + 1;
  }, [safeIndex, maxVisible]);

  const visibleItems = useMemo(() => {
    return flatItems.slice(scrollOffset, scrollOffset + maxVisible);
  }, [flatItems, scrollOffset, maxVisible]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === "c" || input === "C"))) {
      onCancel();
      return;
    }
    if (flatItems.length === 0) {
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(flatItems.length - 1, i + 1));
      return;
    }
    if (key.pageUp) {
      setIndex((i) => Math.max(0, i - maxVisible));
      return;
    }
    if (key.pageDown) {
      setIndex((i) => Math.min(flatItems.length - 1, i + maxVisible));
      return;
    }
    if (key.home) {
      setIndex(0);
      return;
    }
    if (key.end) {
      setIndex(flatItems.length - 1);
    }
  });

  const readyCount = statuses.filter((s) => s.status === "ready").length;
  const startingCount = statuses.filter((s) => s.status === "starting").length;
  const failedCount = statuses.filter((s) => s.status === "failed").length;

  if (statuses.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">Manage MCP servers</Text>
        <Text color="yellow">0 servers</Text>
        <Text color="yellow">No MCP servers configured.</Text>
        <Text color="yellow">Add MCP servers to your settings to get started.</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={Math.max(20, columns - 6)}
      height={Math.max(5, Math.min(rows - 1, 30))}
      overflow="hidden"
      paddingX={1}
      marginTop={1}
    >
      <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1} overflow="hidden">
        {/* Header row */}
        <Box paddingX={1}>
          <Text bold color="cyanBright">
            MCP Server Status
          </Text>
          <Text bold color="#229ac3">
            {" "}
            ({readyCount} ready, {startingCount} starting, {failedCount} failed)
          </Text>
        </Box>
        {/* Items list */}
        <Box
          borderTop={true}
          borderBottom={true}
          borderLeft={false}
          borderRight={false}
          borderStyle="round"
          borderDimColor
          flexDirection="column"
          flexGrow={1}
          paddingX={1}
          overflow="hidden"
        >
          {visibleItems.map((item, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === safeIndex;

            if (item.kind === "server") {
              return <ServerRow key={`server-${item.status.name}`} status={item.status} selected={isSelected} />;
            }
            return (
              <CapabilityRow
                key={`${item.kind}-${item.name}`}
                kind={item.kind}
                name={item.name}
                selected={isSelected}
              />
            );
          })}
          {scrollOffset > 0 || scrollOffset + maxVisible < flatItems.length ? (
            <Box marginTop={1}>
              {scrollOffset > 0 ? <Text dimColor>… {scrollOffset} items above. </Text> : null}
              {scrollOffset + maxVisible < flatItems.length ? (
                <Text dimColor>… {flatItems.length - scrollOffset - maxVisible} items below.</Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
        {/* Footer */}
        <Box>
          <Text dimColor>↑/↓ navigate · PgUp/PgDn page · Esc cancel</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ServerRow({ status, selected }: { status: McpServerStatus; selected: boolean }): React.ReactElement {
  const icon = status.status === "ready" ? "✔" : status.status === "failed" ? "✖" : "●";
  const color = status.status === "ready" ? "green" : status.status === "failed" ? "red" : "yellow";
  const detail =
    status.status === "ready"
      ? `Ready (${status.toolCount} tools, ${status.promptCount} prompts, ${status.resourceCount} resources)`
      : status.status === "failed"
        ? `Failed (${status.error ?? "unknown error"})`
        : "Starting...";

  return (
    <Box height={1} marginBottom={0}>
      <Text color="#229ac3">{selected ? "› " : "  "}</Text>
      <Text>
        <Text color={color}>{icon} </Text>
        <Text bold>{status.name}</Text>
        <Text dimColor> — {detail}</Text>
      </Text>
    </Box>
  );
}

function CapabilityRow({
  kind,
  name,
  selected,
}: {
  kind: "tool" | "prompt" | "resource";
  name: string;
  selected: boolean;
}): React.ReactElement {
  const prefix = kind === "tool" ? "🔧" : kind === "prompt" ? "📝" : "📦";
  return (
    <Box height={1}>
      <Text color="#229ac3">{selected ? "› " : "  "}</Text>
      <Text dimColor>
        {prefix} {name}
      </Text>
    </Box>
  );
}
