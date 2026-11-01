// 고치기 미리 보기 조립 (design.md 8-2, 8-4절). 진단 규칙으로 계획 함수를 고르고, 계획을 덮어쓴 가상의 홈을 다시 분석해 기대 효과를 계산한다.
// 이 파일은 실제 파일을 쓰지 않는다. 경로는 늘 스냅샷의 항목에서 얻고 화면(클라이언트)에서 받지 않는다.
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DiagnoseCtx } from "../scan/findings";
import { A4_TOKENS } from "../shared/rank";
import { isSecretName, readText, redactSecrets, slash } from "../scan/fsutil";
import { analyze, diagnoseCtxOf, type ScanCore } from "../scan/index";
import type { Entry } from "../scan/inventory";
import { MEMORY_INDEX_LINES } from "../scan/inventory";
import { countLines, estimateTokens } from "../scan/text";
import { todoFor } from "../scan/todo";
import { CATEGORIES, type Category, type ClaudeEnv, type Effect, type Finding, type FixPreview, type FixRequest, type Snapshot } from "../shared/types";
import { hashPath, type Planned } from "./backup";
import { planWithClaude } from "./claude";
import { planMoveOff, planPluginsOff } from "./mechanical";
import { claudeRoot, relOf } from "./paths";

// 요청이 잘못됐거나 이 진단은 앱이 고치지 않는 경우. status 는 서버 응답 코드
export class FixRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "FixRequestError";
  }
}

// claude 를 쓸 수 없어서 "맡길 말 복사"로 대신해야 하는 경우
export class ClaudeUnavailableError extends Error {
  constructor(reason?: string) {
    super(`${reason ? reason.replace(/[.\s]+$/, "") + ". " : ""}맡길 말을 복사해서 Claude Code에 붙여 넣어 주세요.`);
    this.name = "ClaudeUnavailableError";
  }
}

const NEAR_LINES = 180; // 목차 여유 줄 (design.md 8-2절)
const PLUGIN_RULES = new Set(["unused-plugin", "unused-items", "slow-hook", "failing-hook"]); // mechanical 이면 플러그인을 끈다
const CATEGORY_WORD: Record<Category, string> = { risk: "위험", broken: "고장", leak: "연결 누수", waste: "낭비", confusion: "헷갈림" };
const TURNS_OFF_DETAIL: Record<string, string> = {
  skill: "작업 설명서를 부를 수 없게 돼요.",
  command: "명령을 쓸 수 없게 돼요.",
  agent: "에이전트를 쓸 수 없게 돼요.",
  mcp: "연결된 서비스를 쓸 수 없게 돼요.",
  hook: "자동 실행 규칙이 더는 돌지 않아요.",
};

// ---- 진단 → 계획 ----

export interface FixTarget {
  finding: Finding;
  kind: "mechanical" | "claude";
  entries: Entry[]; // 고칠 항목 (요청의 itemIds 중 그 진단의 items 안의 것만)
  ctx: DiagnoseCtx;
}

// itemIds 는 그 진단의 items 안의 것만 받는다. 그 밖(경로, 다른 진단의 id)은 버린다
export function resolveTarget(snap: Snapshot, req: { findingId?: unknown; itemIds?: unknown }, ctxIn?: DiagnoseCtx): FixTarget {
  const finding = typeof req.findingId === "string" ? snap.findings.find((f) => f.id === req.findingId) : undefined;
  if (!finding) throw new FixRequestError("그 진단을 찾지 못했어요. 다시 점검한 뒤 해 주세요.", 404);
  if (finding.fixKind === "manual") throw new FixRequestError("이 진단은 앱이 고치지 않아요. 직접 하는 순서나 맡길 말 복사를 써 주세요.");
  const ids = Array.isArray(req.itemIds) ? finding.items.filter((id) => (req.itemIds as unknown[]).includes(id)) : finding.items;
  if (!ids.length) throw new FixRequestError("고칠 항목을 하나 이상 골라 주세요.");
  const ctx = ctxIn ?? diagnoseCtxOf(snap);
  if (!ctx) throw new FixRequestError("점검 결과가 오래됐어요. 다시 점검한 뒤 해 주세요.", 409);
  const byId = new Map(ctx.entries.map((e) => [e.item.id, e] as const));
  const entries = ids.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
  if (!entries.length) throw new FixRequestError("고칠 항목을 찾지 못했어요. 다시 점검한 뒤 해 주세요.", 409);
  return { finding, kind: finding.fixKind, entries, ctx };
}

