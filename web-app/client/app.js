/* eslint-disable */
// @ts-nocheck
// OpenClaw Web App - Frontend (browser-only, not subject to project TS lint)

const app = document.getElementById("app");

// ---- State ----
const state = {
  page: "loading",
  token: localStorage.getItem("openclaw_token"),
  user: null,
  ws: null,
  connected: false,
  gatewayStatus: "disconnected",
  gatewayStatusShown: false,
  sessionKey: null,
  agentId: null,
  messages: [],
  sending: false,
  streaming: "",
  streamRunId: null,
  sidebarTab: "workspace",
  workspacePath: "",
  workspaceFiles: [],
  workspaceTree: [],
  treePath: "",
  viewingFile: null,
  viewingFileContent: "",
};

// ---- API Helpers ----
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const opts = { method, headers };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// ---- Auth ----
async function checkAuth() {
  if (!state.token) {
    state.page = "login";
    render();
    return;
  }
  try {
    const data = await api("GET", "/api/auth/me");
    state.user = data.user;
    state.agentId = data.user.agentId;
    state.page = "main";
    render();
    connectWs();
    void loadWorkspace();
  } catch {
    localStorage.removeItem("openclaw_token");
    state.token = null;
    state.page = "login";
    render();
  }
}

async function doLogin(username, password) {
  const data = await api("POST", "/api/auth/login", { username, password });
  state.token = data.token;
  state.user = data.user;
  state.agentId = data.user.agentId;
  localStorage.setItem("openclaw_token", data.token);
  state.page = "main";
  render();
  connectWs();
  void loadWorkspace();
}

async function doRegister(username, password, displayName) {
  const data = await api("POST", "/api/auth/register", { username, password, displayName });
  state.token = data.token;
  state.user = data.user;
  state.agentId = data.user.agentId;
  localStorage.setItem("openclaw_token", data.token);
  state.page = "main";
  render();
  connectWs();
  void loadWorkspace();
}

function doLogout() {
  localStorage.removeItem("openclaw_token");
  state.token = null;
  state.user = null;
  state.connected = false;
  state.gatewayStatus = "disconnected";
  state.gatewayStatusShown = false;
  state.messages = [];
  wsRetryCount = 0;
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  state.page = "login";
  render();
}

async function doDeleteAccount() {
  if (!confirm("确定要注销账号吗？该操作将删除你的 Agent 和所有数据，不可撤销。")) return;
  try {
    await api("DELETE", "/api/auth/delete");
  } catch {
    /* ignore */
  }
  doLogout();
}

// ---- WebSocket ----
let wsRetryCount = 0;
let wsRetryTimer = null;
const MAX_WS_RETRIES = 10;

function connectWs() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = proto + "//" + location.host + "/ws/chat?token=" + state.token;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    state.gatewayStatus = "unavailable";
    render();
    scheduleWsRetry();
    return;
  }
  state.ws = ws;

  ws.addEventListener("open", function () {
    // Connection to our web-app server established; waiting for gateway proxy status
  });

  ws.addEventListener("message", function (event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "connected") {
      state.connected = true;
      state.gatewayStatus = "connected";
      state.sessionKey = msg.sessionKey;
      state.agentId = msg.agentId;
      wsRetryCount = 0;
      addSystemMessage("已连接到 Agent: " + msg.agentId);
      void loadHistory();
      render();
      return;
    }

    if (msg.type === "gateway_status") {
      state.gatewayStatus = msg.status;
      state.connected = msg.status === "connected";
      if (msg.status === "unavailable" || msg.status === "disconnected") {
        // Don't spam messages — just update status bar
        if (!state.gatewayStatusShown) {
          state.gatewayStatusShown = true;
          const hint = msg.message || "Gateway 未连接，请确保 openclaw gateway 已运行";
          addSystemMessage(hint);
        }
      }
      if (msg.status === "auth_failed") {
        addSystemMessage("Gateway 认证失败，请检查 token 配置");
      }
      render();
      return;
    }

    if (msg.type === "error") {
      addSystemMessage("错误: " + msg.message);
      render();
      return;
    }
    if (msg.type === "res") {
      handleResponse(msg);
      return;
    }
    if (msg.type === "event") {
      handleEvent(msg);
      return;
    }
  });

  ws.addEventListener("close", function () {
    state.connected = false;
    state.ws = null;
    render();
    scheduleWsRetry();
  });

  ws.addEventListener("error", function () {
    // "close" fires after "error"
  });
}

