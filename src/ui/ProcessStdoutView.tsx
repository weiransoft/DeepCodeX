import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { SessionEntry } from "../session";
import { useTerminalInput } from "./prompt";

type RunningProcesses = SessionEntry["processes"];

type ProcessStdoutViewProps = {
  processStdoutRef: React.MutableRefObject<Map<number, string>>;
  runningProcesses: RunningProcesses;
  onDismiss: () => void;
  screenWidth: number;
};

const REFRESH_INTERVAL_MS = 150;
const MAX_VISIBLE_LINES = 100;

export const ProcessStdoutView = React.memo(function ProcessStdoutView({
  processStdoutRef,
  runningProcesses,
  onDismiss,
  screenWidth,
}: ProcessStdoutViewProps): React.ReactElement {
  const [stdoutText, setStdoutText] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const containerRef = useRef<{ lineCount: number }>({ lineCount: 0 });

  useEffect(() => {
    const updateStdout = () => {
      let text = "";
      if (runningProcesses && runningProcesses.size > 0) {
        for (const [pid, proc] of runningProcesses.entries()) {
          const pidNum = Number(pid);
          const stdout = processStdoutRef.current.get(pidNum) ?? "";
          if (text) {
            text += "\n";
          }
          if (runningProcesses.size > 1) {
            text += `── Process ${pid} [${proc.command}] ──\n`;
          }
          text += stdout || "(no output yet)";
        }
      } else {
        text = "(no running processes)";
      }
      setStdoutText(text);
    };

    updateStdout();
    const interval = setInterval(updateStdout, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [processStdoutRef, runningProcesses]);

  // Update container line count for scroll awareness
  const lines = useMemo(() => stdoutText.split("\n"), [stdoutText]);
  containerRef.current.lineCount = lines.length;

  const visibleLines = useMemo(() => {
    if (lines.length <= MAX_VISIBLE_LINES) {
      return lines;
    }
    const start = Math.max(0, lines.length - MAX_VISIBLE_LINES - scrollOffset);
    const slice = lines.slice(start, start + MAX_VISIBLE_LINES);
    if (lines.length > MAX_VISIBLE_LINES) {
      slice.unshift(`... (${start} lines above · ↑/↓ to scroll · ${lines.length} total lines) ...`);
    }
    return slice;
  }, [lines, scrollOffset]);

  useTerminalInput(
    (input, key) => {
      if ((key.ctrl && (input === "o" || input === "O")) || key.escape) {
        onDismiss();
        return;
      }
      if (key.upArrow) {
        setScrollOffset((s) => Math.min(s + 10, Math.max(0, lines.length - MAX_VISIBLE_LINES)));
        return;
      }
      if (key.downArrow) {
        setScrollOffset((s) => Math.max(s - 10, 0));
        return;
      }
      if (key.pageUp) {
        setScrollOffset((s) => Math.min(s + MAX_VISIBLE_LINES, Math.max(0, lines.length - MAX_VISIBLE_LINES)));
        return;
      }
      if (key.pageDown) {
        setScrollOffset((s) => Math.max(s - MAX_VISIBLE_LINES, 0));
        return;
      }
    },
    { isActive: true }
  );

  return (
    <Box flexDirection="column" width={screenWidth} minWidth={80}>
      <Box borderStyle="single" borderBottom={true} borderLeft={false} borderRight={false} borderTop={false}>
        <Text bold>📟 Process Output</Text>
        <Text dimColor> (Ctrl+O or Esc to close · ↑↓ PageUp/PageDown to scroll)</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {visibleLines.map((line, index) => (
          <Text key={`${index}`}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
});