function pluginKeyOf(t: FixTarget): string | undefined {
  if (!PLUGIN_RULES.has(t.finding.rule)) return undefined;
  return t.entries.find((e) => e.pluginKey)?.pluginKey;
}

function mechanicalPlan(home: string, t: FixTarget): { planned: Planned; turnsOff: FixPreview["turnsOff"] } {
  const key = pluginKeyOf(t);
  if (key) {
    // 플러그인 끄기: 그 플러그인의 구성이 모두 꺼진다. 쓰던 것이 먼저 보이게 사용 횟수 순
    const turnsOff = t.ctx.entries
      .filter((e) => e.pluginKey === key && e.item.kind !== "plugin" && TURNS_OFF_DETAIL[e.item.kind])
      .map((e) => ({ name: redactSecrets(e.item.name), uses30: e.item.hook?.runs30 ?? e.item.usage.count30, detail: TURNS_OFF_DETAIL[e.item.kind] }))
      .sort((a, b) => b.uses30 - a.uses30 || a.name.localeCompare(b.name));
    return { planned: planPluginsOff(home, [key]), turnsOff };
  }
  if (t.finding.rule === "unused-items" || t.finding.rule === "unread-md") {
    // 작업 설명서는 폴더째 옮긴다 (gain.ts 의 moveOff 와 같다)
    const abs = t.entries.filter((e) => e.abs).map((e) => (e.item.kind === "skill" && basename(e.abs!).toLowerCase() === "skill.md" ? dirname(e.abs!) : e.abs!));
    if (!abs.length) throw new FixRequestError("옮길 파일을 찾지 못했어요.");
    const turnsOff =
      t.finding.rule === "unused-items"
        ? t.entries.map((e) => ({ name: redactSecrets(e.item.name), uses30: e.item.usage.count30, detail: "보관 폴더로 옮겨져 목록에서 빠져요. 되돌리면 다시 생겨요." }))
        : [];
    return { planned: planMoveOff(home, abs), turnsOff };
  }
  throw new FixRequestError("이 진단은 앱이 바로 고칠 수 없어요.");
}

export interface ClaudeJob {
  targets: string[];
  scopeDirs: string[];
  prompt: string;
}

const COMMON_RULES = [
  "묻지 말고 바로 고쳐 주세요. 결과는 앱이 미리 보기로 보여 주고, 적용할지는 사용자가 정해요.",
  "백업 파일은 만들지 마세요. 백업은 앱이 해요.",
  "새 폴더는 만들지 말고, 파일은 지우지 마세요.",
];
const INDEX_RULE = `MEMORY.md 는 ${NEAR_LINES}줄 이내로 맞춰 주세요. 넘치면 같은 폴더에 주제별 하위 목차 파일 1개를 만들고, MEMORY.md 에는 그 파일로 가는 한 줄만 넣어 주세요.`;
const ARCHIVE_RULE =
  '보관할 만한 파일(오래됐거나 다른 파일과 겹치는 것)은 고치지 말고, 답의 마지막에 ```json {"archive":[{"file":"...","reason":"..."}]} ``` 로만 알려 줘. file 은 현재 폴더 기준 경로, reason 은 한 줄 이유예요.';

// 요청문의 실제 경로(~/.claude/..., 홈 절대경로)를 임시 폴더(= .claude 와 같은 구조) 기준 상대 경로로 바꾼다
export function toTempPaths(home: string, text: string): string {
  const root = claudeRoot(home);
  const forms = [...new Set([slash(root), root, "~/.claude", "~\\.claude"])].sort((a, b) => b.length - a.length);
  let out = text;
  for (const f of forms) {
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc + "[\\\\/]", process.platform === "win32" ? "gi" : "g"), "");
    out = out.replace(new RegExp(esc + "(?![\\w.-])", process.platform === "win32" ? "gi" : "g"), ".");
  }
  return out;
}

