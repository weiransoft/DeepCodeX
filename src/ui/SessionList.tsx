import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionEntry } from "../session";

type Props = {
  sessions: SessionEntry[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
};

export function SessionList({ sessions, onSelect, onCancel }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === "c" || input === "C"))) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const session = sessions[index];
      if (session) {
        onSelect(session.id);
      }
    }
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No previous sessions found.</Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyanBright">Resume a session</Text>
      {sessions.slice(0, 30).map((session, i) => (
        <Text key={session.id} color={i === index ? "cyanBright" : undefined}>
          {i === index ? "› " : "  "}
          <Text dimColor>{formatTimestamp(session.updateTime)} </Text>
          <Text>{formatSessionTitle(session.summary || "Untitled")}</Text>
          <Text dimColor>  ({session.status})</Text>
        </Text>
      ))}
      {sessions.length > 30 ? <Text dimColor>… {sessions.length - 30} older sessions hidden.</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ to navigate · Enter to select · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function formatTimestamp(value: string): string {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      return value;
    }
    return date.toLocaleString();
  } catch {
    return value;
  }
}

export function formatSessionTitle(value: string, max = 70): string {
  return truncate(value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim(), max);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}
