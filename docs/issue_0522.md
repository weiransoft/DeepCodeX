# Deep Code Permission System (设计文档)

scopes是枚举值，列表如下：

```
# PermissionScope
read-in-cwd
read-out-cwd
write-in-cwd
write-out-cwd
delete-in-cwd
delete-out-cwd
query-git-log
mutate-git-log
network
mcp
```

settings.json的配置项（例子）：

```
{
  "permissions": {
    "allow": [
      "write-in-cwd"
    ],
    "deny": [
      "write-out-cwd"
    ],
    "ask": [
      "read-out-cwd"
    ],
    "defaultMode": "allowAll|askAll"  // 默认是allowAll
  }
}
```

工具和PermissionScope可能的对应关系：

- read: read-in-cwd, read-out-cwd
- write: write-in-cwd, write-out-cwd
- edit: write-in-cwd, write-out-cwd
- WebSearch: network
- mcp__*: mcp
- bash: 每一次bash命令需要的scope在sideEffects字段中。如果sideEffects字段为undefined|null，或者sideEffects包含了"unknown"则总是ask
- 其他: 无权限要求，总是允许

## bash tool的参数schema新增sideEffects字段

目标：让LLM在每一次调用`bash`时显式声明该命令可能需要的权限范围，后端只信任这个结构化字段，不从自然语言`description`中推断权限。

需要同步修改两处schema：

1. `src/prompt.ts`里的`getTools()`内置`bash`工具定义。
2. `templates/tools/bash.md`里的`bash`工具说明和JSON schema示例。

新增字段：

```
sideEffects: PermissionScope[] | ["unknown"]
```

`bash`可声明的scope只包含文件系统、Git历史和网络权限，不包含`mcp`：

```
read-in-cwd
read-out-cwd
write-in-cwd
write-out-cwd
delete-in-cwd
delete-out-cwd
query-git-log
mutate-git-log
network
unknown
```

建议schema如下：

```json
{
  "type": "object",
  "properties": {
    "command": {
      "description": "The command to execute",
      "type": "string"
    },
    "description": {
      "description": "Clear, concise description of what this command does in active voice.",
      "type": "string"
    },
    "sideEffects": {
      "description": "Permission scopes required by this bash command. Use [] only for commands that do not read, write, delete, or access the network. Use [\"unknown\"] when the effects cannot be classified safely.",
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "read-in-cwd",
          "read-out-cwd",
          "write-in-cwd",
          "write-out-cwd",
          "delete-in-cwd",
          "delete-out-cwd",
          "query-git-log",
          "mutate-git-log",
          "network",
          "unknown"
        ]
      },
      "uniqueItems": true
    }
  },
  "required": [
    "command",
    "sideEffects"
  ],
  "additionalProperties": false
}
```

字段语义：

- `sideEffects: []`表示命令不需要权限，例如`date`、`node --version`这类只读取进程环境或输出版本信息的命令。
- `sideEffects`必须按最小必要权限填写；例如`rg foo src`是`["read-in-cwd"]`，`npm install`通常是`["write-in-cwd", "network"]`。
- 如果命令访问项目目录之外的路径，需要使用`*-out-cwd`；例如`cat /etc/hosts`是`["read-out-cwd"]`。
- 删除类操作使用`delete-*`；如果同一条命令还会写入其他文件，再同时声明对应的`write-*`。
- 查询Git历史使用`query-git-log`；例如`git log`、`git show HEAD`、`git blame`、`git diff HEAD~1..HEAD`这类读取提交历史、提交对象或历史diff的命令。
- 修改Git历史或引用使用`mutate-git-log`；例如`git commit`、`git reset`、`git rebase`、`git merge`、`git cherry-pick`、`git tag`这类会创建提交、移动引用或改写提交图的命令。
- Git命令如果同时读写工作区文件，也需要同时声明文件系统scope；例如`git checkout -- src/foo.ts`需要`["write-in-cwd"]`，`git reset --hard HEAD~1`需要`["write-in-cwd", "mutate-git-log"]`。
- `unknown`只能单独出现为`["unknown"]`，不能和其他scope混用。

示例：

```json
{ "command": "date", "description": "Show current date", "sideEffects": [] }
{ "command": "rg \"TODO\" src", "description": "Search TODO markers in source files", "sideEffects": ["read-in-cwd"] }
{ "command": "npm install", "description": "Install package dependencies", "sideEffects": ["write-in-cwd", "network"] }
{ "command": "rm -rf dist", "description": "Delete build output directory", "sideEffects": ["delete-in-cwd"] }
{ "command": "curl -s https://example.com", "description": "Fetch example.com response", "sideEffects": ["network"] }
{ "command": "git show --stat HEAD", "description": "Show file statistics for HEAD", "sideEffects": ["query-git-log"] }
{ "command": "git blame src/prompt.ts", "description": "Show line authorship for prompt source", "sideEffects": ["read-in-cwd", "query-git-log"] }
{ "command": "git reset --hard HEAD~1", "description": "Reset branch and worktree to previous commit", "sideEffects": ["write-in-cwd", "mutate-git-log"] }
```