function scheduleWsRetry() {
  if (!state.token || state.page !== "main") return;
  if (wsRetryCount >= MAX_WS_RETRIES) return;
  const delay = Math.min(3000 * Math.pow(1.5, wsRetryCount), 30000);
  wsRetryCount++;
  wsRetryTimer = setTimeout(connectWs, delay);
}

let reqCounter = 0;
const pendingReqs = new Map();

function wsRequest(method, params) {
  return new Promise(function (resolve, reject) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error("未连接"));
      return;
    }
    const id = "req-" + ++reqCounter + "-" + Date.now();
    const timer = setTimeout(function () {
      pendingReqs.delete(id);
      reject(new Error("请求超时"));
    }, 60000);
    pendingReqs.set(id, { resolve, reject, timer });
    state.ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

function handleResponse(msg) {
  const entry = pendingReqs.get(msg.id);
  if (!entry) return;
  pendingReqs.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.ok) entry.resolve(msg.payload);
  else entry.reject(new Error(msg.error && msg.error.message ? msg.error.message : "请求失败"));
}

function handleEvent(msg) {
  const evtName = msg.event;
  const payload = msg.payload || {};

  if (evtName === "chat.event" || evtName === "chat") {
    const chatState = payload.state;
    const runId = payload.runId;

    if (chatState === "delta") {
      if (state.streamRunId !== runId) {
        state.streamRunId = runId;
        state.streaming = "";
      }
      const text = extractTextFromMessage(payload.message);
      if (text) state.streaming += text;
      render();
    } else if (chatState === "final") {
      if (state.streaming) {
        state.messages.push({ role: "assistant", content: state.streaming, ts: Date.now() });
      } else {
        const text = extractTextFromMessage(payload.message);
        if (text) state.messages.push({ role: "assistant", content: text, ts: Date.now() });
      }
      state.streaming = "";
      state.streamRunId = null;
      state.sending = false;
      render();
      scrollToBottom();
    } else if (chatState === "error" || chatState === "aborted") {
      if (payload.errorMessage) addSystemMessage("错误: " + payload.errorMessage);
      state.streaming = "";
      state.streamRunId = null;
      state.sending = false;
      render();
    }
  }
}

function extractTextFromMessage(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (typeof message === "object") {
    if (message.content) {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .filter(function (b) {
            return b.type === "text";
          })
          .map(function (b) {
            return b.text || "";
          })
          .join("");
      }
    }
    if (message.text) return message.text;
  }
  return "";
}

// ---- Chat ----
async function loadHistory() {
  try {
    const res = await wsRequest("chat.history", { limit: 200 });
    if (res && Array.isArray(res.messages)) {
      state.messages = res.messages
        .map(function (m) {
          return { role: m.role || "unknown", content: extractTextFromMessage(m), ts: m.ts || 0 };
        })
        .filter(function (m) {
          return m.content;
        });
    }
    render();
    scrollToBottom();
  } catch {
    /* new session */
  }
}

async function sendMessage(text) {
  if (!text.trim() || state.sending) return;
  state.messages.push({ role: "user", content: text.trim(), ts: Date.now() });
  state.sending = true;
  state.streaming = "";
  render();
  scrollToBottom();
  try {
    const idempotencyKey = "web-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    await wsRequest("chat.send", { message: text.trim(), idempotencyKey, timeoutMs: 120000 });
  } catch (err) {
    addSystemMessage("发送失败: " + err.message);
    state.sending = false;
    render();
  }
}

function addSystemMessage(text) {
  state.messages.push({ role: "system", content: text, ts: Date.now() });
}

