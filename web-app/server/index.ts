import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createAgent, deleteAgent } from "./gateway-admin.js";
import { createToken, verifyToken, type TokenPayload } from "./jwt.js";
import { createUser, authenticateUser, deleteUser, findUserById } from "./user-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, "..", "client");
const PORT = parseInt(process.env.WEB_APP_PORT || "3000", 10);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";

const WORKSPACE_BASE = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
})();

function readGatewayTokenFromConfig(): string {
  try {
    const configPath = path.join(WORKSPACE_BASE, "openclaw.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    return cfg.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

// Auto-detect: env var first, then read from openclaw.json
function resolveGatewayToken(): string {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }
  const configToken = readGatewayTokenFromConfig();
  if (configToken) {
    console.log("Auto-detected gateway token from ~/.openclaw/openclaw.json");
  }
  return configToken;
}

const GATEWAY_TOKEN = resolveGatewayToken();

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

function extractToken(req: http.IncomingMessage): TokenPayload | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return null;
  }
  return verifyToken(auth.slice(7));
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function resolveAgentWorkspace(agentId: string): string {
  return path.join(WORKSPACE_BASE, `workspace-${agentId}`);
}

type UploadedFile = { path: string; size: number };

async function handleMultipartUpload(
  req: http.IncomingMessage,
  workspace: string,
): Promise<UploadedFile[]> {
  const boundary = extractBoundary(req.headers["content-type"] || "");
  if (!boundary) {
    throw new Error("missing boundary");
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_SIZE = 50 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_SIZE) {
        reject(new Error("上传文件总大小超过 50MB 限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const files = parseMultipartBody(body, boundary, workspace);
        resolve(files);
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function extractBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/.exec(contentType);
  return match ? match[1] || match[2] || null : null;
}

function parseMultipartBody(body: Buffer, boundary: string, workspace: string): UploadedFile[] {
  const sep = Buffer.from(`--${boundary}`);
  const files: UploadedFile[] = [];
  let start = 0;

  while (true) {
    const partStart = indexOf(body, sep, start);
    if (partStart < 0) {
      break;
    }
    const afterSep = partStart + sep.length;
    if (body[afterSep] === 0x2d && body[afterSep + 1] === 0x2d) {
      break;
    }
    const nextPartStart = indexOf(body, sep, afterSep);
    if (nextPartStart < 0) {
      break;
    }

    const partBody = body.subarray(afterSep, nextPartStart);
    const headerEnd = indexOf(partBody, Buffer.from("\r\n\r\n"), 0);
    if (headerEnd < 0) {
      start = nextPartStart;
      continue;
    }

    const headerStr = partBody.subarray(0, headerEnd).toString("utf-8");
    const fileContent = partBody.subarray(headerEnd + 4, partBody.length - 2);

    const nameMatch = /name="([^"]*)"/.exec(headerStr);
    const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
    const fieldName = nameMatch?.[1] || "";
    const filename = filenameMatch?.[1] || "";

    if (fieldName === "targetDir") {
      start = nextPartStart;
      continue;
    }

    if (filename) {
      // webkitRelativePath is sent in a separate field, but browsers also encode it in filename
      const safePath = filename.replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\//, "");
      if (!safePath) {
        start = nextPartStart;
        continue;
      }

      const targetDirField = extractFieldValue(body, boundary, "targetDir") || "";
      const relDir = targetDirField.replace(/\\/g, "/").replace(/\.\./g, "").replace(/^\//, "");
      const fullRelPath = relDir ? path.join(relDir, safePath) : safePath;
      const targetPath = path.resolve(workspace, fullRelPath);

      if (!targetPath.startsWith(path.resolve(workspace))) {
        start = nextPartStart;
        continue;
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, fileContent);
      files.push({ path: fullRelPath, size: fileContent.length });
    }

    start = nextPartStart;
  }

  return files;
}

function extractFieldValue(body: Buffer, boundary: string, fieldName: string): string | null {
  const pattern = Buffer.from(`name="${fieldName}"`);
  const idx = indexOf(body, pattern, 0);
  if (idx < 0) {
    return null;
  }
  const headerEnd = indexOf(body, Buffer.from("\r\n\r\n"), idx);
  if (headerEnd < 0) {
    return null;
  }
  const sep = Buffer.from(`--${boundary}`);
  const nextSep = indexOf(body, sep, headerEnd);
  if (nextSep < 0) {
    return null;
  }
  return body
    .subarray(headerEnd + 4, nextSep - 2)
    .toString("utf-8")
    .trim();
}

function indexOf(buf: Buffer, search: Buffer, fromIndex: number): number {
  for (let i = fromIndex; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      return i;
    }
  }
  return -1;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    json(res, 204, null);
    return;
  }

  // --- Auth endpoints ---
  if (url.pathname === "/api/auth/register" && method === "POST") {
    const body = await parseBody(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : username;

    if (!username || username.length < 2 || username.length > 32) {
      json(res, 400, { error: "用户名长度需要 2-32 个字符" });
      return;
    }
    if (!password || password.length < 4) {
      json(res, 400, { error: "密码至少需要 4 个字符" });
      return;
    }

    const user = createUser(username, password, displayName);
    if (!user) {
      json(res, 409, { error: "用户名已存在" });
      return;
    }

    const workspace = resolveAgentWorkspace(user.agentId);
    try {
      await createAgent(user.agentId, displayName, workspace);
    } catch {
      // Gateway may not be running; create workspace directory manually as fallback
      try {
        fs.mkdirSync(workspace, { recursive: true });
      } catch {
        // Best effort
      }
    }

    const token = createToken({ sub: user.id, username: user.username, agentId: user.agentId });
    json(res, 201, {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        agentId: user.agentId,
      },
    });
    return;
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const body = await parseBody(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const user = authenticateUser(username, password);
    if (!user) {
      json(res, 401, { error: "用户名或密码错误" });
      return;
    }

    const token = createToken({ sub: user.id, username: user.username, agentId: user.agentId });
    json(res, 200, {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        agentId: user.agentId,
      },
    });
    return;
  }

  if (url.pathname === "/api/auth/me" && method === "GET") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const user = findUserById(payload.sub);
    if (!user) {
      json(res, 401, { error: "用户不存在" });
      return;
    }
    json(res, 200, {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        agentId: user.agentId,
      },
    });
    return;
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    // JWT is stateless; client discards the token
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/auth/delete" && method === "DELETE") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    try {
      await deleteAgent(payload.agentId);
    } catch {
      // Agent may already be gone
    }
    deleteUser(payload.username);
    json(res, 200, { ok: true });
    return;
  }

  // --- Workspace helpers ---
  function resolveWorkspaceTarget(
    payload: TokenPayload,
    subPath: string,
  ): { workspace: string; target: string } | null {
    const workspace = resolveAgentWorkspace(payload.agentId);
    const target = path.resolve(workspace, subPath);
    if (!target.startsWith(path.resolve(workspace))) {
      return null;
    }
    return { workspace, target };
  }

  // GET /api/workspace/path — workspace root path
  if (url.pathname === "/api/workspace/path" && method === "GET") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const workspace = resolveAgentWorkspace(payload.agentId);
    json(res, 200, { workspace, agentId: payload.agentId });
    return;
  }

  // GET /api/workspace/tree — list directory contents
  if (url.pathname === "/api/workspace/tree" && method === "GET") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const subPath = url.searchParams.get("path") || "";
    const resolved = resolveWorkspaceTarget(payload, subPath);
    if (!resolved) {
      json(res, 403, { error: "路径不合法" });
      return;
    }

    try {
      const entries = fs.readdirSync(resolved.target, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => {
          const fullPath = path.join(resolved.target, e.name);
          const isDir = e.isDirectory();
          const stat = isDir ? undefined : fs.statSync(fullPath);
          return {
            name: e.name,
            isDirectory: isDir,
            size: stat?.size,
            modifiedAt: stat ? Math.floor(stat.mtimeMs) : undefined,
          };
        })
        .toSorted((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
      json(res, 200, { path: subPath || "/", items });
    } catch {
      json(res, 200, { path: subPath || "/", items: [] });
    }
    return;
  }

  // GET /api/workspace/read — read file content
  if (url.pathname === "/api/workspace/read" && method === "GET") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const filePath = url.searchParams.get("path") || "";
    if (!filePath) {
      json(res, 400, { error: "缺少 path 参数" });
      return;
    }
    const resolved = resolveWorkspaceTarget(payload, filePath);
    if (!resolved) {
      json(res, 403, { error: "路径不合法" });
      return;
    }

    try {
      const stat = fs.statSync(resolved.target);
      if (!stat.isFile()) {
        json(res, 400, { error: "不是文件" });
        return;
      }
      if (stat.size > 2 * 1024 * 1024) {
        json(res, 400, { error: "文件过大（>2MB）" });
        return;
      }
      const content = fs.readFileSync(resolved.target, "utf-8");
      json(res, 200, { path: filePath, content, size: stat.size });
    } catch {
      json(res, 404, { error: "文件不存在" });
    }
    return;
  }

  // POST /api/workspace/write — create or update file
  if (url.pathname === "/api/workspace/write" && method === "POST") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const body = await parseBody(req);
    const filePath = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!filePath) {
      json(res, 400, { error: "缺少 path 参数" });
      return;
    }
    const resolved = resolveWorkspaceTarget(payload, filePath);
    if (!resolved) {
      json(res, 403, { error: "路径不合法" });
      return;
    }

    try {
      fs.mkdirSync(path.dirname(resolved.target), { recursive: true });
      fs.writeFileSync(resolved.target, content, "utf-8");
      const stat = fs.statSync(resolved.target);
      json(res, 200, { ok: true, path: filePath, size: stat.size });
    } catch (err: unknown) {
      json(res, 500, { error: `写入失败: ${err instanceof Error ? err.message : "unknown"}` });
    }
    return;
  }

  // POST /api/workspace/mkdir — create directory
  if (url.pathname === "/api/workspace/mkdir" && method === "POST") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const body = await parseBody(req);
    const dirPath = typeof body.path === "string" ? body.path : "";
    if (!dirPath) {
      json(res, 400, { error: "缺少 path 参数" });
      return;
    }
    const resolved = resolveWorkspaceTarget(payload, dirPath);
    if (!resolved) {
      json(res, 403, { error: "路径不合法" });
      return;
    }

    try {
      fs.mkdirSync(resolved.target, { recursive: true });
      json(res, 200, { ok: true, path: dirPath });
    } catch (err: unknown) {
      json(res, 500, { error: `创建目录失败: ${err instanceof Error ? err.message : "unknown"}` });
    }
    return;
  }

  // POST /api/workspace/rename — rename file or directory
  if (url.pathname === "/api/workspace/rename" && method === "POST") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const body = await parseBody(req);
    const oldPath = typeof body.oldPath === "string" ? body.oldPath : "";
    const newPath = typeof body.newPath === "string" ? body.newPath : "";
    if (!oldPath || !newPath) {
      json(res, 400, { error: "缺少 oldPath 或 newPath" });
      return;
    }
    const resolvedOld = resolveWorkspaceTarget(payload, oldPath);
    const resolvedNew = resolveWorkspaceTarget(payload, newPath);
    if (!resolvedOld || !resolvedNew) {
      json(res, 403, { error: "路径不合法" });
      return;
    }

    try {
      fs.mkdirSync(path.dirname(resolvedNew.target), { recursive: true });
      fs.renameSync(resolvedOld.target, resolvedNew.target);
      json(res, 200, { ok: true, oldPath, newPath });
    } catch (err: unknown) {
      json(res, 500, { error: `重命名失败: ${err instanceof Error ? err.message : "unknown"}` });
    }
    return;
  }

  // DELETE /api/workspace/delete — delete file or directory
  if (url.pathname === "/api/workspace/delete" && method === "DELETE") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }
    const filePath = url.searchParams.get("path") || "";
    if (!filePath) {
      json(res, 400, { error: "缺少 path 参数" });
      return;
    }
    const resolved = resolveWorkspaceTarget(payload, filePath);
    if (!resolved) {
      json(res, 403, { error: "路径不合法" });
      return;
    }
    if (resolved.target === path.resolve(resolved.workspace)) {
      json(res, 403, { error: "不能删除工作区根目录" });
      return;
    }

    try {
      const stat = fs.statSync(resolved.target);
      if (stat.isDirectory()) {
        fs.rmSync(resolved.target, { recursive: true });
      } else {
        fs.unlinkSync(resolved.target);
      }
      json(res, 200, { ok: true, path: filePath });
    } catch (err: unknown) {
      json(res, 500, { error: `删除失败: ${err instanceof Error ? err.message : "unknown"}` });
    }
    return;
  }

  // POST /api/workspace/upload — upload file (multipart form-data)
  if (url.pathname === "/api/workspace/upload" && method === "POST") {
    const payload = extractToken(req);
    if (!payload) {
      json(res, 401, { error: "未登录" });
      return;
    }

    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      json(res, 400, { error: "需要 multipart/form-data" });
      return;
    }

    const workspace = resolveAgentWorkspace(payload.agentId);
    try {
      const result = await handleMultipartUpload(req, workspace);
      json(res, 200, { ok: true, files: result });
    } catch (err: unknown) {
      json(res, 500, { error: `上传失败: ${err instanceof Error ? err.message : "unknown"}` });
    }
    return;
  }

  // --- Static files (frontend) ---
  if (method === "GET") {
    let filePath = path.join(CLIENT_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIR, "index.html");
    }
    serveStatic(res, filePath);
    return;
  }

  json(res, 404, { error: "Not found" });
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    json(res, 500, { error: "Internal server error" });
  });
});

