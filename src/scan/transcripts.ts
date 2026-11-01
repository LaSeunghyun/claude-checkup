// 대화 기록(jsonl) 스트리밍 집계 + 파일별 캐시.
// 파일마다 "날짜별 횟수"(훅은 실행 한 번씩) 로 접어 두므로 캐시는 now 와 무관하게 재사용된다.
import { statSync } from "node:fs";
import { join } from "node:path";
import { listDir, isSecretName, readJson, slash, claudeRelKey } from "./fsutil";
import { estimateTokens } from "./text";

const CACHE_VERSION = 4;

// 재개된 대화는 이전 기록을 새 파일에 복사해 오므로, 같은 사건이 여러 파일에 있을 수 있다.
// 그래서 사건마다 id(tool_use id 또는 줄 uuid)를 남겨 두고 합칠 때 중복을 거른다.
export interface FileAgg {
  lt?: string; // 이 파일에서 본 가장 늦은 timestamp
  ev: [string, string, string][]; // [키, timestamp, id]. 키: S|스킬 U|직접 부름 A|에이전트 M|서비스 R|읽은 파일 P|요청
  x: Record<string, Record<string, string[]>>; // 도구 종류(read, bash, other) -> 날짜 -> id 목록
  hv: HookEv[]; // 훅 실행 한 번마다 한 줄
  l: Record<string, string>; // 훅별 마지막 timestamp ("H|" + 훅 키)
  e: Record<string, Record<string, number[]>>; // 이벤트별 additional_context: 날짜 -> [횟수, 글자합, 토큰합]
}

// 훅 실행 한 번: [훅 키("이벤트|명령 해시"), 날짜, 줄 uuid 끝 10자(없으면 ""), 걸린 ms, 표시(1 실패 2 막음), 시작 때 넣은 글자 수]
// id 가 있으면 복사본 중복을 거르고, ""(uuid 없는 줄)는 거르지 않는다
export type HookEv = [string, string, string, number, number, number];

const HOOK_FAIL = 1;
const HOOK_BLOCKED = 2;

interface CacheFile {
  v: number;
  files: Record<string, { m: number; s: number; a: FileAgg }>;
}

export interface TranscriptFile {
  path: string;
  size: number;
  sub: boolean; // subagents 등 하위 기록
  agg: FileAgg;
}

export interface LoadResult {
  files: TranscriptFile[];
  bytes: number;
  warnings: string[];
}

const NL = 10;
const N_TOOL_USE = Buffer.from('"type":"tool_use"');
const N_CMD = Buffer.from("<command-name>");
const N_HOOK = Buffer.from('"hook_');
const N_USER = Buffer.from('"type":"user"');
const N_TOOL_RESULT = Buffer.from('"type":"tool_result"');
const N_ASSISTANT = Buffer.from('"type":"assistant"');

export const normCmd = (s: string): string => s.replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase();

// 캐시에 명령 원문을 남기지 않도록 해시로 접는다
export const hookKey = (event: string, command: string): string => `${event}|${Bun.hash(normCmd(command)).toString(36)}`;

const pad = (n: number) => String(n).padStart(2, "0");
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyAgg(): FileAgg {
  return { ev: [], x: {}, hv: [], l: {}, e: {} };
}

const shortId = (id: unknown, fallback: string): string => (typeof id === "string" && id ? id : fallback).slice(-10);

function event(a: FileAgg, key: string, ts: string, id: string) {
  a.ev.push([key, ts, id]);
}

function toolClass(a: FileAgg, cls: string, day: string, id: string) {
  ((a.x[cls] ??= {})[day] ??= []).push(id);
}

const PROMPT_SKIP = ["[Request interrupted", "<local-command-", "<task-notification", "<system-reminder"];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let s = "";
  for (const c of content) if (c && c.type === "text" && typeof c.text === "string") s += c.text + "\n";
  return s;
}

// Read 로 읽은 파일 중 지시문·메모리·스킬 따위 .md 만 키로 남긴다
function readKey(filePath: string): string | null {
  const n = slash(filePath).toLowerCase();
  if (!n.endsWith(".md")) return null;
  const rel = claudeRelKey(n);
  if (rel != null) return rel.includes("tool-results/") ? null : "c:" + rel;
  const base = n.slice(n.lastIndexOf("/") + 1);
  return base === "claude.md" || base === "agents.md" ? "p:" + n : null;
}

// 줄마다 모양이 제각각이라 any 로 받는다
type Obj = any;