function scrollToBottom() {
  requestAnimationFrame(function () {
    const el = document.getElementById("chat-messages");
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ---- Workspace ----
async function loadWorkspace() {
  try {
    const pathRes = await api("GET", "/api/workspace/path");
    state.workspacePath = pathRes.workspace;
  } catch {
    /* ignore */
  }
  try {
    const filesRes = await api("GET", "/api/workspace/files");
    state.workspaceFiles = filesRes.files || [];
  } catch {
    /* ignore */
  }
  await loadTree("");
  render();
}

async function loadTree(subPath) {
  try {
    const res = await api("GET", "/api/workspace/tree?path=" + encodeURIComponent(subPath));
    state.workspaceTree = res.items || [];
    state.treePath = subPath;
  } catch {
    state.workspaceTree = [];
  }
  render();
}

async function openFile(filePath) {
  try {
    const res = await api("GET", "/api/workspace/read?path=" + encodeURIComponent(filePath));
    state.viewingFile = filePath;
    state.viewingFileContent = res.content || "";
    render();
  } catch (err) {
    addSystemMessage("无法读取文件: " + err.message);
    render();
  }
}

function closeFile() {
  state.viewingFile = null;
  state.viewingFileContent = "";
  render();
}

// ---- Rendering ----
function render() {
  if (state.page === "loading") {
    app.innerHTML =
      '<div class="auth-container"><div class="auth-card"><h1>加载中...</h1></div></div>';
  } else if (state.page === "login") {
    renderLogin();
  } else if (state.page === "register") {
    renderRegister();
  } else if (state.page === "main") {
    renderMain();
  }
}

function renderLogin() {
  app.innerHTML =
    '<div class="auth-container"><div class="auth-card">' +
    '<h1>OpenClaw Web</h1><p class="subtitle">登录到你的 AI Agent</p>' +
    '<div id="auth-error" class="auth-error" style="display:none"></div>' +
    '<form id="login-form">' +
    '<div class="form-group"><label>用户名</label><input type="text" id="login-username" required autocomplete="username" placeholder="请输入用户名"></div>' +
    '<div class="form-group"><label>密码</label><input type="password" id="login-password" required autocomplete="current-password" placeholder="请输入密码"></div>' +
    '<button type="submit" class="btn btn-primary">登录</button>' +
    "</form>" +
    '<p class="auth-link">还没有账号？<a id="goto-register">注册</a></p>' +
    "</div></div>";

  document.getElementById("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const errEl = document.getElementById("auth-error");
    errEl.style.display = "none";
    try {
      await doLogin(
        document.getElementById("login-username").value,
        document.getElementById("login-password").value,
      );
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    }
  });
  document.getElementById("goto-register").addEventListener("click", function () {
    state.page = "register";
    render();
  });
}

function renderRegister() {
  app.innerHTML =
    '<div class="auth-container"><div class="auth-card">' +
    '<h1>创建账号</h1><p class="subtitle">注册后将自动创建你的专属 AI Agent</p>' +
    '<div id="auth-error" class="auth-error" style="display:none"></div>' +
    '<form id="register-form">' +
    '<div class="form-group"><label>用户名</label><input type="text" id="reg-username" required autocomplete="username" placeholder="2-32 个字符"></div>' +
    '<div class="form-group"><label>显示名称</label><input type="text" id="reg-displayname" placeholder="可选，默认为用户名"></div>' +
    '<div class="form-group"><label>密码</label><input type="password" id="reg-password" required autocomplete="new-password" placeholder="至少 4 个字符"></div>' +
    '<button type="submit" class="btn btn-primary">注册</button>' +
    "</form>" +
    '<p class="auth-link">已有账号？<a id="goto-login">登录</a></p>' +
    "</div></div>";

  document.getElementById("register-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const errEl = document.getElementById("auth-error");
    errEl.style.display = "none";
    try {
      await doRegister(
        document.getElementById("reg-username").value,
        document.getElementById("reg-password").value,
        document.getElementById("reg-displayname").value,
      );
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = "block";
    }
  });
  document.getElementById("goto-login").addEventListener("click", function () {
    state.page = "login";
    render();
  });
}

function renderMain() {
  const messagesHtml = state.messages
    .map(function (m) {
      if (m.role === "system")
        return '<div class="message message-system">' + escapeHtml(m.content) + "</div>";
      if (m.role === "user")
        return '<div class="message message-user">' + escapeHtml(m.content) + "</div>";
      return '<div class="message message-assistant">' + escapeHtml(m.content) + "</div>";
    })
    .join("");

  const streamingHtml = state.streaming
    ? '<div class="message message-assistant">' +
      escapeHtml(state.streaming) +
      '<span style="opacity:0.5">\u2588</span></div>'
    : "";

  const typingHtml =
    state.sending && !state.streaming
      ? '<div class="typing-indicator"><div class="typing-dots"><span></span><span></span><span></span></div> 思考中...</div>'
      : "";

  const statusClass = state.connected ? "connected" : "disconnected";
  let statusText = "未连接";
  if (state.connected) statusText = "已连接";
  else if (state.gatewayStatus === "unavailable") statusText = "Gateway 未启动";
  else if (state.gatewayStatus === "disconnected") statusText = "连接中...";
  const sidebarContent =
    state.sidebarTab === "workspace" ? renderWorkspaceSidebar() : renderAgentInfo();

  let rightPanel = "";
  if (state.viewingFile) {
    rightPanel =
      '<div class="file-viewer">' +
      '<div class="file-viewer-header"><span>' +
      escapeHtml(state.viewingFile) +
      "</span>" +
      '<button class="btn btn-ghost" id="close-file" style="padding:0.25rem 0.5rem;font-size:0.75rem">关闭</button></div>' +
      '<div class="file-viewer-content">' +
      escapeHtml(state.viewingFileContent) +
      "</div></div>";
  }

  const emptyHtml =
    state.messages.length === 0 && !state.streaming
      ? '<div class="empty-state"><div class="icon">\uD83D\uDCAC</div><div>发送一条消息开始对话</div></div>'
      : "";

  app.innerHTML =
    '<div class="main-layout">' +
    '<div class="sidebar">' +
    '<div class="sidebar-header"><h2>OpenClaw</h2>' +
    '<button class="btn btn-ghost" id="btn-logout" style="padding:0.25rem 0.5rem;font-size:0.75rem">退出</button></div>' +
    '<div class="sidebar-tabs">' +
    '<button class="sidebar-tab ' +
    (state.sidebarTab === "workspace" ? "active" : "") +
    '" data-tab="workspace">工作区</button>' +
    '<button class="sidebar-tab ' +
    (state.sidebarTab === "agent" ? "active" : "") +
    '" data-tab="agent">Agent</button></div>' +
    '<div class="sidebar-content">' +
    sidebarContent +
    "</div>" +
    '<div class="sidebar-footer"><span>' +
    escapeHtml(state.user ? state.user.displayName : "") +
    "</span>" +
    '<button class="btn btn-danger" id="btn-delete-account" style="padding:0.125rem 0.375rem;font-size:0.6875rem">注销账号</button></div></div>' +
    '<div class="chat-area">' +
    '<div class="chat-header"><div class="chat-header-left"><h3>Chat</h3>' +
    '<span class="connection-status ' +
    statusClass +
    '">' +
    statusText +
    "</span></div>" +
    '<span style="font-size:0.75rem;color:var(--text-muted)">Agent: ' +
    escapeHtml(state.agentId || "") +
    "</span></div>" +
    '<div class="chat-messages" id="chat-messages">' +
    emptyHtml +
    messagesHtml +
    streamingHtml +
    typingHtml +
    "</div>" +
    '<div class="chat-input-area"><div class="chat-input-wrapper">' +
    '<textarea class="chat-input" id="chat-input" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1"></textarea>' +
    '<button class="send-btn" id="send-btn"' +
    (state.sending ? " disabled" : "") +
    ">发送</button>" +
    "</div></div></div>" +
    rightPanel +
    "</div>";

  // Bind events
  document.getElementById("btn-logout").addEventListener("click", doLogout);
  document.getElementById("btn-delete-account").addEventListener("click", doDeleteAccount);

  const input = document.getElementById("chat-input");
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input.value);
      input.value = "";
      autoResize(input);
    }
  });
  input.addEventListener("input", function () {
    autoResize(input);
  });

  document.getElementById("send-btn").addEventListener("click", function () {
    void sendMessage(input.value);
    input.value = "";
    autoResize(input);
  });

  document.querySelectorAll(".sidebar-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      state.sidebarTab = tab.dataset.tab;
      render();
    });
  });

  document.querySelectorAll("[data-file]").forEach(function (el) {
    el.addEventListener("click", function () {
      void openFile(el.dataset.file);
    });
  });

  document.querySelectorAll("[data-dir]").forEach(function (el) {
    el.addEventListener("click", function () {
      void loadTree(el.dataset.dir);
    });
  });

  const closeBtn = document.getElementById("close-file");
  if (closeBtn) closeBtn.addEventListener("click", closeFile);

  const backBtn = document.getElementById("btn-tree-back");
  if (backBtn) {
    backBtn.addEventListener("click", function () {
      const parent = state.treePath.split("/").slice(0, -1).join("/");
      void loadTree(parent);
    });
  }

  scrollToBottom();
  input.focus();
}

