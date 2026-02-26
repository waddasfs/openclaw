# OpenClaw 用户级 Agent 隔离分析

## 1. 现有架构概述

### 1.1 Agent 模型

OpenClaw 的 agent 是系统中的核心隔离单元。每个 agent 拥有：

| 隔离维度   | 存储位置                                           | 说明                                                   |
| ---------- | -------------------------------------------------- | ------------------------------------------------------ |
| 配置       | `config.agents.list[]` (`AgentConfig`)             | 独立的模型、工具、sandbox、技能等配置                  |
| 工作区     | `~/.openclaw/workspace-<id>/`                      | 独立的工作目录，包含 SOUL.md、TOOLS.md、IDENTITY.md 等 |
| 会话存储   | `~/.openclaw/agents/<id>/sessions/`                | 独立的 session store 和 transcript 文件                |
| Agent 目录 | `~/.openclaw/agents/<id>/agent/`                   | 独立的 agent 元数据目录                                |
| Sandbox    | `AgentSandboxConfig` (scope: session/agent/shared) | 可选的 Docker 容器隔离                                 |

**关键类型** (`src/config/types.agents.ts`):

```typescript
type AgentConfig = {
  id: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  skills?: string[];
  sandbox?: AgentSandboxConfig;
  tools?: AgentToolsConfig;
  identity?: IdentityConfig;
  // ...
};
```

### 1.2 用户模型

OpenClaw 的 "用户" 概念是 **channel-native** 的，没有统一的跨渠道用户实体：

- **Telegram**: 数值型 user ID
- **Discord**: user ID + role ID
- **WhatsApp**: E.164 电话号码
- **Signal**: username

用户通过 `SenderId`、`SenderName`、`SenderUsername`、`SenderE164` 等字段在各渠道内被识别。

### 1.3 路由机制

消息路由的核心函数是 `resolveAgentRoute()` (`src/routing/resolve-route.ts`)，其流程：

```
消息到达 → Channel 提取 sender identity → 访问控制检查 → resolveAgentRoute() → 选择 agent
```

**绑定（Binding）匹配优先级**：

1. `binding.peer` — 精确 peer 匹配（如 specific chat ID）
2. `binding.peer.parent` — 父级 peer（线程继承）
3. `binding.guild+roles` — Guild + 角色匹配
4. `binding.guild` — Guild 匹配
5. `binding.team` — Team 匹配
6. `binding.account` — Account 级匹配
7. `binding.channel` — Channel 级匹配
8. `default` — 默认 agent

**Session Key 格式**: `agent:<agentId>:<channel>:<accountId>:<peerKind>:<peerId>`

### 1.4 DM Scope 会话范围

`session.dmScope` 配置项控制 DM 消息的会话归并策略：

- `"main"`: 所有 DM 共享一个会话（默认）
- `"per-peer"`: 每个用户一个独立会话
- `"per-channel-peer"`: 每个 channel+用户 一个会话
- `"per-account-channel-peer"`: 每个 account+channel+用户 一个会话

## 2. 当前是否支持 User→Agent 映射隔离？

### 2.1 部分支持：通过 Binding + per-peer 实现 "软隔离"

**目前可以做到的**：

1. **Binding 级别路由**：可以通过配置 binding 把特定用户（peer）路由到特定 agent：

   ```yaml
   bindings:
     - agentId: "user-alice"
       match:
         channel: telegram
         peer:
           kind: direct
           id: "123456789"
     - agentId: "user-bob"
       match:
         channel: discord
         peer:
           kind: direct
           id: "987654321"
   ```

2. **会话隔离**：当 `dmScope: per-peer` 时，每个用户会有独立的 session key 和 session transcript。

3. **Sandbox 隔离**：当 `sandbox.scope: session` 时，每个会话可以有独立的 Docker 容器。

### 2.2 不支持：动态的 User→Agent 自动映射

**关键缺失**：

1. **静态配置问题**：Binding 是静态配置在 `openclaw.yaml` 中的。要为每个新用户创建独立 agent，需要手动或程序化地：
   - 在 `agents.list` 中创建 agent 条目
   - 在 `bindings` 中创建路由规则
   - 写入配置文件并热加载

2. **无自动创建机制**：当一个未知用户首次发消息时，系统只有 pairing（配对审批）或 allowlist 机制，没有"自动为该用户创建独立 agent"的逻辑。

3. **Agent 是全局共享的**：目前的设计假设 agent 是运维人员预先创建的实体（如 "main"、"ops"、"assistant"），而不是 per-user 动态实体。

