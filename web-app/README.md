# OpenClaw Web App 本地部署指南

## 前提条件

- **Node.js 22+**
- **pnpm** (包管理器)
- **Git**

## 1. 克隆并构建项目

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
git checkout cursor/openclaw-user-agent-isolation-2fca

# 安装依赖
pnpm install

# 构建 OpenClaw CLI + Gateway
pnpm build

# 安装 web-app 依赖
cd web-app
pnpm install
cd ..
```

## 2. 配置 OpenClaw

编辑 `~/.openclaw/openclaw.json`（如果不存在则创建）：

```json
{
  "models": {
    "providers": {
      "volcengine": {
        "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "<你的 API Key>",
        "api": "openai-completions",
        "models": [
          {
            "id": "glm-4.7",
            "name": "glm-4.7",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192,
            "compat": { "supportsDeveloperRole": false }
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "volcengine/glm-4.7"
      },
      "models": {
        "volcengine/glm-4.7": {
          "alias": "volcengine"
        }
      },
      "compaction": {
        "mode": "safeguard"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
      }
    }
  },
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    },
    "auth": {
      "mode": "token",
      "token": "<留空，首次启动 gateway 会自动生成>"
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": true }
      }
    }
  }
}
```

或者用 CLI 配置（推荐）：

```bash
# 设置 gateway 模式
node openclaw.mjs config set gateway.mode local

# 允许无设备认证连接（web-app 代理需要）
node openclaw.mjs config set gateway.controlUi.dangerouslyDisableDeviceAuth true
```

> **注意**：`gateway.auth.token` 会在首次启动 gateway 时自动生成。

## 3. 启动 Gateway

```bash
cd /path/to/openclaw

# 前台运行（可以看日志）
node openclaw.mjs gateway run --bind loopback --port 18789 --force

# 或者后台运行
nohup node openclaw.mjs gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

确认 Gateway 启动成功：

```bash
# 检查端口
ss -ltnp | grep 18789

# 查看日志（应该看到 "agent model: volcengine/glm-4.7"）
tail -10 /tmp/openclaw-gateway.log
```

## 4. 启动 Web App

```bash
cd /path/to/openclaw/web-app

# 读取 gateway token（必须在 gateway 启动之后）
export OPENCLAW_GATEWAY_TOKEN=$(node -e "
  const c = require('fs').readFileSync(
    require('os').homedir() + '/.openclaw/openclaw.json', 'utf-8'
  );
  console.log(JSON.parse(c).gateway?.auth?.token || '');
")

# 启动 web-app（默认端口 3000）
node --import tsx server/index.ts

# 或指定端口
WEB_APP_PORT=8080 node --import tsx server/index.ts

# 后台运行
nohup node --import tsx server/index.ts > /tmp/openclaw-webapp.log 2>&1 &
```

## 5. 访问

浏览器打开 `http://localhost:3000`（或你指定的端口）。

1. 点击 **注册** 创建账号
2. 注册时会自动创建专属 Agent
3. 登录后即可在聊天界面与 AI 对话
4. 左侧边栏可以浏览 Agent 的工作区文件

## 环境变量

| 变量名                   | 默认值                 | 说明                           |
| ------------------------ | ---------------------- | ------------------------------ |
| `WEB_APP_PORT`           | `3000`                 | Web App 监听端口               |
| `OPENCLAW_GATEWAY_URL`   | `ws://127.0.0.1:18789` | Gateway WebSocket 地址         |
| `OPENCLAW_GATEWAY_TOKEN` | (空)                   | Gateway 认证 Token（必须设置） |
| `OPENCLAW_STATE_DIR`     | `~/.openclaw`          | OpenClaw 状态目录              |

## 一键启动脚本

在项目根目录创建 `start.sh`：

```bash
#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_PORT=18789
WEBAPP_PORT=3000

echo "=== Starting OpenClaw Gateway ==="
cd "$REPO_DIR"
nohup node openclaw.mjs gateway run --bind loopback --port $GATEWAY_PORT --force \
  > /tmp/openclaw-gateway.log 2>&1 &
sleep 4

if ! ss -ltnp | grep -q ":$GATEWAY_PORT"; then
  echo "ERROR: Gateway failed to start. Check /tmp/openclaw-gateway.log"
  exit 1
fi
echo "Gateway running on port $GATEWAY_PORT"

# Read token
export OPENCLAW_GATEWAY_TOKEN=$(node -e "
  const c = require('fs').readFileSync(
    require('os').homedir() + '/.openclaw/openclaw.json', 'utf-8'
  );
  console.log(JSON.parse(c).gateway?.auth?.token || '');
")

echo "=== Starting Web App ==="
cd "$REPO_DIR/web-app"
WEB_APP_PORT=$WEBAPP_PORT nohup node --import tsx server/index.ts \
  > /tmp/openclaw-webapp.log 2>&1 &
sleep 2

echo ""
echo "✅ All services started"
echo "   Gateway:  ws://127.0.0.1:$GATEWAY_PORT"
echo "   Web App:  http://localhost:$WEBAPP_PORT"
echo ""
echo "Logs:"
echo "   Gateway:  tail -f /tmp/openclaw-gateway.log"
echo "   Web App:  tail -f /tmp/openclaw-webapp.log"
```

```bash
chmod +x start.sh
./start.sh
```

## 停止服务

```bash
# 停止 web-app
lsof -ti:3000 | xargs kill 2>/dev/null

# 停止 gateway
lsof -ti:18789 | xargs kill 2>/dev/null
```

## 常见问题

### Gateway 未连接

确保：

1. Gateway 正在运行（`ss -ltnp | grep 18789`）
2. `OPENCLAW_GATEWAY_TOKEN` 环境变量已正确设置
3. `gateway.controlUi.dangerouslyDisableDeviceAuth` 设为 `true`

### Agent 创建失败

如果注册时报 "创建 Agent 失败"，web-app 会自动回退到仅创建本地目录。Agent 功能在 Gateway 正常运行后会自动恢复。

### 模型 API Key 错误

确保 `~/.openclaw/openclaw.json` 中 `models.providers.volcengine.apiKey` 正确，且 `agents.defaults.model.primary` 设为 `volcengine/glm-4.7`。
