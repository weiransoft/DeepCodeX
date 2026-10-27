/**
 * AgentsDropdown —— 自定义 Agent 选择下拉（T03，镜像 SkillsDropdown）
 *
 * 列出扫描根内发现的 type: agent 定义（名称 + 描述 + 来源根），
 * 选中后经 App 层调用 SessionManager.loadAgentIntoSession 注入角色约束。
 *
 * @module ui/components/AgentsDropdown
 */

import DropdownMenu from "../DropdownMenu";
import React, { useEffect, useState } from "react";
import type { SkillInfo } from "@vegamo/deepcode-core";
import { useInput } from "ink";

const AgentsDropdown: React.FC<{
  open: boolean;
  onClose?: (value: boolean) => void;
  width: number;
  agents: SkillInfo[];
  onSelect?: (agent: SkillInfo) => void;
}> = ({ open, width, agents, onSelect, onClose }) => {
  const [agentsDropdownIndex, setAgentsDropdownIndex] = useState(0);
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setAgentsDropdownIndex((idx) => (idx - 1 + agents.length) % agents.length);
        return;
      }
      if (key.downArrow) {
        setAgentsDropdownIndex((idx) => (idx + 1) % agents.length);
        return;
      }
      if (key.return && !key.shift && !key.meta) {
        const agent = agents[agentsDropdownIndex];
        if (agent) {
          onSelect?.(agent);
        }
        return;
      }
      if (key.tab) {
        onClose?.(false);
        return;
      }
      if (key.escape) {
        onClose?.(false);
      }
    },
    { isActive: open }
  );

  useEffect(() => {
    if (agentsDropdownIndex >= agents.length) {
      setAgentsDropdownIndex(Math.max(0, agents.length - 1));
    }
  }, [agents.length, agentsDropdownIndex]);

  if (!open) {
    return null;
  }

  return (
    <DropdownMenu
      width={width}
      title="选择 Agent"
      helpText="Enter 调用 · Esc 关闭"
      emptyText="未发现自定义 Agent（在 ~/.deepcode/skills/<name>/SKILL.md 的 frontmatter 写 type: agent）"
      items={agents.map((agent) => ({
        key: agent.path || agent.name,
        label: agent.name,
        description: agent.description || agent.path,
        statusIndicator: agent.isLoaded ? { symbol: "✓", color: "green" } : undefined,
      }))}
      activeIndex={agentsDropdownIndex}
      activeColor="#229ac3"
      maxVisible={6}
    />
  );
};

export default AgentsDropdown;
