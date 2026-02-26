import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";

function resolveGatewayToken(): string {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
    const raw = fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8");
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    return cfg.gateway?.auth?.token ?? "";
  } catch {
    return "";
  }
}

const GATEWAY_TOKEN = resolveGatewayToken();

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let ws: WebSocket | null = null;
let connected = false;
let connectPromise: Promise<void> | null = null;
const pending = new Map<string, Pending>();
let reqCounter = 0;

function nextId(): string {
  return `admin-${++reqCounter}-${Date.now()}`;
}

function ensureConnection(): Promise<void> {
  if (connected && ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = new Promise<void>((resolve, reject) => {
    const gwOrigin = GATEWAY_URL.replace("ws://", "http://").replace("wss://", "https://");
    const socket = new WebSocket(GATEWAY_URL, { origin: gwOrigin });
    let handshakeDone = false;

    socket.on("open", () => {
      // Wait for connect.challenge, then send connect
    });

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString("utf-8")
        : Buffer.from(raw as ArrayBuffer).toString("utf-8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        const connectFrame = {
          type: "req",
          id: nextId(),
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "openclaw-control-ui",
              displayName: "Web App Admin",
              version: "1.0.0",
              platform: "node",
              mode: "backend",
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
        };
        socket.send(JSON.stringify(connectFrame));
        return;
      }

      if (msg.type === "res") {
        const id = msg.id as string;
        if (!handshakeDone) {
          handshakeDone = true;
          if (msg.ok) {
            ws = socket;
            connected = true;
            connectPromise = null;
            resolve();
          } else {
            const errMsg = (msg.error as { message?: string })?.message || "connect failed";
            connectPromise = null;
            reject(new Error(errMsg));
          }
          return;
        }
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          if (msg.ok) {
            entry.resolve(msg.payload);
          } else {
            const errMsg = (msg.error as { message?: string })?.message || "request failed";
            entry.reject(new Error(errMsg));
          }
        }
      }
    });

    socket.on("close", () => {
      connected = false;
      ws = null;
      connectPromise = null;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("connection closed"));
      }
      pending.clear();
    });

    socket.on("error", (err) => {
      if (!handshakeDone) {
        connectPromise = null;
        reject(err);
      }
    });
  });

  return connectPromise;
}

export async function gatewayRequest<T = unknown>(method: string, params: unknown): Promise<T> {
  await ensureConnection();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("gateway not connected");
  }

  const id = nextId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`gateway request timeout: ${method}`));
    }, 30_000);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });

    ws!.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

export async function createAgent(agentId: string, name: string, workspace: string): Promise<void> {
  await gatewayRequest("agents.create", { name: agentId, workspace });
}

export async function deleteAgent(agentId: string): Promise<void> {
  await gatewayRequest("agents.delete", { agentId, deleteFiles: true });
}

export async function listAgentFiles(agentId: string): Promise<unknown> {
  return gatewayRequest("agents.files.list", { agentId });
}

export async function getAgentFile(agentId: string, name: string): Promise<unknown> {
  return gatewayRequest("agents.files.get", { agentId, name });
}

export async function setAgentFile(
  agentId: string,
  name: string,
  content: string,
): Promise<unknown> {
  return gatewayRequest("agents.files.set", { agentId, name, content });
}
