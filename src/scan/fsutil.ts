// 파일 읽기 도구. 비밀값이 있을 수 있는 이름의 파일은 여기서 막는다.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

// ---- 가상 덮어쓰기 (design.md 8-4절) ----
// 미리 보기는 바뀐 홈을 실제 파일을 건드리지 않고 다시 분석한다. 분석이 읽는 파일은 모두 아래 함수를 거치므로
// overlay 가 켜져 있는 동안은 덮어쓴 파일은 새 내용, null 은 없는 것(폴더면 그 아래 전부), 새 파일은 목록에 나타난다.

// 키는 overlayKey(abs). 값이 글이면 그 내용의 파일, null 이면 없는 파일이나 폴더.
// names 는 키 -> 원래 대소문자 절대경로. 새 파일 이름을 목록에 원래대로 보이려고 쓴다(없으면 키의 소문자 이름). overlayFrom 이 둘 다 채운다
// 키는 realpath 가 아니라 resolve 기준이라 8.3 짧은 이름(WISEBI~1)과 긴 이름은 다른 키다. 분석과 같은 home 문자열에서 만든 경로를 쓴다
export interface Overlay {
  files: Map<string, string | null>;
  names?: Map<string, string>;
}

// 절대경로 -> 내용(null = 없음) 목록으로 overlay 를 만든다
export function overlayFrom(entries: Iterable<[string, string | null]>): Overlay {
  const files = new Map<string, string | null>();
  const names = new Map<string, string>();
  for (const [abs, v] of entries) {
    const k = overlayKey(abs);
    files.set(k, v);
    names.set(k, abs);
  }
  return { files, names };
}

// 목록 한 칸. 실제 Dirent 도 이 모양이다
export interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

const WIN = process.platform === "win32";

export function overlayKey(abs: string): string {
  const k = resolve(abs).replace(/\\/g, "/");
  return WIN ? k.toLowerCase() : k;
}

interface Active {
  files: Map<string, string | null>;
  dirs: Map<string, Map<string, DirEntry>>; // 새 파일 때문에 생기는 폴더 키 -> 그 안의 새 항목 (키는 이름 키)
  nulls: boolean;
}

let active: Active | null = null;

const nameKey = (n: string): string => (WIN ? n.toLowerCase() : n);
const childKey = (dir: string, name: string): string => (dir.endsWith("/") ? dir : dir + "/") + nameKey(name);
const fake = (name: string, dir: boolean): DirEntry => ({ name, isFile: () => !dir, isDirectory: () => dir });

function prepare(ov: Overlay): Active {
  const dirs = new Map<string, Map<string, DirEntry>>();
  let nulls = false;
  for (const [k, v] of ov.files) {
    if (v === null) {
      nulls = true;
      continue;
    }
    // 위로 올라가며 부모 폴더마다 자식 하나씩. 이름은 원래 경로의 같은 자리 조각(조각 수가 다르면 키의 조각)
    const raw = ov.names?.get(k);
    const orig = raw ? slash(resolve(raw)).split("/") : [];
    const parts = k.split("/");
    const nameAt = (j: number) => (orig.length === parts.length ? orig[j] : parts[j]);
    let child = k;
    let dir = false;
    for (let i = child.lastIndexOf("/"); i > 0; i = child.lastIndexOf("/")) {
      const parent = child.slice(0, i);
      if (!child.slice(i + 1)) break;
      const name = nameAt(parent.split("/").length);
      const m = dirs.get(parent) ?? dirs.set(parent, new Map()).get(parent)!;
      const prev = m.get(nameKey(name));
      if (!prev || (dir && !prev.isDirectory())) m.set(nameKey(name), fake(name, dir));
      child = parent;
      dir = true;
    }
  }
  return { files: ov.files, dirs, nulls };
}

// 분석은 동기라 겹치지 않는다. 비동기 함수를 넘기면 덮어쓰기가 중간에 풀리므로 막는다
// 안에서 또 부르면 바깥 overlay 를 대신한다(겹쳐 쌓지 않는다). 끝나면 바깥 것으로 돌아간다
export function withOverlay<T>(ov: Overlay, fn: () => T): T {
  const prev = active;
  active = prepare(ov);
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("withOverlay 에는 동기 함수만 넘길 수 있어요");
    return r;
  } finally {
    active = prev;
  }
}

type State = { kind: "file"; text: string } | { kind: "dir" } | { kind: "none" } | { kind: "real" };

// overlay 가 그 경로를 어떻게 보는가. real = overlay 와 상관없음
function stateOf(k: string, a: Active): State {
  const v = a.files.get(k);
  if (typeof v === "string") return { kind: "file", text: v };
  if (a.dirs.has(k)) return { kind: "dir" };
  if (v === null || (a.nulls && underNull(k, a))) return { kind: "none" };
  return { kind: "real" };
}

function underNull(k: string, a: Active): boolean {
  for (let i = k.lastIndexOf("/"); i > 0; i = k.lastIndexOf("/")) {
    k = k.slice(0, i);
    if (a.files.get(k) === null) return true;
  }
  return false;
}

const clip = (buf: Buffer, max: number): string => (buf.length > max ? buf.subarray(0, max) : buf).toString("utf8");

export function readText(p: string, max = 2_000_000): string | null {
  if (isSecretName(p)) return null;
  if (active) {
    const s = stateOf(overlayKey(p), active);
    if (s.kind === "file") return s.text.length * 3 <= max ? s.text : clip(Buffer.from(s.text, "utf8"), max);
    if (s.kind !== "real") return null;
  }
  try {
    return clip(readFileSync(p), max);
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
  if (active) {
    const s = stateOf(overlayKey(p), active);
    if (s.kind !== "real") return s.kind === "dir";
  }
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  if (active) {
    const s = stateOf(overlayKey(p), active);
    if (s.kind !== "real") return s.kind === "file";
  }
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realList(p: string): DirEntry[] {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function listDir(p: string): DirEntry[] {
  const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name);
  if (!active) return realList(p).sort(byName);
  const a = active;
  const k = overlayKey(p);
  const s = stateOf(k, a);
  if (s.kind === "file" || s.kind === "none") return [];
  // 실제 폴더가 null 아래에 있으면 실제 목록은 없고 새 항목만 남는다
  const real = s.kind === "dir" && a.nulls && (a.files.get(k) === null || underNull(k, a)) ? [] : realList(p);
  const out: DirEntry[] = [];
  const seen = new Set<string>();
  for (const d of real) {
    const ck = childKey(k, d.name);
    seen.add(nameKey(d.name));
    const v = a.files.get(ck);
    if (typeof v === "string") out.push(fake(d.name, false));
    else if (a.dirs.has(ck)) out.push(fake(d.name, true));
    else if (v !== null) out.push(d);
  }
  for (const [n, d] of a.dirs.get(k) ?? []) if (!seen.has(n)) out.push(d);
  return out.sort(byName);
}

export function exists(p: string): boolean {
  if (active) {
    const s = stateOf(overlayKey(p), active);
    if (s.kind !== "real") return s.kind !== "none";
  }
  return existsSync(p);
}

// 덮어쓴 파일은 실제 파일의 시각(없으면 없음)을 쓴다. 분석 결과가 시각 때문에 흔들리지 않게
export function mtimeIso(p: string): string | undefined {
  if (active && stateOf(overlayKey(p), active).kind === "none") return undefined;
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