function handleAssistant(o: Obj, a: FileAgg, day: string, ts: string) {
  const content = o.message?.content;
  if (!Array.isArray(content)) return;
  content.forEach((c: Obj, n: number) => {
    if (!c || c.type !== "tool_use" || typeof c.name !== "string") return;
    const name: string = c.name;
    const input = c.input ?? {};
    const id = shortId(c.id, `${o.uuid ?? ts}${n}`);
    if (name === "Skill") {
      const s = typeof input.skill === "string" ? input.skill.trim().replace(/^\//, "") : "";
      if (s) event(a, "S|" + s, ts, id);
    } else if (name === "Agent" || name === "Task") {
      const s = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
      event(a, "A|" + s, ts, id);
    } else if (name === "Read") {
      const k = typeof input.file_path === "string" ? readKey(input.file_path) : null;
      if (k) event(a, "R|" + k, ts, id);
    } else if (name.startsWith("mcp__")) {
      const rest = name.slice(5);
      const i = rest.indexOf("__");
      event(a, "M|" + (i > 0 ? rest.slice(0, i) : rest), ts, id);
      return; // 서비스 호출 수는 M| 사건에서 센다
    }
    toolClass(a, name === "Read" ? "read" : name === "Bash" || name === "PowerShell" ? "bash" : "other", day, id);
  });
}

function handleUser(o: Obj, a: FileAgg, ts: string, sub: boolean) {
  if (o.isMeta === true) return;
  const content = o.message?.content;
  if (Array.isArray(content) && content.some((c: Obj) => c?.type === "tool_result")) return;
  const text = textOf(content);
  const head = text.trimStart();
  const cm = /^<command-(?:message|name)>/.test(head) ? /<command-name>\s*([^<\s]+)\s*<\/command-name>/.exec(head) : null;
  const id = shortId(o.uuid, ts);
  if (cm) event(a, "U|" + cm[1].replace(/^\//, ""), ts, id);
  if (sub || o.isSidechain === true) return;
  if (!head && !(Array.isArray(content) && content.length)) return;
  if (PROMPT_SKIP.some((p) => head.startsWith(p))) return;
  event(a, "P|prompt", ts, id);
}

function injectedChars(stdout: unknown, event: string): number {
  if (typeof stdout !== "string") return 0;
  const s = stdout.trim();
  if (!s) return 0;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      const ctx = j?.hookSpecificOutput?.additionalContext ?? j?.additionalContext;
      return typeof ctx === "string" ? ctx.length : 0;
    } catch {
      /* 일반 글로 취급 */
    }
  }
  return event === "SessionStart" || event === "UserPromptSubmit" ? s.length : 0;
}

function handleAttachment(o: Obj, a: FileAgg, day: string, ts: string) {
  const at = o.attachment;
  if (!at || typeof at.type !== "string") return;
  const t: string = at.type;
  if (t === "hook_additional_context") {
    const ev = typeof at.hookEvent === "string" ? at.hookEvent : "";
    if (!ev) return;
    const arr: unknown[] = Array.isArray(at.content) ? at.content : typeof at.content === "string" ? [at.content] : [];
    let chars = 0;
    let tokens = 0;
    for (const x of arr) {
      if (typeof x !== "string") continue;
      chars += x.length;
      tokens += estimateTokens(x);
    }
    const d = ((a.e[ev] ??= {})[day] ??= [0, 0, 0]);
    d[0]++;
    d[1] += chars;
    d[2] += tokens;
    return;
  }
  const isErr = t.includes("hook") && t.includes("error");
  if (t !== "hook_success" && !isErr) return;
  // 막음(blocking) 오류 줄은 명령이 blockingError 안에 있을 수 있다
  const cmd = typeof at.command === "string" ? at.command : typeof at.blockingError?.command === "string" ? at.blockingError.command : "";
  const ev = typeof at.hookEvent === "string" ? at.hookEvent : "";
  if (!cmd || !ev) return;
  const dur = Number(at.durationMs) || 0;
  // 종료 코드 2 는 훅이 일부러 막은 것이라 실패가 아니다. 막음 type 이 아닌 오류(non_blocking)는 코드와 상관없이 실패로 센다
  const blockingType = t.includes("blocking") && !t.includes("non_blocking");
  const code = at.exitCode == null ? (blockingType ? 2 : isErr ? 1 : 0) : Number(at.exitCode);
  const blocked = code === 2 && (blockingType || !isErr);
  const fail = !blocked && (isErr || code !== 0);
  const key = hookKey(ev, cmd);
  a.hv.push([key, day, shortId(o.uuid, ""), dur, (fail ? HOOK_FAIL : 0) | (blocked ? HOOK_BLOCKED : 0), injectedChars(at.stdout, ev)]);
  const lk = "H|" + key;
  if (!a.l[lk] || ts > a.l[lk]) a.l[lk] = ts;
}

function handleLine(buf: Buffer, a: FileAgg, sub: boolean) {
  const hasToolUse = buf.includes(N_TOOL_USE);
  const hasCmd = buf.includes(N_CMD);
  const hasHook = buf.includes(N_HOOK);
  const hasUser = buf.includes(N_USER);
  if (!hasToolUse && !hasCmd && !hasHook && !hasUser) return;
  // 도구 결과가 담긴 사용자 줄은 용량만 크고 셀 것이 없다
  if (hasUser && buf.includes(N_TOOL_RESULT) && !buf.includes(N_ASSISTANT)) return;
  let o: Obj;
  try {
    o = JSON.parse(buf.toString("utf8"));
  } catch {
    return;
  }
  const ts = o?.timestamp;
  if (typeof ts !== "string") return;
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return;
  const day = dayKey(dt);
  if (!a.lt || ts > a.lt) a.lt = ts;
  switch (o.type) {
    case "assistant":
      handleAssistant(o, a, day, ts);
      break;
    case "user":
      handleUser(o, a, ts, sub);
      break;
    case "attachment":
      handleAttachment(o, a, day, ts);
      break;
  }
}

export async function scanTranscript(path: string, sub: boolean): Promise<FileAgg> {
  const agg = emptyAgg();
  const pieces: Uint8Array[] = [];
  for await (const chunk of Bun.file(path).stream()) {
    const cb = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (true) {
      const i = cb.indexOf(NL, start);
      if (i < 0) {
        if (start < cb.length) pieces.push(cb.subarray(start));
        break;
      }
      if (pieces.length) {
        pieces.push(cb.subarray(start, i));
        handleLine(Buffer.concat(pieces), agg, sub);
        pieces.length = 0;
      } else if (i > start) {
        handleLine(cb.subarray(start, i), agg, sub);
      }
      start = i + 1;
    }
  }
  if (pieces.length) handleLine(Buffer.concat(pieces), agg, sub);
  return agg;
}

function findJsonl(root: string, depth: number, out: { path: string; sub: boolean }[]) {
  for (const e of listDir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory()) findJsonl(p, depth + 1, out);
    else if (e.name.endsWith(".jsonl") && !isSecretName(e.name)) out.push({ path: p, sub: depth > 1 });
  }
}

