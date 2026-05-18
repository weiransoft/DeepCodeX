import type React from "react";
import { useInput } from "ink";

export function RawModeExitPrompt({ onExit }: { onExit: () => void }): React.ReactElement | null {
  useInput(
    (_input, key) => {
      if (key.escape) {
        onExit();
      }
    },
    { isActive: true }
  );

  return null;
}
