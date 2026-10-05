// tsx 对 .tsx 默认转 classic JSX（React 全局引用），与包内 react-jsx 构建配置不一致；
// 测试文件加载 react 全局 shim 使 JSX 运行时可用（仅测试进程作用域）。
import React from "react";

declare global {
  var React: typeof React;
}

globalThis.React = React;