export interface LoadOpts {
  cachePath?: string | null; // null 이면 캐시를 쓰지 않는다
  concurrency?: number;
  onFile?: (done: number, total: number) => void;
}

export async function loadTranscripts(claudeDir: string, opts: LoadOpts = {}): Promise<LoadResult> {
  const warnings: string[] = [];
  const found: { path: string; sub: boolean }[] = [];
  findJsonl(join(claudeDir, "projects"), 0, found);

  let cache: CacheFile = { v: CACHE_VERSION, files: {} };
  if (opts.cachePath) {
    const j = readJson(opts.cachePath);
    if (j && j.v === CACHE_VERSION && j.files) cache = j;
  }
  const next: CacheFile = { v: CACHE_VERSION, files: {} };
  const files: TranscriptFile[] = [];
  let bytes = 0;
  let failed = 0;
  let done = 0;
  let dirty = false;
  let idx = 0;
  opts.onFile?.(0, found.length);

  const worker = async () => {
    while (idx < found.length) {
      const f = found[idx++];
      let st;
      try {
        st = statSync(f.path);
      } catch {
        failed++;
        done++;
        continue;
      }
      const key = slash(f.path);
      const hit = cache.files[key];
      let agg: FileAgg | null = null;
      if (hit && hit.m === st.mtimeMs && hit.s === st.size) agg = hit.a;
      else {
        try {
          agg = await scanTranscript(f.path, f.sub);
          dirty = true;
        } catch {
          failed++;
        }
      }
      if (agg) {
        files.push({ path: f.path, size: st.size, sub: f.sub, agg });
        next.files[key] = { m: st.mtimeMs, s: st.size, a: agg };
        bytes += st.size;
      }
      done++;
      opts.onFile?.(done, found.length);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  if (failed) warnings.push(`대화 기록 ${failed}개를 읽지 못했어요. 그 파일은 집계에서 빠졌어요.`);

  if (opts.cachePath && (dirty || Object.keys(cache.files).length !== Object.keys(next.files).length)) {
    try {
      await Bun.write(opts.cachePath, JSON.stringify(next));
    } catch {
      /* 캐시를 못 써도 결과에는 영향이 없다 */
    }
  }
  return { files, bytes, warnings };
}

// ---- 날짜 창으로 합치기 ----

export interface Acc {
  all: number;
  d30: number[];
  last?: string;
}

export interface HookAcc {
  runs30: number;
  sumMs30: number;
  maxMs30: number;
  fail30: number;
  blocked30: number;
  injN30: number;
  injChars30: number;
  all: number;
  d30: number[];
  last?: string;
}

export interface UsageIndex {
  counters: Map<string, Acc>;
  hooks: Map<string, HookAcc>;
  events: Map<string, { n: number; chars: number; tokens: number }>;
  sessions30: number;
  prompts30: number;
  tools30: { read: number; bash: number; mcp: number; other: number };
}

export function windowDays(now: Date, n = 30): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return out;
}

export function aggregate(files: TranscriptFile[], days: string[]): UsageIndex {
  const idx = new Map(days.map((d, i) => [d, i] as const));
  const n = days.length;
  const fromIso = new Date(`${days[0]}T00:00:00`).toISOString();
  const counters = new Map<string, Acc>();
  const hooks = new Map<string, HookAcc>();
  const events = new Map<string, { n: number; chars: number; tokens: number }>();
  const seen = new Set<string>(); // 중복 제거: 사건 키 + id
  const seenTool = new Set<string>();
  const seenHook = new Set<string>(); // 훅 실행: 훅 키 + 줄 uuid
  const tools30 = { read: 0, bash: 0, mcp: 0, other: 0 };
  let sessions30 = 0;

  for (const f of files) {
    const a = f.agg;
    if (!f.sub && a.lt && a.lt >= fromIso) sessions30++;

    for (const [key, ts, id] of a.ev) {
      const sig = key + "" + id;
      if (seen.has(sig)) continue;
      seen.add(sig);
      let acc = counters.get(key);
      if (!acc) counters.set(key, (acc = { all: 0, d30: new Array(n).fill(0) }));
      acc.all++;
      const i = idx.get(dayKey(new Date(ts)));
      if (i !== undefined) acc.d30[i]++;
      if (!acc.last || ts > acc.last) acc.last = ts;
    }

    for (const [cls, byDay] of Object.entries(a.x)) {
      for (const [day, ids] of Object.entries(byDay)) {
        if (!idx.has(day)) continue;
        for (const id of ids) {
          if (seenTool.has(id)) continue;
          seenTool.add(id);
          tools30[cls as "read" | "bash" | "other"]++;
        }
      }
    }

    for (const [key, day, id, dur, flags, inj] of a.hv) {
      let h = hooks.get(key);
      if (!h) {
        hooks.set(key, (h = { runs30: 0, sumMs30: 0, maxMs30: 0, fail30: 0, blocked30: 0, injN30: 0, injChars30: 0, all: 0, d30: new Array(n).fill(0) }));
      }
      if (id) {
        const sig = key + "\0" + id; // 재개 복사본에 있는 같은 줄은 한 번만
        if (seenHook.has(sig)) continue;
        seenHook.add(sig);
      }
      h.all++;
      const i = idx.get(day);
      if (i === undefined) continue;
      h.d30[i]++;
      h.runs30++;
      h.sumMs30 += dur;
      if (dur > h.maxMs30) h.maxMs30 = dur;
      if (flags & HOOK_FAIL) h.fail30++;
      if (flags & HOOK_BLOCKED) h.blocked30++;
      if (inj > 0) {
        h.injN30++;
        h.injChars30 += inj;
      }
    }
    for (const [lk, l] of Object.entries(a.l)) {
      const h = lk.startsWith("H|") ? hooks.get(lk.slice(2)) : undefined;
      if (h && (!h.last || l > h.last)) h.last = l;
    }
    for (const [ev, byDay] of Object.entries(a.e)) {
      let e = events.get(ev);
      if (!e) events.set(ev, (e = { n: 0, chars: 0, tokens: 0 }));
      for (const [day, v] of Object.entries(byDay)) {
        if (!idx.has(day)) continue;
        e.n += v[0];
        e.chars += v[1];
        e.tokens += v[2];
      }
    }
  }
  for (const [k, acc] of counters) if (k.startsWith("M|")) tools30.mcp += acc.d30.reduce((x, y) => x + y, 0);
  const prompts = counters.get("P|prompt");
  return {
    counters,
    hooks,
    events,
    sessions30,
    prompts30: prompts ? prompts.d30.reduce((x, y) => x + y, 0) : 0,
    tools30,
  };
}
