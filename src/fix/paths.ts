// 고치기 엔진이 건드릴 수 있는 곳의 경계. 쓰기는 HOME/.claude (plugins 제외)와 HOME/.claude-checkup 만.
import { join, resolve, sep } from "node:path";

const WIN = process.platform === "win32";
const norm = (p: string): string => (WIN ? p.toLowerCase() : p);

export const claudeRoot = (home: string): string => join(home, ".claude");
export const appRoot = (home: string): string => join(home, ".claude-checkup");
export const offDir = (home: string): string => join(appRoot(home), "off");
export const backupsDir = (home: string): string => join(appRoot(home), "backups");
export const tmpDir = (home: string): string => join(appRoot(home), "tmp");

// 절대경로 -> HOME/.claude 기준 상대경로(슬래시, 원래 대소문자). .claude 밖이거나 plugins 아래, 루트 자신이면 null
export function relOf(home: string, abs: string): string | null {
  const root = resolve(claudeRoot(home));
  const a = resolve(abs);
  if (!norm(a).startsWith(norm(root) + sep)) return null;
  const rel = a.slice(root.length + 1).split(sep).join("/");
  const parts = rel.split("/");
  if (!rel || parts.includes("..") || parts.includes("")) return null;
  if (norm(parts[0]) === "plugins") return null;
  return rel;
}

export const absOf = (home: string, rel: string): string => join(claudeRoot(home), ...rel.split("/"));
