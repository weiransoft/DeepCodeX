import React, { useState, useMemo, useCallback } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { McpServerStatus } from "../mcp/mcp-manager";

type Props = {
  statuses: McpServerStatus[];
  onCancel: () => void;
};

export function McpStatusList({ statuses, onCancel }: Props): React.ReactElement {
  const { columns, rows } = useWindowSize();

  // 视图模式：server-list（服务器列表） 或 server-detail（服务器详情）
  const [viewMode, setViewMode] = useState<"server-list" | "server-detail">("server-list");
  // 选中的服务器索引
  const [selectedServerIndex, setSelectedServerIndex] = useState(0);

  // 返回服务器列表
  const goBack = useCallback(() => {
    setViewMode("server-list");
  }, []);

  // 进入服务器详情
  const enterDetail = useCallback(() => {
    const server = statuses[selectedServerIndex];
    if (server && server.status === "ready") {
      setViewMode("server-detail");
    }
  }, [statuses, selectedServerIndex]);

  // 当没有服务器时，监听 Esc 键退出
  useInput((input, key) => {
    if (statuses.length === 0 && (key.escape || (key.ctrl && (input === "c" || input === "C")))) {
      onCancel();
    }
  });

  if (statuses.length === 0) {
    return (
      <Box flexDirection="column" marginLeft={1} paddingX={1} gap={1} borderStyle="round" borderDimColor>
        <Box flexDirection="column">
          <Text color="#229ac3" bold>
            Manage MCP servers
          </Text>
          <Text dimColor>0 servers</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>No MCP servers configured.</Text>
          <Text dimColor>Add MCP servers to your settings to get started.</Text>
        </Box>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  if (viewMode === "server-detail") {
    return (
      <ServerDetailView
        server={statuses[selectedServerIndex]}
        onBack={goBack}
        onCancel={onCancel}
        rows={rows}
        columns={columns}
      />
    );
  }

  return (
    <ServerListView
      statuses={statuses}
      selectedIndex={selectedServerIndex}
      onSelect={setSelectedServerIndex}
      onEnter={enterDetail}
      onCancel={onCancel}
      rows={rows}
      columns={columns}
    />
  );
}

// ==================== 服务器列表视图 ====================
function ServerListView({
  statuses,
  selectedIndex,
  onSelect,
  onEnter,
  onCancel,
  rows,
  columns,
}: {
  statuses: McpServerStatus[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onEnter: () => void;
  onCancel: () => void;
  rows: number;
  columns: number;
}): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);
  const serverCount = statuses.length;

  const maxVisible = useMemo(() => {
    const reservedLines = 8; // header + footer + borders
    const availableLines = Math.max(0, Math.min(rows, 30) - reservedLines);
    // 每个服务器占用 1 行（标题）+ 1 行（错误信息或统计）+ 1 行（间隔）
    return Math.max(1, Math.floor(availableLines / 3));
  }, [rows]);

  // 计算标签列宽度：找到最长的服务器名称，加上前缀和图标
  const labelColumnWidth = useMemo(() => {
    if (serverCount === 0) return 0;
    const longestName = Math.max(...statuses.map((s) => s.name.length));
    const contentWidth = longestName + 5; // +2 for prefix "> " or "  ", +3 for icon "✓ "
    const maxAllowed = Math.max(15, Math.floor((columns - 6) * 0.4)); // 容器40%宽度，至少15列
    return Math.min(contentWidth, maxAllowed);
  }, [statuses, serverCount, columns]);

  const safeIndex = useMemo(() => {
    if (serverCount === 0) return 0;
    return Math.max(0, Math.min(selectedIndex, serverCount - 1));
  }, [selectedIndex, serverCount]);

  // 自动滚动确保选中项可见
  React.useEffect(() => {
    if (safeIndex < scrollOffset) {
      setScrollOffset(safeIndex);
    } else if (safeIndex >= scrollOffset + maxVisible) {
      setScrollOffset(safeIndex - maxVisible + 1);
    }
  }, [safeIndex, scrollOffset, maxVisible]);

  const visibleServers = useMemo(() => {
    return statuses.slice(scrollOffset, scrollOffset + maxVisible);
  }, [statuses, scrollOffset, maxVisible]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === "c" || input === "C"))) {
      onCancel();
      return;
    }
    if (serverCount === 0) {
      return;
    }
    if (key.upArrow) {
      onSelect(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      onSelect(Math.min(serverCount - 1, selectedIndex + 1));
      return;
    }
    if (key.pageUp) {
      onSelect(Math.max(0, selectedIndex - maxVisible));
      return;
    }
    if (key.pageDown) {
      onSelect(Math.min(serverCount - 1, selectedIndex + maxVisible));
      return;
    }
    if (key.home) {
      onSelect(0);
      return;
    }
    if (key.end) {
      onSelect(serverCount - 1);
    }
    // Enter 键进入详情
    if (key.return) {
      onEnter();
      return;
    }
  });

  const readyCount = statuses.filter((s) => s.status === "ready").length;
  const startingCount = statuses.filter((s) => s.status === "starting").length;
  const failedCount = statuses.filter((s) => s.status === "failed").length;

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
        <Box paddingX={1} gap={1}>
          <Text bold color="#229ac3">
            Manage MCP servers
          </Text>
          <Box gap={1}>
            <Text dimColor>(</Text>
            <Text color="green" bold>
              {readyCount} ready,
            </Text>
            <Text color="yellow" bold>
              {startingCount} starting,
            </Text>
            <Text color="red" bold>
              {failedCount} failed
            </Text>
            <Text dimColor>)</Text>
          </Box>
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
          {visibleServers.map((status, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === safeIndex;

            return (
              <ServerRow
                key={`server-${status.name}`}
                status={status}
                selected={isSelected}
                labelColumnWidth={labelColumnWidth}
              />
            );
          })}
          {scrollOffset > 0 || scrollOffset + maxVisible < serverCount ? (
            <Box marginTop={1}>
              {scrollOffset > 0 ? <Text dimColor>… {scrollOffset} servers above. </Text> : null}
              {scrollOffset + maxVisible < serverCount ? (
                <Text dimColor>… {serverCount - scrollOffset - maxVisible} servers below.</Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
        {/* Footer */}
        <Box paddingX={1}>
          <Text dimColor>↑/↓ navigate · Enter view details · Esc close</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ServerRow({
  status,
  selected,
  labelColumnWidth,
}: {
  status: McpServerStatus;
  selected: boolean;
  labelColumnWidth: number;
}): React.ReactElement {
  const icon = status.status === "ready" ? "✓" : status.status === "failed" ? "✗" : "●";
  const color = status.status === "ready" ? "green" : status.status === "failed" ? "red" : "yellow";

  // 加载动画：循环显示 (空) → . → .. → ... → (空) → ...
  const [dots, setDots] = React.useState(0);
  React.useEffect(() => {
    if (status.status !== "starting") return;
    const interval = setInterval(() => {
      setDots((d) => (d + 1) % 4); // 0 → 1 → 2 → 3 → 0 ...
    }, 500);
    return () => clearInterval(interval);
  }, [status.status]);

  const detail =
    status.status === "ready"
      ? `Ready (${status.toolCount} tools, ${status.promptCount} prompts, ${status.resourceCount} resources)`
      : status.status === "failed"
        ? `Failed`
        : "Starting" + (dots > 0 ? ".".repeat(dots) : "   "); // 动态显示 (空) / . / .. / ...

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Server row */}
      <Box gap={2}>
        <Box width={labelColumnWidth} flexShrink={0}>
          <Text color={selected ? "#229ac3" : undefined}>
            {selected ? "> " : "  "}
            <Text color={color}>{icon} </Text>
            <Text bold>{status.name}</Text>
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor>{detail}</Text>
        </Box>
      </Box>

      {/* Error message for failed servers */}
      {status.status === "failed" && status.error ? <ErrorRow error={status.error} /> : null}
    </Box>
  );
}

// ==================== 服务器详情视图 ====================
function ServerDetailView({
  server,
  onBack,
  onCancel,
  rows,
  columns,
}: {
  server: McpServerStatus;
  onBack: () => void;
  onCancel: () => void;
  rows: number;
  columns: number;
}): React.ReactElement {
  const [activeIndex, setActiveIndex] = useState(0);

  // 合并所有 items（tools, prompts, resources）
  const allItems = useMemo(() => {
    const items: { type: string; name: string }[] = [];
    server.tools.forEach((tool) => items.push({ type: "tool", name: tool }));
    server.prompts.forEach((prompt) => items.push({ type: "prompt", name: prompt }));
    server.resources.forEach((resource) => items.push({ type: "resource", name: resource }));
    return items;
  }, [server]);

  const totalItems = allItems.length;

  const maxVisible = useMemo(() => {
    const reservedLines = 10; // header + title + stats + footer + borders
    const availableLines = Math.max(0, Math.min(rows, 30) - reservedLines);
    return Math.max(1, availableLines);
  }, [rows]);

  // 使用 ref 跟踪 visibleStart，避免循环依赖
  const visibleStartRef = React.useRef(0);

  // 计算可见窗口起始位置：当 activeIndex 超出可见区域时才滚动（类似终端光标行为）
  const visibleStart = useMemo(() => {
    if (totalItems === 0) return 0;

    const currentStart = visibleStartRef.current;
    let newStart = currentStart;

    // 如果 activeIndex 在当前可见窗口之前，滚动到 activeIndex
    if (activeIndex < currentStart) {
      newStart = activeIndex;
    }
    // 如果 activeIndex 在当前可见窗口之后，滚动到 activeIndex
    else if (activeIndex >= currentStart + maxVisible) {
      newStart = activeIndex - maxVisible + 1;
    }

    // 限制在合法范围内
    newStart = Math.max(0, Math.min(newStart, Math.max(0, totalItems - maxVisible)));

    // 更新 ref
    visibleStartRef.current = newStart;

    return newStart;
  }, [activeIndex, maxVisible, totalItems]);

  const visibleItems = allItems.slice(visibleStart, visibleStart + maxVisible);

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "C")) {
      onCancel();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    // Space 或 Enter 键返回一级菜单
    if (input === " " || key.return) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setActiveIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setActiveIndex((prev) => Math.min(totalItems - 1, prev + 1));
      return;
    }
    if (key.pageUp) {
      setActiveIndex((prev) => Math.max(0, prev - maxVisible));
      return;
    }
    if (key.pageDown) {
      setActiveIndex((prev) => Math.min(totalItems - 1, prev + maxVisible));
      return;
    }
    if (key.home) {
      setActiveIndex(0);
      return;
    }
    if (key.end) {
      setActiveIndex(totalItems - 1);
    }
  });

  const icon = "✓";
  const color = "green";

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
        <Box paddingX={1} gap={1}>
          <Text color={color}>{icon} </Text>
          <Text bold color="#229ac3" wrap="truncate-end">
            {server.name}
          </Text>
          <Text dimColor>— Details</Text>
        </Box>
        {/* Server info */}
        <Box paddingX={1} marginLeft={3}>
          <Text wrap="truncate-end">
            {server.toolCount} tools, {server.promptCount} prompts, {server.resourceCount} resources
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
          {visibleStart > 0 ? (
            <Box>
              <Text dimColor>▲</Text>
            </Box>
          ) : (
            <Text> </Text>
          )}
          <Box paddingX={1} flexDirection="column">
            {visibleItems.length === 0 ? (
              <Box paddingY={1}>
                <Text dimColor>No items available</Text>
              </Box>
            ) : (
              visibleItems.map((item, idx) => {
                const actualIndex = visibleStart + idx;
                const isSelected = actualIndex === activeIndex;
                return <ItemRow key={`${item.type}-${item.name}-${actualIndex}`} item={item} selected={isSelected} />;
              })
            )}
          </Box>
          {visibleStart > 0 || visibleStart + maxVisible < totalItems ? (
            <Box marginTop={1} gap={1}>
              {totalItems - visibleStart - maxVisible > 0 ? <Text dimColor>▼</Text> : <Text> </Text>}
              {visibleStart > 0 ? <Text dimColor>… {visibleStart} items above. </Text> : null}
              {totalItems - visibleStart - maxVisible > 0 ? (
                <Text dimColor>… {totalItems - visibleStart - maxVisible} items below.</Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
        {/* Footer */}
        <Box paddingX={1}>
          <Text dimColor>↑/↓ scroll · Space/Enter back · Esc back · Ctrl+C close</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ItemRow({ item, selected }: { item: { type: string; name: string }; selected: boolean }): React.ReactElement {
  const icon = item.type === "tool" ? "🔧" : item.type === "prompt" ? "📝" : "📦";

  return (
    <Box height={1} flexDirection="row">
      <Text dimColor>{icon} </Text>
      <Text color={selected ? "#229ac3" : undefined} dimColor wrap="truncate-end">
        {item.name}
      </Text>
    </Box>
  );
}

function ErrorRow({ error }: { error: string }): React.ReactElement {
  // 将错误消息按行分割，每行单独显示
  const lines = error.split("\n").filter((line) => line.trim().length > 0);

  return (
    <Box
      flexDirection="column"
      marginLeft={4}
      marginTop={0}
      marginBottom={0}
      borderStyle="round"
      borderColor="red"
      borderDimColor
    >
      {lines.map((line, index) => (
        <Box key={index}>
          <Text color="red" dimColor>
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
