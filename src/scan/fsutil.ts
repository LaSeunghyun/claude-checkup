// 파일 읽기 도구. 비밀값이 있을 수 있는 이름의 파일은 여기서 막는다.
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

// 이름에 credential, token, secret, auth, .env, .pem, .key 가 들어간 파일은 열지 않는다.
// 같은 취지로 password, api key, 단어 pat(개인 액세스 토큰 약칭)도 막는다
const SECRET_RE = /credential|token|secret|auth|\.env|\.pem|\.key|password|passwd|api[-_]?key|(^|[^a-z])pat([^a-z]|$)/i;

export function isSecretName(p: string): boolean {
  return SECRET_RE.test(basename(p.split("\\").join("/")));
}

// 글 속에 섞여 있을지 모르는 비밀값 모양을 가린다 (화면에 나가는 모든 글에 적용)
const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[bpoas]-[A-Za-z0-9-]{8,}|ATATT[A-Za-z0-9_=-]{8,}|figd_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{12,})|eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g;

export function redactSecrets(s: string): string {
  return s.replace(SECRET_VALUE_RE, "***");
}

// 비밀값 모양이 든 줄 번호(1부터). 값은 돌려주지도 저장하지도 않는다 (secret-in-file 진단용)
const SECRET_LINE_RE = new RegExp(SECRET_VALUE_RE.source); // g 없이: test 가 줄마다 처음부터 찾는다

export function secretLineNumbers(text: string): number[] {
  const out: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (SECRET_LINE_RE.test(lines[i])) out.push(i + 1);
  return out;
}

export function readText(p: string, max = 2_000_000): string | null {
  if (isSecretName(p)) return null;
  try {
    const buf = readFileSync(p);
    return (buf.length > max ? buf.subarray(0, max) : buf).toString("utf8");
  } catch {
    return null;
  }
}

// JSON 은 모양이 제각각이라 any 로 받는다
export function readJson(p: string): any | null {
  const t = readText(p, 100_000_000);
  if (t == null) return null;
  try {
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function listDir(p: string): Dirent[] {
  try {
    return readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export const exists = existsSync;

export function mtimeIso(p: string): string | undefined {
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export const slash = (p: string): string => p.replace(/\\/g, "/");

// 표시용 경로: 홈은 ~ 로 줄이고, 홈 밖은 슬래시 절대경로
export function displayPath(abs: string, home: string): string {
  const a = slash(abs);
  const h = slash(home).replace(/\/+$/, "");
  const al = a.toLowerCase();
  const hl = h.toLowerCase();
  if (al === hl) return "~";
  if (al.startsWith(hl + "/")) return "~" + a.slice(h.length);
  return a;
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

export function resolveFrom(base: string, p: string, home: string): string {
  const e = expandHome(p, home);
  return isAbsolute(e) ? resolve(e) : resolve(base, e);
}

// 읽힌 파일 매칭 키: '/.claude/' 뒤 부분(소문자, 슬래시). 홈 이름 차이(8.3 짧은 이름)를 무시한다
export function claudeRelKey(p: string): string | null {
  const n = slash(p).toLowerCase();
  const i = n.indexOf("/.claude/");
  return i >= 0 ? n.slice(i + 9) : null;
}
