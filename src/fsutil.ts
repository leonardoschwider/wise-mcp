import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Keep credential, session and audit data private on Unix and Windows.
 * On Windows, Node's `mode`/`chmod` does not enforce NTFS ACLs.
 * Limit access to the logged-in user, SYSTEM and local Administrators.
 * Fail closed if permissions cannot be secured.
 */
export function ensurePrivateDataDir(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dataDir, 0o700);
    return;
  }

  const options = { encoding: "utf8" as const, windowsHide: true };
  const account = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], options);
  const sid = account.match(/S-1-5-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error("Cannot determine Windows user SID; refusing to start with unsecured Wise data.");

  // Remove permissions inherited from the parent (including generic Users groups).
  // Grant owner + Windows system administrators with well-known, locale-independent SIDs.
  execFileSync("icacls.exe", [
    dataDir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ], options);

  // Bring existing session/token/log files under the restricted directory ACL.
  // Atomic replacement files inherit the same ACL from their parent.
  if (readdirSync(dataDir).length) {
    execFileSync("icacls.exe", [path.join(dataDir, "*"), "/reset", "/T"], options);
  }
}

/**
 * Writes JSON atomically: no half-written state is exposed after a crash.
 * Unix uses 0600; Windows relies on the private DATA_DIR NTFS ACL.
 */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}