export function claudeJobOf(home: string, t: FixTarget): ClaudeJob {
  const { finding, entries } = t;
  const e = entries[0];
  const need = (x: Entry) => {
    if (!x.abs || relOf(home, x.abs) === null) throw new FixRequestError("이 파일은 Claude에게 맡길 수 없는 곳에 있어요. 맡길 말을 복사해서 직접 해 주세요.");
    return x.abs;
  };
  let targets: string[] = [];
  let scopeDirs: string[] = [];
  const extra: string[] = [];
  switch (finding.rule) {
    case "memory-index-truncated":
    case "memory-index-near-limit":
      targets = [need(e)];
      scopeDirs = [e.memDir ?? dirname(e.abs!)];
      extra.push(INDEX_RULE);
      break;
    case "unreachable-md":
      if (!e.memDir) throw new FixRequestError("메모리 폴더를 찾지 못했어요.");
      entries.forEach(need);
      scopeDirs = [e.memDir];
      extra.push(INDEX_RULE, ARCHIVE_RULE);
      break;
    case "broken-link":
      targets = [need(e)];
      if (e.memDir) scopeDirs = [e.memDir];
      break;
    case "long-skill":
      targets = [need(e)];
      if (basename(e.abs!).toLowerCase() === "skill.md") scopeDirs = [dirname(e.abs!)];
      extra.push("옮길 내용은 SKILL.md 와 같은 폴더에 새 .md 파일로 두세요. 새 하위 폴더는 만들 수 없어요.");
      break;
    case "duplicate-rule":
    case "missing-description":
    case "similar-description":
      targets = entries.map(need);
      break;
    default:
      throw new FixRequestError("이 진단은 Claude에게 맡길 수 없어요.");
  }
  // 요청문은 todo.ts 와 같다. 고른 항목만으로 다시 만들고, 비밀값 모양은 가린다
  const byId = new Map(t.ctx.entries.map((x) => [x.item.id, x] as const));
  const base = redactSecrets(todoFor({ ...finding, items: entries.map((x) => x.item.id) }, t.ctx, byId).prompt);
  const prompt = toTempPaths(home, [base, "", "지켜 주세요:", ...[...COMMON_RULES, ...extra].map((r) => `- ${r}`)].join("\n"));
  return { targets, scopeDirs, prompt };
}

// 예상 사용량 (design.md 8-3절, Ruling 19): 복사할 파일의 토큰을 어림해 실행 전에 보여 준다. 정확한 값은 실행 뒤 usage
const BASE_INPUT = 12_000; // Claude Code 가 늘 싣는 지시와 도구 설명 (캐시라 실제 값보다 크게 잡는다)
export function estimateUsage(job: ClaudeJob): { inputTokens: number; outputTokens: number } {
  const files = new Set<string>(job.targets);
  for (const d of job.scopeDirs) for (const f of walk(d)) files.add(f);
  let tokens = 0;
  for (const f of files) {
    if (isSecretName(f)) continue;
    const t = readText(f);
    if (t != null) tokens += estimateTokens(t);
  }
  // 읽고, 고치고, 다시 읽는 몇 번의 차례에 같은 글이 다시 실린다
  return { inputTokens: BASE_INPUT + estimateTokens(job.prompt) + tokens * 3, outputTokens: Math.min(tokens, 8000) + 500 };
}

function walk(d: string, out: string[] = []): string[] {
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(join(d, e.name), out);
      else if (e.isFile()) out.push(join(d, e.name));
    }
  } catch {
    /* 없는 폴더 */
  }
  return out;
}

/** "약 1만 2천 토큰" (화면의 tokenText 와 같은 꼴) */
export function tokenWords(n: number): string {
  const r = Math.round(n / 1000) * 1000;
  if (r <= 0) return "1천 토큰 미만";
  const man = Math.floor(r / 10000);
  const cheon = (r % 10000) / 1000;
  return `약 ${[man > 0 ? `${man}만` : "", cheon > 0 ? `${cheon}천` : ""].filter(Boolean).join(" ")} 토큰`;
}

// ---- 보관 후보 ----