// --- WebSocket Proxy ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname !== "/ws/chat") {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  if (!token) {
    socket.destroy();
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    wss.emit("connection", clientWs, req, payload);
  });
});

function wsRawToString(raw: Buffer | ArrayBuffer | Buffer[]): string {
  return Buffer.isBuffer(raw)
    ? raw.toString("utf-8")
    : Buffer.from(raw as ArrayBuffer).toString("utf-8");
}

wss.on("connection", (clientWs: WebSocket, _req: http.IncomingMessage, payload: TokenPayload) => {
  const agentId = payload.agentId;
  const sessionKey = `agent:${agentId}:main`;
  let gatewayWs: WebSocket | null = null;
  let gatewayConnected = false;
  let clientClosed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCount = 0;
  const MAX_RETRIES = 5;
  const pendingFromClient: Array<{ data: string }> = [];

  function sendToClient(data: string): void {
    if (!clientClosed && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  }

  function connectToGateway(): void {
    if (clientClosed) {
      return;
    }

    let handshakeDone = false;
    gatewayConnected = false;

    let gw: WebSocket;
    try {
      gw = new WebSocket(GATEWAY_URL, {
        origin: GATEWAY_URL.replace("ws://", "http://").replace("wss://", "https://"),
      });
    } catch {
      sendToClient(JSON.stringify({ type: "gateway_status", status: "unavailable" }));
      scheduleRetry();
      return;
    }
    gatewayWs = gw;

    const handshakeTimeout = setTimeout(() => {
      if (!handshakeDone && gw.readyState !== WebSocket.CLOSED) {
        gw.close();
      }
    }, 10_000);

    gw.on("open", () => {
      // Waiting for connect.challenge event from gateway
    });

    gw.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = wsRawToString(raw);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        gw.send(
          JSON.stringify({
            type: "req",
            id: `proxy-connect-${Date.now()}`,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "openclaw-control-ui",
                displayName: `web-user-${payload.username}`,
                version: "1.0.0",
                platform: "web",
                mode: "webchat",
              },
              role: "operator",
              scopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
              ],
              ...(GATEWAY_TOKEN ? { auth: { token: GATEWAY_TOKEN } } : {}),
            },
          }),
        );
        return;
      }

      if (msg.type === "res" && !handshakeDone) {
        handshakeDone = true;
        clearTimeout(handshakeTimeout);
        if (msg.ok) {
          gatewayConnected = true;
          retryCount = 0;
          for (const p of pendingFromClient) {
            gw.send(p.data);
          }
          pendingFromClient.length = 0;
          sendToClient(
            JSON.stringify({
              type: "connected",
              agentId,
              sessionKey,
              username: payload.username,
            }),
          );
        } else {
          const errMsg =
            (msg.error as { message?: string } | undefined)?.message ?? "unknown auth error";
          console.error(`[proxy:${payload.username}] gateway auth failed: ${errMsg}`);
          sendToClient(
            JSON.stringify({
              type: "gateway_status",
              status: "auth_failed",
              message: `Gateway 认证失败: ${errMsg}`,
            }),
          );
          gw.close();
        }
        return;
      }

      // Forward all other gateway messages to client
      sendToClient(text);
    });

    gw.on("close", (code: number, reason: Buffer) => {
      clearTimeout(handshakeTimeout);
      const reasonStr = reason.toString("utf-8");
      if (reasonStr) {
        console.error(
          `[proxy:${payload.username}] gateway closed: code=${code} reason=${reasonStr}`,
        );
      }
      gatewayConnected = false;
      gatewayWs = null;
      if (!clientClosed) {
        const detail = reasonStr ? ` (${reasonStr})` : "";
        sendToClient(
          JSON.stringify({
            type: "gateway_status",
            status: "disconnected",
            message: reasonStr ? `Gateway 断开${detail}` : undefined,
          }),
        );
        scheduleRetry();
      }
    });

    gw.on("error", () => {
      clearTimeout(handshakeTimeout);
      // "close" event fires after "error", retry happens there
    });
  }

  function scheduleRetry(): void {
    if (clientClosed || retryCount >= MAX_RETRIES) {
      if (retryCount >= MAX_RETRIES) {
        sendToClient(
          JSON.stringify({
            type: "gateway_status",
            status: "unavailable",
            message: "Gateway 不可用，请确保 openclaw gateway 已启动",
          }),
        );
      }
      return;
    }
    const delay = Math.min(2000 * Math.pow(2, retryCount), 30_000);
    retryCount++;
    retryTimer = setTimeout(connectToGateway, delay);
  }

  function cleanup(): void {
    clientClosed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.close();
    }
  }

  // Handle messages from browser client
  clientWs.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = wsRawToString(raw);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === "req") {
      const method = msg.method as string;
      const params = (msg.params || {}) as Record<string, unknown>;

      if (method === "chat.send" || method === "chat.history" || method === "chat.abort") {
        params.sessionKey = sessionKey;
      }
      if (method === "agent") {
        params.sessionKey = sessionKey;
        params.agentId = agentId;
      }
      msg.params = params;
    }

    const data = JSON.stringify(msg);
    if (gatewayConnected && gatewayWs?.readyState === WebSocket.OPEN) {
      gatewayWs.send(data);
    } else {
      pendingFromClient.push({ data });
      // If not connected, try to connect
      if (!gatewayWs && !retryTimer) {
        connectToGateway();
      }
    }
  });

  clientWs.on("close", cleanup);
  clientWs.on("error", cleanup);

  // Start initial gateway connection attempt
  connectToGateway();
});

server.listen(PORT, () => {
  console.log(`OpenClaw Web App running at http://localhost:${PORT}`);
  console.log(`Gateway: ${GATEWAY_URL}`);
});
