/* eslint-disable */
// @ts-nocheck
// OpenClaw Web App - Frontend

const app = document.getElementById("app");

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
  workspaceTree: [],
  treePath: "",
  viewingFile: null,
  viewingFileContent: "",
  editingFile: false,
  editContent: "",
};

// ---- API ----
async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const opts = { method, headers };
  if (body && method !== "GET" && method !== "DELETE") opts.body = JSON.stringify(body);
  if (method === "DELETE" && body) opts.body = JSON.stringify(body);
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
    scheduleWsRetry();
    return;
  }
  state.ws = ws;

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
      if (
        !state.gatewayStatusShown &&
        (msg.status === "unavailable" ||
          msg.status === "disconnected" ||
          msg.status === "auth_failed")
      ) {
        state.gatewayStatusShown = true;
        addSystemMessage(msg.message || "Gateway 未连接");
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
}

function scheduleWsRetry() {
  if (!state.token || state.page !== "main" || wsRetryCount >= 10) return;
  wsRetryTimer = setTimeout(connectWs, Math.min(3000 * Math.pow(1.5, wsRetryCount++), 30000));
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
  const e = pendingReqs.get(msg.id);
  if (!e) return;
  pendingReqs.delete(msg.id);
  clearTimeout(e.timer);
  if (msg.ok) e.resolve(msg.payload);
  else e.reject(new Error(msg.error && msg.error.message ? msg.error.message : "请求失败"));
}

function handleEvent(msg) {
  const p = msg.payload || {};
  if (msg.event === "chat.event" || msg.event === "chat") {
    if (p.state === "delta") {
      if (state.streamRunId !== p.runId) {
        state.streamRunId = p.runId;
        state.streaming = "";
      }
      const t = extractText(p.message);
      if (t) state.streaming += t;
      render();
    } else if (p.state === "final") {
      const text = state.streaming || extractText(p.message);
      if (text) state.messages.push({ role: "assistant", content: text, ts: Date.now() });
      state.streaming = "";
      state.streamRunId = null;
      state.sending = false;
      render();
      scrollToBottom();
    } else if (p.state === "error" || p.state === "aborted") {
      if (p.errorMessage) addSystemMessage("错误: " + p.errorMessage);
      state.streaming = "";
      state.streamRunId = null;
      state.sending = false;
      render();
    }
  }
}

function extractText(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  if (m.content) {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content))
      return m.content
        .filter(function (b) {
          return b.type === "text";
        })
        .map(function (b) {
          return b.text || "";
        })
        .join("");
  }
  return m.text || "";
}

