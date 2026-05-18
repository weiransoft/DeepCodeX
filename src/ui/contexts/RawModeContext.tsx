import React, { createContext, useContext, useState } from "react";
import type { DropdownMenuItem } from "../DropdownMenu";

export enum RawMode {
  None = "Normal mode",
  Lite = "Lite mode",
  Raw = "Raw scrollback mode",
}
export const RAW_COMMAND_MODELS: DropdownMenuItem[] = [
  {
    label: "Lite mode",
    key: RawMode.Lite,
  },
  {
    label: "Raw scrollback mode",
    key: RawMode.Raw,
  },
  {
    label: "Normal mode",
    key: RawMode.None,
  },
] as const;

const RawModeContext = createContext<{ mode: RawMode; setMode: React.Dispatch<React.SetStateAction<RawMode>> }>({
  mode: RawMode.Lite,
  setMode: () => {},
});

export function useRawModeContext() {
  const context = useContext(RawModeContext);
  if (!context) {
    throw new Error("useRawModeContext must be used within a RawModeProvider");
  }
  return context;
}

export const RawModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<RawMode>(RawMode.Lite);
  return <RawModeContext.Provider value={{ mode, setMode }}>{children}</RawModeContext.Provider>;
};