4. **跨渠道身份统一缺失**：`identityLinks` 可以跨渠道合并 session，但它是手动配置的映射，不是自动的用户注册/认证系统。

5. **Binding 缺少 sender 维度**：`AgentBinding.match` 支持 `channel`、`accountId`、`peer`、`guildId`、`teamId`、`roles`，但 `peer` 表示的是 chat/group ID，而非 sender ID。在 DM 场景中 peer 等于 sender，但在 group 场景中它们不同。

## 3. 实现 User→Agent 隔离需要的修改

### 3.1 方案一：基于现有 Binding 的静态映射（最小修改）

**适用场景**：用户量小、可手动管理。

**做法**：

- 利用现有 `agents.create` API 为每个用户创建 agent
- 利用现有 binding 配置把用户路由到对应 agent
- 设置 `dmScope: per-peer` + `sandbox.scope: session`

**缺点**：

- 完全手动或需要外部编排
- 配置文件会膨胀
- 无法处理用户自注册场景

### 3.2 方案二：动态 User→Agent 自动映射（中等修改）

**核心思路**：在路由层增加 "per-sender agent" 策略，当新用户到达时自动创建 agent 并绑定。

**需要修改的模块**：

#### 3.2.1 新增路由策略 `agentScope: per-sender`

**文件**: `src/config/types.base.ts`

```typescript
export type AgentScopeMode = "shared" | "per-sender";

export type SessionConfig = {
  // ... existing fields
  agentScope?: AgentScopeMode;
};
```

#### 3.2.2 修改路由解析逻辑

**文件**: `src/routing/resolve-route.ts`

在 `resolveAgentRoute()` 中，当 `agentScope === "per-sender"` 时：

1. 基于 sender identity 生成确定性的 agent ID（如 `user-<channel>-<senderId>` 的 hash）
2. 检查该 agent 是否已存在
3. 如不存在，触发自动创建
4. 返回路由到该用户专属 agent

```typescript
// 伪代码
function resolvePerSenderAgentId(channel: string, senderId: string): string {
  return `user-${channel}-${normalizeAgentId(senderId)}`;
}
```

#### 3.2.3 Agent 自动创建/销毁生命周期

**新文件**: `src/agents/auto-provision.ts`

```typescript
export async function ensureUserAgent(params: {
  cfg: OpenClawConfig;
  channel: string;
  senderId: string;
  senderName?: string;
  template?: string; // 模板 agent ID
}): Promise<{ agentId: string; created: boolean }>;

export async function deprovisionUserAgent(agentId: string): Promise<void>;
```

关键行为：

- 从模板 agent 继承默认配置（model、tools、sandbox 等）
- 创建独立的 workspace 和 sessions 目录
- 可选：设置 TTL 自动清理不活跃用户的 agent

#### 3.2.4 修改 Channel 消息处理入口

**涉及文件**（每个 channel 的消息入口）：

- `src/telegram/bot-message-context.ts`
- `src/discord/monitor/message-handler.preflight.ts`
- `src/web/auto-reply/monitor/on-message.ts`
- `src/signal/monitor/event-handler.ts`
- `src/slack/monitor/message-handler/prepare.ts`
- 各 extension 的 `monitor.ts`

在调用 `resolveAgentRoute()` 之前，需要增加 sender ID 参数传递，使路由层能感知"是谁发的消息"。

#### 3.2.5 配置 Schema 变更

**文件**: `src/config/types.agents.ts`

```typescript
export type AgentConfig = {
  // ... existing fields
  /** Template flag: this agent serves as a template for auto-provisioned user agents. */
  template?: boolean;
  /** Owner sender identity (for auto-provisioned agents). */
  owner?: {
    channel: string;
    senderId: string;
  };
};
```

### 3.3 方案三：完整的 User 实体 + Agent 映射（大幅修改）

**适用场景**：企业级多租户、SaaS 部署。

**新增核心概念**：

#### 3.3.1 User 实体

```typescript
type User = {
  id: string; // UUID
  displayName: string;
  identities: UserIdentity[];
  agentId: string; // 映射的 agent ID
  createdAt: number;
  lastActiveAt: number;
  quota?: UserQuota; // 可选配额限制
};

type UserIdentity = {
  channel: string;
  senderId: string;
  senderName?: string;
  verified: boolean;
};
```

#### 3.3.2 User Store

新文件 `src/users/store.ts`：