## 核心数据结构设计

```
export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
+ permissions?: [{toolCallId: "...", permission: "allow|deny"}];
+ alwaysAllows?: ["<PermissionScope>"];
};

export type SessionEntry = {
  id: string;
  ...
  toolCalls: unknown[] | null; // 例如：[{"id":"...","function":{"name":"bash","arguments":"{\"command\": \"...\", \"description\": \"...\"}"}}]
  status: SessionStatus;
+ askPermissions?: [{toolCallId: "...", scopes: ["<PermissionScope>"], name: "...", command: "...", description?: "..."}]; 
};

export type SessionStatus = "... | "completed" | "interrupted" | "ask_permission"; // 新增 ask_permission 状态

export type SessionMessage = {
  ...
  meta?: MessageMeta;
  ...
};

export type MessageMeta = {
  ...
+ permissions?: [{toolCallId: "...", permission: "allow|deny|ask"}];
+ userPrompt?: UserPromptContent; //对于role为user的消息，持久化userPrompt可方便后续排查问题
};
```

## 前端流程

如果当前会话状态不是ask_permission，则保持现状。会话状态是ask_permission时：

对SessionEntry.askPermissions中每一个toolCallId的每一个scope，显示权限弹窗（示例）：

```
<toolName>

   <command>
   <description>

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow <explain-of-the-scope>
   3. No
```

注意对于read/write/edit的`<command>`，格式可以是"工具名称+相对或绝对文件路径"，例如：`read ~/dev/main.c`

如果在权限弹窗过程中，用户按Esc，则走现有的interrupt流程（会话状态也应该变成"interrupted"）。

提醒注意一种情况：例如askPermissions里面有好几个item的scopes是`["write-in-cwd"]`，如果用户已经在第一个权限弹窗选了"always allow write in CWD `~/dev/qrcode_test/`"，则后面的几个scopes是`["write-in-cwd"]`的item就不用显示权限弹窗了。

如果用户完成了所有权限弹窗的选择，则判断：

1. 如果用户提交的结果中包含deny，则需要用户输入user prompt，按回车手动提交replySession()。
   - 如果用户没有输入user prompt就退出了，或者切换到了其他会话。则重新开始这个会话时，由于会话状态还是ask_permission，则会重新显示权限弹窗，要求用户选择。
2. 如果用户提交的结果中不包含deny，则以`/continue`作为UserPromptContent.text内容，前端自动提交replySession()。


## 后端流程

后端主要是对replySession()和activateSession()进行升级：

1. 支持传入UserPromptContent.permissions和alwaysAllows
2. 如果UserPromptContent.alwaysAllows非空，将其中的scopes追加写入项目级别的settings.json配置文件（`permissions.allow`字段），避免重复写入已存在的项。
3. 检查当前会话消息列表末尾是否存在连续的role为assistant的有tool_calls的消息，也就是"待执行消息"。如果没有，则走现有流程。
4. 对于每一条待执行消息，先检查UserPromptContent.permissions中对应的toolCallId的用户授权是allow还是deny
    - 如果是allow，则正常执行这个toolCall
    - 如果是deny，则直接返回失败结果，报错信息提示LLM用户禁用相关权限。例如：
    ```
    {
      "ok": false,
      "name": "edit",
      "error": "用户已禁用了在项目目录之外修改文件的权限，请不要尝试用任何方式修改目录之外的文件"
    }
    ```
5. 如果对于某条待执行消息，在UserPromptContent.permissions没有出现对应的toolCallId的用户授权，则检查它的 SessionMessage.meta.permissions[].permission 是allow还是deny还是ask
    - 如果是allow，则正常执行这个toolCall
    - 如果是deny，则直接返回失败结果，报错信息提示LLM用户禁用相关权限
    - 如果是ask，则直接返回失败结果，报错信息提示LLM用户未授权执行。例如：
    ```
    {
      "ok": false,
      "name": "edit",
      "error": "用户暂未授权执行，如果有必要，可重新尝试执行"
    }
    ```
    - 如果不存在，则正常执行这个toolCall（兼容老版本会话数据）
6. 当LLM返回了新的待执行消息时，不要立即执行，而是：
    1. 根据配置的permissions和defaultMode，计算出SessionMessage.meta.permissions字段
    2. 如果存在一个待执行消息的SessionMessage.meta.permissions[].permission是ask，则把SessionEntry.status设置为"ask_permission"，并设置好SessionEntry.askPermissions，然后退出activateSession，这样就回到了上面的前端流程。