// ---- Chat ----
async function loadHistory() {
  try {
    const res = await wsRequest("chat.history", { limit: 200 });
    if (res && Array.isArray(res.messages)) {
      state.messages = res.messages
        .map(function (m) {
          return { role: m.role || "unknown", content: extractText(m), ts: m.ts || 0 };
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
    await wsRequest("chat.send", {
      message: text.trim(),
      idempotencyKey: "web-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      timeoutMs: 120000,
    });
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
    var el = document.getElementById("chat-messages");
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ---- Workspace ----
async function loadWorkspace() {
  try {
    state.workspacePath = (await api("GET", "/api/workspace/path")).workspace;
  } catch {}
  await loadTree("");
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
    state.editingFile = false;
    state.editContent = "";
    render();
  } catch (err) {
    alert("无法读取文件: " + err.message);
  }
}

function closeFile() {
  state.viewingFile = null;
  state.viewingFileContent = "";
  state.editingFile = false;
  render();
}

function startEdit() {
  state.editingFile = true;
  state.editContent = state.viewingFileContent;
  render();
  var ta = document.getElementById("file-editor");
  if (ta) ta.focus();
}

async function saveFile() {
  if (!state.viewingFile) return;
  try {
    await api("POST", "/api/workspace/write", {
      path: state.viewingFile,
      content: state.editContent,
    });
    state.viewingFileContent = state.editContent;
    state.editingFile = false;
    render();
    void loadTree(state.treePath);
  } catch (err) {
    alert("保存失败: " + err.message);
  }
}

function cancelEdit() {
  state.editingFile = false;
  render();
}

async function createNewFile() {
  var name = prompt("输入文件名（可含路径，如 docs/note.md）:");
  if (!name) return;
  var fullPath = state.treePath ? state.treePath + "/" + name : name;
  try {
    await api("POST", "/api/workspace/write", { path: fullPath, content: "" });
    void loadTree(state.treePath);
    void openFile(fullPath);
  } catch (err) {
    alert("创建失败: " + err.message);
  }
}

async function createNewFolder() {
  var name = prompt("输入文件夹名:");
  if (!name) return;
  var fullPath = state.treePath ? state.treePath + "/" + name : name;
  try {
    await api("POST", "/api/workspace/mkdir", { path: fullPath });
    void loadTree(state.treePath);
  } catch (err) {
    alert("创建失败: " + err.message);
  }
}

async function deleteItem(itemPath) {
  var fullPath = state.treePath ? state.treePath + "/" + itemPath : itemPath;
  if (!confirm("确定删除 " + fullPath + " ？")) return;
  try {
    await api("DELETE", "/api/workspace/delete?path=" + encodeURIComponent(fullPath));
    if (state.viewingFile === fullPath) closeFile();
    void loadTree(state.treePath);
  } catch (err) {
    alert("删除失败: " + err.message);
  }
}

async function renameItem(itemPath) {
  var fullPath = state.treePath ? state.treePath + "/" + itemPath : itemPath;
  var newName = prompt("新名称:", itemPath);
  if (!newName || newName === itemPath) return;
  var newFullPath = state.treePath ? state.treePath + "/" + newName : newName;
  try {
    await api("POST", "/api/workspace/rename", { oldPath: fullPath, newPath: newFullPath });
    if (state.viewingFile === fullPath) {
      state.viewingFile = newFullPath;
    }
    void loadTree(state.treePath);
  } catch (err) {
    alert("重命名失败: " + err.message);
  }
}

async function uploadFiles() {
  var input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", async function () {
    if (!input.files || input.files.length === 0) return;
    var formData = new FormData();
    formData.append("targetDir", state.treePath || "");
    for (var i = 0; i < input.files.length; i++) {
      formData.append("files", input.files[i], input.files[i].name);
    }
    try {
      var res = await fetch("/api/workspace/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + state.token },
        body: formData,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      void loadTree(state.treePath);
    } catch (err) {
      alert("上传失败: " + err.message);
    }
  });
  input.click();
}

async function uploadFolder() {
  var input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.setAttribute("webkitdirectory", "");
  input.addEventListener("change", async function () {
    if (!input.files || input.files.length === 0) return;
    var formData = new FormData();
    formData.append("targetDir", state.treePath || "");
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      var relPath = f.webkitRelativePath || f.name;
      formData.append("files", f, relPath);
    }
    try {
      var res = await fetch("/api/workspace/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + state.token },
        body: formData,
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      void loadTree(state.treePath);
    } catch (err) {
      alert("上传失败: " + err.message);
    }
  });
  input.click();
}

// ---- Render ----
function render() {
  if (state.page === "loading") {
    app.innerHTML =
      '<div class="auth-container"><div class="auth-card"><h1>加载中...</h1></div></div>';
    return;
  }
  if (state.page === "login") {
    renderLogin();
    return;
  }
  if (state.page === "register") {
    renderRegister();
    return;
  }
  if (state.page === "main") {
    renderMain();
    return;
  }
}

function renderLogin() {
  app.innerHTML =
    '<div class="auth-container"><div class="auth-card"><h1>OpenClaw Web</h1><p class="subtitle">登录到你的 AI Agent</p><div id="auth-error" class="auth-error" style="display:none"></div><form id="login-form"><div class="form-group"><label>用户名</label><input type="text" id="login-username" required autocomplete="username" placeholder="请输入用户名"></div><div class="form-group"><label>密码</label><input type="password" id="login-password" required autocomplete="current-password" placeholder="请输入密码"></div><button type="submit" class="btn btn-primary">登录</button></form><p class="auth-link">还没有账号？<a id="goto-register">注册</a></p></div></div>';
  document.getElementById("login-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = document.getElementById("auth-error");
    err.style.display = "none";
    try {
      await doLogin(
        document.getElementById("login-username").value,
        document.getElementById("login-password").value,
      );
    } catch (ex) {
      err.textContent = ex.message;
      err.style.display = "block";
    }
  });
  document.getElementById("goto-register").addEventListener("click", function () {
    state.page = "register";
    render();
  });
}

function renderRegister() {
  app.innerHTML =
    '<div class="auth-container"><div class="auth-card"><h1>创建账号</h1><p class="subtitle">注册后将自动创建你的专属 AI Agent</p><div id="auth-error" class="auth-error" style="display:none"></div><form id="register-form"><div class="form-group"><label>用户名</label><input type="text" id="reg-username" required autocomplete="username" placeholder="2-32 个字符"></div><div class="form-group"><label>显示名称</label><input type="text" id="reg-displayname" placeholder="可选"></div><div class="form-group"><label>密码</label><input type="password" id="reg-password" required autocomplete="new-password" placeholder="至少 4 个字符"></div><button type="submit" class="btn btn-primary">注册</button></form><p class="auth-link">已有账号？<a id="goto-login">登录</a></p></div></div>';
  document.getElementById("register-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var err = document.getElementById("auth-error");
    err.style.display = "none";
    try {
      await doRegister(
        document.getElementById("reg-username").value,
        document.getElementById("reg-password").value,
        document.getElementById("reg-displayname").value,
      );
    } catch (ex) {
      err.textContent = ex.message;
      err.style.display = "block";
    }
  });
  document.getElementById("goto-login").addEventListener("click", function () {
    state.page = "login";
    render();
  });
}

function renderMain() {
  var statusClass = state.connected ? "connected" : "disconnected";
  var statusText = state.connected
    ? "已连接"
    : state.gatewayStatus === "unavailable"
      ? "Gateway 未启动"
      : "连接中...";

  var msgsHtml = state.messages
    .map(function (m) {
      if (m.role === "system")
        return '<div class="message message-system">' + esc(m.content) + "</div>";
      if (m.role === "user")
        return '<div class="message message-user">' + esc(m.content) + "</div>";
      return '<div class="message message-assistant">' + esc(m.content) + "</div>";
    })
    .join("");

  var streamHtml = state.streaming
    ? '<div class="message message-assistant">' +
      esc(state.streaming) +
      '<span style="opacity:0.5">\u2588</span></div>'
    : "";
  var typingHtml =
    state.sending && !state.streaming
      ? '<div class="typing-indicator"><div class="typing-dots"><span></span><span></span><span></span></div> 思考中...</div>'
      : "";
  var emptyChat =
    !state.messages.length && !state.streaming
      ? '<div class="empty-state"><div class="icon">\uD83D\uDCAC</div><div>发送一条消息开始对话</div></div>'
      : "";

  var rightPanel = "";
  if (state.viewingFile) {
    if (state.editingFile) {
      rightPanel =
        '<div class="file-viewer"><div class="file-viewer-header"><span>' +
        esc(state.viewingFile) +
        '</span><div><button class="btn btn-primary" id="btn-save" style="padding:0.25rem 0.75rem;font-size:0.75rem;margin-right:0.25rem">保存</button><button class="btn btn-ghost" id="btn-cancel-edit" style="padding:0.25rem 0.5rem;font-size:0.75rem">取消</button></div></div><textarea id="file-editor" class="file-editor">' +
        esc(state.editContent) +
        "</textarea></div>";
    } else {
      rightPanel =
        '<div class="file-viewer"><div class="file-viewer-header"><span>' +
        esc(state.viewingFile) +
        '</span><div><button class="btn btn-ghost" id="btn-edit" style="padding:0.25rem 0.5rem;font-size:0.75rem;margin-right:0.25rem">编辑</button><button class="btn btn-ghost" id="btn-close-file" style="padding:0.25rem 0.5rem;font-size:0.75rem">关闭</button></div></div><div class="file-viewer-content">' +
        esc(state.viewingFileContent) +
        "</div></div>";
    }
  }

  app.innerHTML =
    '<div class="main-layout">' +
    '<div class="sidebar">' +
    '<div class="sidebar-header"><h2>OpenClaw</h2><button class="btn btn-ghost" id="btn-logout" style="padding:0.25rem 0.5rem;font-size:0.75rem">退出</button></div>' +
    '<div class="sidebar-tabs"><button class="sidebar-tab ' +
    (state.sidebarTab === "workspace" ? "active" : "") +
    '" data-tab="workspace">工作区</button><button class="sidebar-tab ' +
    (state.sidebarTab === "agent" ? "active" : "") +
    '" data-tab="agent">Agent</button></div>' +
    '<div class="sidebar-content">' +
    (state.sidebarTab === "workspace" ? renderWorkspaceSidebar() : renderAgentInfo()) +
    "</div>" +
    '<div class="sidebar-footer"><span>' +
    esc(state.user ? state.user.displayName : "") +
    '</span><button class="btn btn-danger" id="btn-delete-account" style="padding:0.125rem 0.375rem;font-size:0.6875rem">注销账号</button></div>' +
    "</div>" +
    '<div class="chat-area">' +
    '<div class="chat-header"><div class="chat-header-left"><h3>Chat</h3><span class="connection-status ' +
    statusClass +
    '">' +
    statusText +
    '</span></div><span style="font-size:0.75rem;color:var(--text-muted)">Agent: ' +
    esc(state.agentId || "") +
    "</span></div>" +
    '<div class="chat-messages" id="chat-messages">' +
    emptyChat +
    msgsHtml +
    streamHtml +
    typingHtml +
    "</div>" +
    '<div class="chat-input-area"><div class="chat-input-wrapper"><textarea class="chat-input" id="chat-input" placeholder="输入消息... (Enter 发送)" rows="1"></textarea><button class="send-btn" id="send-btn"' +
    (state.sending ? " disabled" : "") +
    ">发送</button></div></div>" +
    "</div>" +
    rightPanel +
    "</div>";

  // Bind events
  document.getElementById("btn-logout").addEventListener("click", doLogout);
  document.getElementById("btn-delete-account").addEventListener("click", doDeleteAccount);
  var input = document.getElementById("chat-input");
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
  document.querySelectorAll(".sidebar-tab").forEach(function (t) {
    t.addEventListener("click", function () {
      state.sidebarTab = t.dataset.tab;
      render();
    });
  });
  document.querySelectorAll("[data-open]").forEach(function (el) {
    el.addEventListener("click", function () {
      void openFile(el.dataset.open);
    });
  });
  document.querySelectorAll("[data-dir]").forEach(function (el) {
    el.addEventListener("click", function () {
      void loadTree(el.dataset.dir);
    });
  });
  document.querySelectorAll("[data-delete]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      void deleteItem(el.dataset.delete);
    });
  });
  document.querySelectorAll("[data-rename]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      void renameItem(el.dataset.rename);
    });
  });

  var closeBtn = document.getElementById("btn-close-file");
  if (closeBtn) closeBtn.addEventListener("click", closeFile);
  var editBtn = document.getElementById("btn-edit");
  if (editBtn) editBtn.addEventListener("click", startEdit);
  var saveBtn = document.getElementById("btn-save");
  if (saveBtn)
    saveBtn.addEventListener("click", function () {
      void saveFile();
    });
  var cancelBtn = document.getElementById("btn-cancel-edit");
  if (cancelBtn) cancelBtn.addEventListener("click", cancelEdit);
  var editor = document.getElementById("file-editor");
  if (editor)
    editor.addEventListener("input", function () {
      state.editContent = editor.value;
    });
  var treeBack = document.getElementById("btn-tree-back");
  if (treeBack)
    treeBack.addEventListener("click", function () {
      void loadTree(state.treePath.split("/").slice(0, -1).join("/"));
    });
  var btnNewFile = document.getElementById("btn-new-file");
  if (btnNewFile)
    btnNewFile.addEventListener("click", function () {
      void createNewFile();
    });
  var btnNewFolder = document.getElementById("btn-new-folder");
  if (btnNewFolder)
    btnNewFolder.addEventListener("click", function () {
      void createNewFolder();
    });
  var btnUpload = document.getElementById("btn-upload");
  if (btnUpload)
    btnUpload.addEventListener("click", function () {
      void uploadFiles();
    });
  var btnUploadDir = document.getElementById("btn-upload-dir");
  if (btnUploadDir)
    btnUploadDir.addEventListener("click", function () {
      void uploadFolder();
    });

  scrollToBottom();
  input.focus();
}

