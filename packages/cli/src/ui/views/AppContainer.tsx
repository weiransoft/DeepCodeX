import React from "react";
import { AppContext } from "../contexts";
import App from "./App";
import { RawModeProvider } from "../contexts";
// 三态权限模式类型（2026-09-17 设计文档 docs/dev/permission-modes.md）
import type { PermissionMode } from "@vegamo/deepcode-core";

const AppContainer: React.FC<{
  projectRoot: string;
  version: string;
  initialPrompt: string | undefined;
  resumeSessionId: string | true | undefined;
  // 上游 v0.3.1 新增：forkSessionId（--fork-session 从现有会话派生新会话）
  forkSessionId: string | undefined;
  // 三态权限模式覆盖（CLI --permission-mode 透传，未传时 undefined 走 settings.json）
  permissionMode: PermissionMode | undefined;
  onRestart: () => void;
}> = ({ version, projectRoot, initialPrompt, resumeSessionId, forkSessionId, permissionMode, onRestart }) => {
  return (
    <AppContext.Provider value={{ version: version }}>
      <RawModeProvider>
        <App
          initialPrompt={initialPrompt}
          resumeSessionId={resumeSessionId}
          // 上游 v0.3.1 新增：透传 forkSessionId 给 App，用于派生会话
          forkSessionId={forkSessionId}
          // 三态权限模式覆盖透传给 App → SessionManager.permissionModeOverride
          permissionMode={permissionMode}
          projectRoot={projectRoot}
          onRestart={onRestart}
        />
      </RawModeProvider>
    </AppContext.Provider>
  );
};

export default AppContainer;
