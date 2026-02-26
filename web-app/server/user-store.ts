import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type User = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  agentId: string;
  displayName: string;
  createdAt: number;
  lastLoginAt: number;
};

type UserStoreData = {
  users: User[];
};

function resolveStorePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  return path.join(stateDir, "web-users.json");
}

function hashPassword(password: string, salt: string): string {
  return createHash("sha256")
    .update(salt + password)
    .digest("hex");
}

function loadStore(): UserStoreData {
  const storePath = resolveStorePath();
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    return JSON.parse(raw) as UserStoreData;
  } catch {
    return { users: [] };
  }
}

function saveStore(data: UserStoreData): void {
  const storePath = resolveStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createUser(username: string, password: string, displayName: string): User | null {
  const store = loadStore();
  const normalized = username.trim().toLowerCase();
  if (store.users.some((u) => u.username === normalized)) {
    return null;
  }

  const salt = randomBytes(16).toString("hex");
  const id = randomBytes(8).toString("hex");
  const agentId = `user-${normalized}`;
  const now = Date.now();

  const user: User = {
    id,
    username: normalized,
    passwordHash: hashPassword(password, salt),
    salt,
    agentId,
    displayName: displayName || normalized,
    createdAt: now,
    lastLoginAt: now,
  };

  store.users.push(user);
  saveStore(store);
  return user;
}

export function authenticateUser(username: string, password: string): User | null {
  const store = loadStore();
  const normalized = username.trim().toLowerCase();
  const user = store.users.find((u) => u.username === normalized);
  if (!user) {
    return null;
  }

  const hash = hashPassword(password, user.salt);
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hash, "hex");
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }

  user.lastLoginAt = Date.now();
  saveStore(store);
  return user;
}

export function deleteUser(username: string): boolean {
  const store = loadStore();
  const normalized = username.trim().toLowerCase();
  const idx = store.users.findIndex((u) => u.username === normalized);
  if (idx < 0) {
    return false;
  }
  store.users.splice(idx, 1);
  saveStore(store);
  return true;
}

export function findUserById(id: string): User | null {
  const store = loadStore();
  return store.users.find((u) => u.id === id) ?? null;
}

export function findUserByUsername(username: string): User | null {
  const store = loadStore();
  const normalized = username.trim().toLowerCase();
  return store.users.find((u) => u.username === normalized) ?? null;
}

export function listUsers(): User[] {
  return loadStore().users;
}