// 결과 글의 마지막 ```json {"archive":[...]} ``` 블록을 읽는다. 고른 항목 안의 파일만, 없거나 깨지면 빈 목록
export function parseCandidates(home: string, text: string, entries: Entry[]): FixPreview["candidates"] {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const raw = blocks.reverse().find((b) => b.includes('"archive"'));
  if (!raw) return [];
  let j: any;
  try {
    j = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!j || !Array.isArray(j.archive)) return [];
  const byRel = new Map<string, Entry>();
  for (const e of entries) {
    const rel = e.abs ? relOf(home, e.abs) : null;
    if (rel) byRel.set(rel.toLowerCase(), e);
  }
  const out: FixPreview["candidates"] = [];
  const seen = new Set<string>();
  for (const a of j.archive) {
    if (!a || typeof a.file !== "string") continue;
    const key = slash(a.file).replace(/^(\.\/)+/, "").toLowerCase();
    const e = byRel.get(key) ?? (key.includes("/") ? undefined : entries.find((x) => x.abs && basename(x.abs).toLowerCase() === key));
    if (!e || seen.has(e.item.id)) continue;
    seen.add(e.item.id);
    const reason = typeof a.reason === "string" ? redactSecrets(a.reason.replace(/\s+/g, " ").trim()).slice(0, 200) : "";
    out.push({ itemId: e.item.id, rel: relOf(home, e.abs!)!, reason: reason || "Claude가 보관 후보로 골랐어요" });
  }
  return out;
}

// ---- 기대 효과 ----

// 전후 A4 글이 같아 보이면 자릿수를 늘린다
function pagePair(before: number, after: number): [string, string] {
  const at = (d: number) => (t: number) => `A4 약 ${(t / A4_TOKENS).toFixed(d)}쪽`;
  const d = [1, 2].find((n) => at(n)(before) !== at(n)(after)) ?? 3;
  return [at(d)(before), at(d)(after)];
}

const toneOf = (before: number, after: number): Effect["tone"] => (after < before ? "good" : after > before ? "cost" : "neutral");

const keyOf = (f: Finding) => `${f.rule}|${[...f.items].sort().join(",")}`;

export function effectsOf(home: string, before: Snapshot, after: Snapshot, planned: Planned): { effects: Effect[]; blocked?: string } {
  const effects: Effect[] = [];
  const tokens = (label: string, b: number, a: number) => {
    if (b === a) return;
    const [x, y] = pagePair(b, a);
    effects.push({ label, before: x, after: y, tone: toneOf(b, a) });
  };
  const count = (label: string, unit: string, b: number, a: number) => {
    if (b !== a) effects.push({ label, before: `${b}${unit}`, after: `${a}${unit}`, tone: toneOf(b, a) });
  };
  tokens("대화를 시작할 때마다 미리 채워지는 양", before.context.totalTokens, after.context.totalTokens);
  tokens("한 달 동안 안 쓴 것이 대화마다 차지하는 양", before.context.unusedTokens, after.context.unusedTokens);
  count("AI가 찾아갈 길이 없는 메모리 파일", "개", before.leaks.unreachable, after.leaks.unreachable);
  count("끊긴 링크", "곳", before.leaks.brokenLinks, after.leaks.brokenLinks);
  count("길은 있는데 한 달 동안 안 읽힌 메모리 파일", "개", before.leaks.unread, after.leaks.unread);

  // 바뀌는 MEMORY.md 의 줄 수와 바뀌는 파일 글자 수
  let charsB = 0;
  let charsA = 0;
  for (const w of planned.writes) {
    const old = readText(w.abs) ?? "";
    const now = w.content ?? "";
    charsB += old.length;
    charsA += now.length;
    if (basename(w.abs).toLowerCase() === "memory.md") {
      const b = countLines(old);
      const a = countLines(now);
      if (a === b) continue;
      const tone: Effect["tone"] = a > MEMORY_INDEX_LINES || (a > NEAR_LINES && a > b) ? "cost" : a < b ? "good" : "neutral";
      effects.push({ label: `${relOf(home, w.abs) ?? "MEMORY.md"} 줄 수 (AI는 앞 ${MEMORY_INDEX_LINES}줄까지만 읽어요)`, before: `${b}줄`, after: `${a}줄`, tone });
    }
  }
  if (charsB !== charsA) effects.push({ label: "바뀌는 파일의 글자 수", before: `${charsB.toLocaleString("en-US")}자`, after: `${charsA.toLocaleString("en-US")}자`, tone: "neutral" });

  const byCat = (s: Snapshot) => Object.fromEntries(CATEGORIES.map((c) => [c, s.findings.filter((f) => f.category === c).length])) as Record<Category, number>;
  const cb = byCat(before);
  const ca = byCat(after);
  for (const c of CATEGORIES) count(`남은 진단 (${CATEGORY_WORD[c]})`, "건", cb[c], ca[c]);

  // 새 고장(높음)이 생기면 적용을 막는다
  const had = new Set(before.findings.filter((f) => f.severity === "high").map(keyOf));
  const fresh = after.findings.filter((f) => f.severity === "high" && !had.has(keyOf(f)));
  const blocked = fresh.length
    ? `이 변경으로 심각한 진단이 새로 ${fresh.length}건 생겨요 (${fresh.map((f) => f.title).slice(0, 2).join(", ")}). 적용하면 오히려 나빠져서 막았어요. 다른 안을 만들어 보세요.`
    : undefined;
  return { effects: effects.map((x) => ({ ...x, label: redactSecrets(x.label) })), blocked: blocked && redactSecrets(blocked) };
}

