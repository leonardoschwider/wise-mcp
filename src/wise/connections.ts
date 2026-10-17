import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { SecretBox, sha256 } from "../crypto.js";
import { ensurePrivateDataDir, writeJsonAtomic } from "../fsutil.js";
import { WiseClient, type WiseMe } from "./client.js";
import { WiseService } from "./service.js";

interface StoredConnection {
  token: string; // sealed Wise API token
  wiseUserId: number;
  wiseUserLabel?: string; // name or email, for /sessions
  createdAt: number;
}

export const wiseClient = (token: string) => new WiseClient(token, config.WISE_API_URL);

/** Wise connections (one per pasted API token), stored encrypted in DATA_DIR. */
export class ConnectionStore {
  private file: string;
  private data: Record<string, StoredConnection> = {};
  private services = new Map<string, WiseService>();

  constructor(
    dataDir: string,
    private box: SecretBox,
  ) {
    ensurePrivateDataDir(dataDir);
    const dir = path.join(dataDir, "wise");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "connections.json");
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      /* first run */
    }
  }

  static idFor(token: string) {
    return sha256(token).slice(0, 24);
  }

  save(token: string, me: WiseMe): string {
    const id = ConnectionStore.idFor(token);
    this.data[id] = { token: this.box.seal(token), wiseUserId: me.id, wiseUserLabel: me.name ?? me.email, createdAt: Date.now() };
    this.services.delete(id);
    this.flush();
    return id;
  }

  get(id: string) {
    const c = this.data[id];
    return c && { id, wiseUserId: c.wiseUserId, wiseUserLabel: c.wiseUserLabel, createdAt: c.createdAt };
  }

  service(id: string): WiseService | undefined {
    const c = this.data[id];
    if (!c) return undefined;
    let svc = this.services.get(id);
    if (!svc) {
      let token: string;
      try {
        token = this.box.open(c.token);
      } catch {
        console.warn(`Wise connection ${id} can't be decrypted (TOKEN_ENCRYPTION_KEY changed?); dropping it`);
        this.remove(id);
        return undefined;
      }
      svc = new WiseService(wiseClient(token));
      this.services.set(id, svc);
    }
    return svc;
  }

  remove(id: string) {
    this.services.delete(id);
    if (delete this.data[id]) this.flush();
  }

  /** Drops tokens no Claude session uses any more, so they aren't kept longer than needed. */
  prune(inUse: Set<string>) {
    const unused = Object.keys(this.data).filter((id) => !inUse.has(id));
    for (const id of unused) this.remove(id);
    return unused.length;
  }

  private flush() {
    writeJsonAtomic(this.file, this.data);
  }
}
