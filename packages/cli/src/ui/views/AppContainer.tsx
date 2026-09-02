import React from "react";
import { AppContext } from "../contexts";
import App from "./App";
import { RawModeProvider } from "../contexts";

const AppContainer: React.FC<{
  projectRoot: string;
  version: string;
  initialPrompt: string | undefined;
  resumeSessionId: string | true | undefined;
  // 上游 v0.3.1 新增：forkSessionId（--fork-session 从现有会话派生新会话）
  forkSessionId: string | undefined;
  onRestart: () => void;
}> = ({ version, projectRoot, initialPrompt, resumeSessionId, forkSessionId, onRestart }) => {
  return (
    <AppContext.Provider value={{ version: version }}>
      <RawModeProvider>
        <App
          initialPrompt={initialPrompt}
          resumeSessionId={resumeSessionId}
          // 上游 v0.3.1 新增：透传 forkSessionId 给 App，用于派生会话
          forkSessionId={forkSessionId}
          projectRoot={projectRoot}
          onRestart={onRestart}
        />
      </RawModeProvider>
    </AppContext.Provider>
  );
};

export default AppContainer;
