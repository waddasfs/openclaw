import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function resolveSecretPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  return path.join(stateDir, "web-jwt-secret");
}

let cachedSecret: string | null = null;

function getSecret(): string {
  if (cachedSecret) {
    return cachedSecret;
  }
  const secretPath = resolveSecretPath();
  try {
    cachedSecret = fs.readFileSync(secretPath, "utf-8").trim();
  } catch {
    cachedSecret = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

export type TokenPayload = {
  sub: string;
  username: string;
  agentId: string;
  iat: number;
  exp: number;
};

export function createToken(
  payload: Omit<TokenPayload, "iat" | "exp">,
  expiresInMs = 24 * 60 * 60 * 1000,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + Math.floor(expiresInMs / 1000),
  };

  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(full));
  const signature = createHmac("sha256", getSecret())
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts;
  const expectedSig = createHmac("sha256", getSecret())
    .update(`${header}.${body}`)
    .digest("base64url");

  if (signature !== expectedSig) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body)) as TokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
