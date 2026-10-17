import { readFileSync } from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { sha256 } from "../crypto.js";
import { ensurePrivateDataDir, writeJsonAtomic } from "../fsutil.js";

/** One login from an MCP client (Claude, ChatGPT…): lives until `expiresAt` (null = until revoked), refresh tokens rotate inside it. */
export interface Session {
  id: string;
  clientId: string;
  clientName?: string;
  connectionId: string; // Wise connection (one per Wise API token)
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number;
}

export interface StoredToken {
  kind: "access" | "refresh";
  sessionId: string;
  scopes: string[];
  expiresAt: number | null; // ms epoch; null only for refresh tokens of "never" sessions
  resource: string;
}

interface StoreFile {
  clients: Record<string, OAuthClientInformationFull>;
  sessions: Record<string, Session>;
  tokens: Record<string, StoredToken>; // key = sha256(token); raw tokens are never written to disk
}

const expired = (at: number | null, now = Date.now()) => at !== null && at < now;

/** Tiny JSON-file store; survives restarts so clients stay connected. */
export class AuthStore {
  private data: StoreFile = { clients: {}, sessions: {}, tokens: {} };
  private file: string;

  constructor(dataDir: string) {
    ensurePrivateDataDir(dataDir);
    this.file = path.join(dataDir, "oauth-sessions.json");
    try {
      this.data = { ...this.data, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      /* first run */
    }
    this.sweep();
  }

  getClient(id: string) {
    return this.data.clients[id];
  }

  saveClient(client: OAuthClientInformationFull) {
    this.data.clients[client.client_id] = client;
    this.flush();
  }

  createSession(session: Session) {
    this.data.sessions[session.id] = session;
    this.flush();
  }

  getSession(id: string): Session | undefined {
    const s = this.data.sessions[id];
    if (s && expired(s.expiresAt)) {
      this.deleteSession(id);
      return undefined;
    }
    return s;
  }

  listSessions(connectionId?: string): Session[] {
    this.sweep();
    return Object.values(this.data.sessions)
      .filter((s) => !connectionId || s.connectionId === connectionId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  touchSession(id: string) {
    const s = this.data.sessions[id];
    // Persist at most once a minute to avoid rewriting the file on every MCP call.
    if (s && Date.now() - s.lastUsedAt > 60_000) {
      s.lastUsedAt = Date.now();
      this.flush();
    }
  }

  /** Revokes a session and every token issued in it. */
  deleteSession(id: string) {
    delete this.data.sessions[id];
    for (const [k, t] of Object.entries(this.data.tokens)) if (t.sessionId === id) delete this.data.tokens[k];
    this.flush();
  }

  deleteSessionsForConnection(connectionId: string) {
    for (const s of Object.values(this.data.sessions)) if (s.connectionId === connectionId) this.deleteSession(s.id);
  }

  getToken(raw: string): { token: StoredToken; session: Session } | undefined {
    const key = sha256(raw);
    const token = this.data.tokens[key];
    if (!token) return undefined;
    const session = this.getSession(token.sessionId);
    if (!session || expired(token.expiresAt)) {
      delete this.data.tokens[key];
      this.flush();
      return undefined;
    }
    return { token, session };
  }

  saveToken(raw: string, token: StoredToken) {
    this.data.tokens[sha256(raw)] = token;
    this.flush();
  }

  deleteToken(raw: string) {
    if (delete this.data.tokens[sha256(raw)]) this.flush();
  }

  private sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (expired(s.expiresAt, now)) changed = delete this.data.sessions[id];
    }
    for (const [k, t] of Object.entries(this.data.tokens)) {
      if (expired(t.expiresAt, now) || !this.data.sessions[t.sessionId]) changed = delete this.data.tokens[k];
    }
    if (changed) this.flush();
  }

  private flush() {
    writeJsonAtomic(this.file, this.data);
  }
}