// ---- 조립 ----

export interface Built {
  planned: Planned;
  preview: FixPreview;
  archiveAbs: Record<string, string>; // 보관 후보 itemId -> 절대경로 (적용 때 체크한 것만 옮긴다)
  archiveHashes: Record<string, string>; // 미리 보기 때 보관 후보의 지문
}

export async function buildPreview(home: string, core: ScanCore, snap: Snapshot, req: FixRequest, env: ClaudeEnv): Promise<Built> {
  const t = resolveTarget(snap, req);
  let planned: Planned;
  let turnsOff: FixPreview["turnsOff"] = [];
  let candidates: FixPreview["candidates"] = [];
  let usage: FixPreview["usage"];
  const warnings: string[] = [];
  if (t.kind === "mechanical") {
    ({ planned, turnsOff } = mechanicalPlan(home, t));
  } else {
    if (!env.available) throw new ClaudeUnavailableError(env.reason);
    const job = claudeJobOf(home, t);
    const r = await planWithClaude(home, job);
    planned = r;
    usage = r.usage;
    warnings.push(...r.warnings);
    if (t.finding.rule === "unreachable-md") {
      // Claude가 고친 파일은 보관 후보에서 뺀다 (고친 것과 옮기는 것이 겹치지 않게)
      const written = new Set(r.writes.map((w) => w.abs.toLowerCase()));
      candidates = parseCandidates(home, r.resultText, t.entries).filter((c) => !written.has((t.entries.find((e) => e.item.id === c.itemId)?.abs ?? "").toLowerCase()));
    }
  }
  const before = analyze(home, core);
  const after = analyze(home, core, planned.overlay);
  const { effects, blocked } = effectsOf(home, before, after, planned);
  const archiveAbs: Record<string, string> = {};
  const archiveHashes: Record<string, string> = {};
  for (const c of candidates) {
    const abs = t.entries.find((e) => e.item.id === c.itemId)!.abs!;
    archiveAbs[c.itemId] = abs;
    archiveHashes[abs] = hashPath(abs);
  }
  const preview: FixPreview = {
    changes: planned.changes,
    effects,
    turnsOff,
    candidates,
    ...(usage ? { usage } : {}),
    warnings: warnings.map(redactSecrets),
    ...(blocked ? { blocked } : {}),
  };
  return { planned, preview, archiveAbs, archiveHashes };
}

// 적용할 계획: 미리 보기 계획에 사용자가 체크한 보관 후보 옮기기를 더한다. 그 밖의 id 는 무시한다
export function withArchive(home: string, b: Built, archive: unknown): Planned {
  const ids = Array.isArray(archive) ? b.preview.candidates.map((c) => c.itemId).filter((id) => (archive as unknown[]).includes(id)) : [];
  if (!ids.length) return b.planned;
  const mv = planMoveOff(home, ids.map((id) => b.archiveAbs[id]));
  const hashes = { ...b.planned.hashes, ...mv.hashes };
  for (const m of mv.moves) if (b.archiveHashes[m.from]) hashes[m.from] = b.archiveHashes[m.from]; // 미리 보기 때 지문으로 "그사이 바뀜"을 본다
  return {
    overlay: b.planned.overlay,
    changes: [...b.planned.changes, ...mv.changes],
    writes: b.planned.writes,
    moves: [...b.planned.moves, ...mv.moves],
    pluginKeys: b.planned.pluginKeys,
    hashes,
  };
}