- 基于文件系统或 SQLite 的用户存储
- 按 channel+senderId 索引快速查找
- 跨渠道身份关联（替代手动 `identityLinks`）

#### 3.3.3 用户配额与资源限制

```typescript
type UserQuota = {
  maxTokensPerDay?: number;
  maxMessagesPerHour?: number;
  maxStorageMb?: number;
  allowedModels?: string[];
};
```

#### 3.3.4 完整的修改清单

| 模块           | 修改                                          | 复杂度     |
| -------------- | --------------------------------------------- | ---------- |
| 配置 Schema    | 新增 `agentScope`、`userAgentTemplate` 配置项 | 低         |
| 路由层         | `resolveAgentRoute()` 增加 sender-aware 路由  | 中         |
| Agent 生命周期 | 自动 provision/deprovision user agents        | 中         |
| Session Key    | 可能需要新的 key 格式 `agent:user-<uid>:...`  | 低         |
| Channel 入口   | 各 channel 传递 sender ID 到路由层            | 中（量大） |
| 用户存储       | 新增 User Store                               | 高         |
| Gateway API    | 新增用户管理 API                              | 中         |
| CLI            | 新增用户管理命令                              | 低         |
| 文档           | 新增用户隔离配置文档                          | 低         |

## 4. 推荐方案

### 对于快速验证（POC）

推荐 **方案二**（动态 User→Agent 自动映射），原因：

- 复用现有 agent 隔离基础设施（workspace、sessions、sandbox 全部现成）
- 修改量适中，核心变更集中在路由层和 agent 自动创建
- 不需要引入新的持久化层（User Store）

### 关键实现路径

1. **配置**: 在 `SessionConfig` 中新增 `agentScope: "per-sender"` 选项
2. **路由**: 在 `resolveAgentRoute()` 中检测 `agentScope`，如为 `per-sender` 则基于 sender 生成确定性 agent ID
3. **自动创建**: 新增 `ensureUserAgent()` 函数，利用现有 `agents.create` 逻辑从模板 agent 创建用户 agent
4. **Channel 适配**: 在各 channel 的路由调用处传入 sender identity
5. **清理**: 可选的自动清理策略（基于最后活跃时间）

### 工作量估算

| 阶段                          | 预估工时    |
| ----------------------------- | ----------- |
| 配置 Schema + Zod 验证        | 2-4h        |
| 路由层修改                    | 4-8h        |
| Agent 自动创建逻辑            | 4-8h        |
| Channel 入口适配（核心 6 个） | 8-12h       |
| Extension 适配                | 4-8h        |
| 测试                          | 8-16h       |
| 文档                          | 2-4h        |
| **总计**                      | **~32-60h** |

## 5. 隔离保证分析

### 5.1 现有 Agent 隔离已提供的保证

| 维度          | 隔离程度 | 实现方式                                           |
| ------------- | -------- | -------------------------------------------------- |
| 会话历史      | 完全隔离 | 独立 session store + transcript 文件               |
| 系统提示/人设 | 完全隔离 | 独立 workspace（SOUL.md、IDENTITY.md）             |
| 工具配置      | 完全隔离 | per-agent `AgentToolsConfig`                       |
| 模型选择      | 完全隔离 | per-agent `AgentModelConfig`                       |
| 工作目录      | 完全隔离 | 独立 workspace 路径                                |
| 文件系统      | 可选隔离 | `sandbox.scope: session` + Docker                  |
| 记忆/向量搜索 | 部分隔离 | per-agent `MemorySearchConfig`，但底层存储可能共享 |
| API Key/凭证  | 不隔离   | 全局配置，所有 agent 共享                          |

### 5.2 User→Agent 映射后的额外隔离需求

- **API Key 隔离**：如果需要 per-user 计费，需要支持 per-agent provider credentials
- **资源配额**：需要 per-agent token/message 限额机制
- **数据清除**：需要支持删除用户时完整清除该 agent 的所有数据
- **审计日志**：需要 per-user 操作审计

## 6. 结论

**OpenClaw 现有架构为 User→Agent 映射提供了良好的基础**。Agent 层已经实现了完善的隔离机制（workspace、sessions、sandbox），缺失的是从"用户身份"到"agent 实例"的自动化映射层。

最关键的 gap 是：

1. 路由层不感知 sender identity（只感知 peer/channel/guild）
2. 没有 agent 自动创建/销毁的生命周期管理
3. 缺少用户→agent 的持久化映射

这些 gap 可以通过中等规模的修改（方案二）来填补，核心工作量在路由层改造和各 channel 适配上。