function renderWorkspaceSidebar() {
  var h = "";
  if (state.workspacePath)
    h += '<div class="workspace-path">\uD83D\uDCC1 ' + esc(state.workspacePath) + "</div>";

  // Toolbar
  h += '<div class="ws-toolbar">';
  h += '<button class="ws-btn" id="btn-new-file" title="新建文件">\uD83D\uDCC4+</button>';
  h += '<button class="ws-btn" id="btn-new-folder" title="新建文件夹">\uD83D\uDCC1+</button>';
  h += '<button class="ws-btn" id="btn-upload" title="上传文件">\u2B06\uFE0F</button>';
  h += '<button class="ws-btn" id="btn-upload-dir" title="上传文件夹">\uD83D\uDCC2\u2B06</button>';
  h += "</div>";

  if (state.treePath) {
    h +=
      '<div class="file-tree-item" id="btn-tree-back"><span class="icon">\u2B05\uFE0F</span><span class="name">..</span></div>';
  }

  for (var i = 0; i < state.workspaceTree.length; i++) {
    var item = state.workspaceTree[i];
    var relPath = state.treePath ? state.treePath + "/" + item.name : item.name;
    if (item.isDirectory) {
      h += '<div class="file-tree-item" data-dir="' + esc(relPath) + '">';
      h += '<span class="icon">\uD83D\uDCC1</span><span class="name">' + esc(item.name) + "</span>";
      h +=
        '<span class="item-actions"><button class="act-btn" data-rename="' +
        esc(item.name) +
        '" title="重命名">\u270F</button><button class="act-btn act-del" data-delete="' +
        esc(item.name) +
        '" title="删除">\u2716</button></span>';
      h += "</div>";
    } else {
      var size = item.size != null ? formatBytes(item.size) : "";
      var active = state.viewingFile === relPath ? " active" : "";
      h += '<div class="file-tree-item' + active + '" data-open="' + esc(relPath) + '">';
      h +=
        '<span class="icon">\uD83D\uDCC4</span><span class="name">' +
        esc(item.name) +
        '</span><span class="size">' +
        size +
        "</span>";
      h +=
        '<span class="item-actions"><button class="act-btn" data-rename="' +
        esc(item.name) +
        '" title="重命名">\u270F</button><button class="act-btn act-del" data-delete="' +
        esc(item.name) +
        '" title="删除">\u2716</button></span>';
      h += "</div>";
    }
  }
  if (!state.workspaceTree.length && !state.treePath) {
    h +=
      '<div style="padding:1rem;text-align:center;color:var(--text-muted);font-size:0.8125rem">工作区为空，点击上方按钮创建或上传文件</div>';
  }
  return h;
}

function renderAgentInfo() {
  if (!state.user) return "";
  return (
    '<div style="padding:1rem">' +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">Agent ID</div><div style="font-family:var(--font-mono);font-size:0.875rem">' +
    esc(state.agentId || "") +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">用户名</div><div style="font-size:0.875rem">' +
    esc(state.user.username) +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">显示名称</div><div style="font-size:0.875rem">' +
    esc(state.user.displayName) +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">Session Key</div><div style="font-family:var(--font-mono);font-size:0.75rem;word-break:break-all">' +
    esc(state.sessionKey || "未连接") +
    "</div></div>" +
    '<div style="margin-bottom:1rem"><div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:0.25rem">连接状态</div><div style="font-size:0.875rem">' +
    (state.connected ? "\u2705 已连接" : "\u274C 未连接") +
    "</div></div></div>"
  );
}

function esc(str) {
  var d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function autoResize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}

void checkAuth();