function renderWorkspaceSidebar() {
  let html = "";
  if (state.workspacePath) {
    html +=
      '<div class="workspace-path">\uD83D\uDCC1 ' + escapeHtml(state.workspacePath) + "</div>";
  }
  if (state.treePath) {
    html +=
      '<div class="file-tree-item" id="btn-tree-back"><span class="icon">\u2B05\uFE0F</span><span class="name">..</span></div>';
  }
  for (let i = 0; i < state.workspaceTree.length; i++) {
    const item = state.workspaceTree[i];
    if (item.isDirectory) {
      const dirPath = state.treePath ? state.treePath + "/" + item.name : item.name;
      html +=
        '<div class="file-tree-item" data-dir="' +
        escapeHtml(dirPath) +
        '"><span class="icon">\uD83D\uDCC1</span><span class="name">' +
        escapeHtml(item.name) +
        "</span></div>";
    } else {
      const filePath = state.treePath ? state.treePath + "/" + item.name : item.name;
      const size = item.size != null ? formatBytes(item.size) : "";
      const active = state.viewingFile === filePath ? " active" : "";
      html +=
        '<div class="file-tree-item' +
        active +
        '" data-file="' +
        escapeHtml(filePath) +
        '"><span class="icon">\uD83D\uDCC4</span><span class="name">' +
        escapeHtml(item.name) +
        '</span><span class="size">' +
        size +
        "</span></div>";
    }
  }
  if (state.workspaceTree.length === 0 && !state.treePath) {
    html +=
      '<div style="padding:1rem;text-align:center;color:var(--text-muted);font-size:0.8125rem">工作区为空</div>';
  }
  if (state.workspaceFiles.length > 0) {
    html +=
      '<div style="padding:0.5rem;margin-top:0.5rem;font-size:0.75rem;color:var(--text-muted);border-top:1px solid var(--border)">Agent 文件</div>';
    for (let i = 0; i < state.workspaceFiles.length; i++) {
      const f = state.workspaceFiles[i];
      const icon = f.missing ? "\u2B1C" : "\uD83D\uDCDD";
      const sizeText = f.missing ? "未创建" : formatBytes(f.size || 0);
      html +=
        '<div class="file-tree-item" data-file="' +
        escapeHtml(f.name) +
        '"><span class="icon">' +
        icon +
        '</span><span class="name">' +
        escapeHtml(f.name) +
        '</span><span class="size">' +
        sizeText +
        "</span></div>";
    }
  }
  return html;
}

function renderAgentInfo() {
  if (!state.user) return "";
  return (
    '<div style="padding:1rem">' +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">Agent ID</div>' +
    '<div style="font-family:var(--font-mono);font-size:0.875rem">' +
    escapeHtml(state.agentId || "") +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">用户名</div>' +
    '<div style="font-size:0.875rem">' +
    escapeHtml(state.user.username) +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">显示名称</div>' +
    '<div style="font-size:0.875rem">' +
    escapeHtml(state.user.displayName) +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">Session Key</div>' +
    '<div style="font-family:var(--font-mono);font-size:0.75rem;word-break:break-all">' +
    escapeHtml(state.sessionKey || "未连接") +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">连接状态</div>' +
    '<div style="font-size:0.875rem">' +
    (state.connected ? "\u2705 已连接" : "\u274C 未连接") +
    "</div></div></div>"
  );
}

// ---- Utilities ----
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function autoResize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

// ---- Init ----
void checkAuth();
