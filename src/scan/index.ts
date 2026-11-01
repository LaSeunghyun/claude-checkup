// 스캐너 진입점: scan(home, opts) => Snapshot
import { join } from "node:path";
import type { Category, ContextPart, Group, HistorySummary, Item, ItemKind, Leaks, Progress, Snapshot, Source } from "../shared/types";
import { diagnose } from "./findings";
import { todoFor } from "./todo";
import { claudeRelKey, redactSecrets, slash } from "./fsutil";
import { buildInventory, type Entry, type Inventory } from "./inventory";
import { buildLinks } from "./links";
import { aggregate, hookKey, loadTranscripts, windowDays, type Acc, type UsageIndex } from "./transcripts";

export type { Progress };

export interface ScanOpts {
  now?: Date;
  onProgress?: (p: Progress) => void;
  cache?: boolean; // 기본 true. 캐시 위치는 HOME/.claude-checkup/cache.json
  concurrency?: number;
}

const KIND_ORDER: ItemKind[] = ["instruction", "memory-index", "memory", "skill", "command", "agent", "hook", "mcp", "plugin"];
const SOURCE_ORDER = { user: 0, project: 1, plugin: 2, builtin: 3, history: 4 } as const;
const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

const sourceKey = (s: Source) => `${s.type}:${s.plugin ?? s.project ?? ""}`;

function addUsage(item: Item, acc: Acc, via?: "user" | "model") {
  const u = item.usage;
  const c30 = acc.d30.reduce((a, b) => a + b, 0);
  u.countAll += acc.all;
  u.count30 += c30;
  acc.d30.forEach((n, i) => (u.daily30[i] += n));
  if (acc.last && (!u.lastUsed || acc.last > u.lastUsed)) u.lastUsed = acc.last;
  if (via) {
    u.via ??= {};
    u.via[via] = (u.via[via] ?? 0) + c30;
  }
}

function applyUsage(inv: Inventory, ux: UsageIndex) {
  const { entries } = inv;
  const rank = (e: Entry) => {
    const s = e.item.source.type;
    return (s === "user" ? 0 : s === "project" ? 1 : s === "plugin" ? (e.item.enabled ? 2 : 3) : 4) * 2 + (e.item.kind === "command" ? 1 : 0);
  };
  const invMap = (kinds: ItemKind[]) => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!kinds.includes(e.item.kind)) continue;
      for (const n of e.inv) (m.get(n) ?? m.set(n, []).get(n)!).push(e);
    }
    return (name: string): Entry | undefined => m.get(name.toLowerCase())?.slice().sort((a, b) => rank(a) - rank(b))[0];
  };
  const skillish = invMap(["skill", "command"]);
  const agentOf = invMap(["agent"]);

  const mcp = new Map<string, Entry>();
  for (const e of [...entries].sort((a, b) => rank(a) - rank(b))) {
    if (e.item.kind !== "mcp") continue;
    const s = e.item.source;
    const key = s.type === "plugin" ? `plugin_${norm(s.plugin ?? "")}_${norm(e.item.name)}` : norm(e.item.name);
    if (!mcp.has(key.toLowerCase())) mcp.set(key.toLowerCase(), e);
  }

  const reads = new Map<string, Entry>();
  for (const e of entries) {
    if (!e.abs || !["instruction", "memory-index", "memory"].includes(e.item.kind)) continue;
    const rel = claudeRelKey(e.abs);
    reads.set(rel != null ? "c:" + rel : "p:" + slash(e.abs).toLowerCase(), e);
  }

  // 기록에는 있는데 .claude 에 파일이 없는 작업 설명서·에이전트는 "기록에만 있음"(history) 항목으로 만든다.
  // Claude Code 기본 내장일 수도, 지웠거나 이름이 바뀐 것일 수도 있어 둘을 가르지 않는다.
  // `플러그인:이름` 꼴은 지금 없는 플러그인이라 만들지 않는다. 직접 부른 명령(U|)은 /model 같은 내장 명령이 섞여 만들지 않는다
  const builtins = new Map<string, Entry>();
  const builtinOf = (kind: "skill" | "agent", name: string): Entry | undefined => {
    if (name.includes(":") || !/^[\w-]+$/.test(name)) return undefined;
    const id = `${kind}:history::${name.toLowerCase()}`;
    let e = builtins.get(id);
    if (!e) {
      const item: Item = {
        id, kind, name, source: { type: "history" },
        summary: "대화 기록에는 쓴 흔적이 있지만 지금 .claude 폴더에는 파일이 없어요. Claude Code에 기본으로 들어 있거나, 지웠거나, 이름이 바뀐 항목일 수 있어요.",
        outline: [], size: { chars: 0, lines: 0, tokens: 0 }, alwaysLoaded: null, enabled: true,
        usage: { count30: 0, countAll: 0, daily30: Array(30).fill(0) }, links: { out: [], in: [] }, findings: [],
      };
      builtins.set(id, (e = { item, inv: [name.toLowerCase()] }));
      entries.push(e);
    }
    return e;
  };

  // 먼저 AI가 부른 이름으로 기본 제공 항목을 만들어 둬야, 같은 이름을 직접 부른 기록(U|)도 거기에 붙는다
  for (const [key, acc] of ux.counters) {
    if (!acc.d30.some((n) => n > 0)) continue; // 30일 안에 쓴 것만. 오래전 기록만 있는 이름은 지금 판단에 쓸모가 없다
    const name = key.slice(2);
    if (key.startsWith("S|") && !skillish(name)) builtinOf("skill", name);
    if (key.startsWith("A|") && !agentOf(name)) builtinOf("agent", name);
  }
  const builtinSkill = (name: string) => builtins.get(`skill:history::${name.toLowerCase()}`);

  for (const [key, acc] of ux.counters) {
    const tag = key.slice(0, 2);
    const name = key.slice(2);
    let target: Entry | undefined;
    let via: "user" | "model" | undefined;
    if (tag === "S|") (target = skillish(name) ?? builtinSkill(name)), (via = "model");
    else if (tag === "U|") (target = skillish(name) ?? builtinSkill(name)), (via = "user");
    else if (tag === "A|") (target = agentOf(name) ?? builtins.get(`agent:history::${name.toLowerCase()}`)), (via = "model");
    else if (tag === "M|") target = mcp.get(name.toLowerCase());
    else if (tag === "R|") target = reads.get(name);
    if (target) addUsage(target.item, acc, via);
  }

  // 훅
  for (const e of entries) {
    const h = e.item.hook;
    if (!h || !e.rawCmd) continue;
    const a = ux.hooks.get(hookKey(h.event, e.rawCmd));
    if (!a) continue;
    h.runs30 = a.runs30;
    h.avgMs = a.runs30 ? Math.round(a.sumMs30 / a.runs30) : 0;
    h.maxMs = a.maxMs30;
    h.failures30 = a.fail30;
    h.blocked30 = a.blocked30;
    if (a.injN30) h.injectedCharsAvg = Math.round(a.injChars30 / a.injN30);
    e.item.usage = { count30: a.runs30, countAll: a.all, daily30: a.d30.slice(), ...(a.last ? { lastUsed: a.last } : {}) };
  }

  // 플러그인은 구성 사용량의 합
  const byKey = new Map<string, Entry>();
  for (const p of inv.plugins) {
    const pe = entries.find((e) => e.item === p.item);
    if (pe) byKey.set(p.key, pe);
  }
  for (const e of entries) {
    if (!e.pluginKey || e.item.kind === "plugin" || e.item.kind === "hook") continue;
    const pe = byKey.get(e.pluginKey);
    if (!pe) continue;
    const u = e.item.usage;
    addUsage(pe.item, { all: u.countAll, d30: u.daily30, last: u.lastUsed });
  }
}

function buildContext(entries: Entry[], ux: UsageIndex): Snapshot["context"] {
  const parts: ContextPart[] = [];
  const sum = (f: (e: Entry) => boolean, unusedOnly = false) =>
    entries.reduce((s, e) => (f(e) && e.item.enabled && e.item.alwaysLoaded && (!unusedOnly || e.item.usage.count30 === 0) ? s + e.item.alwaysLoaded.tokens : s), 0);

  parts.push({
    key: "instructions",
    label: "전역 CLAUDE.md",
    tokens: sum((e) => e.item.kind === "instruction" && e.item.source.type === "user"),
    unusedTokens: 0,
  });
  // MEMORY.md 는 프로젝트마다 따로 있고 한 대화에는 하나만 실리므로 가장 큰 것을 기준으로 한다
  const idx = entries.filter((e) => e.item.kind === "memory-index" && e.item.alwaysLoaded);
  const biggest = Math.max(0, ...idx.map((e) => e.item.alwaysLoaded!.tokens));
  parts.push({ key: "memory-index", label: idx.length > 1 ? "MEMORY.md (프로젝트 하나 기준, 가장 큰 것)" : "MEMORY.md", tokens: biggest, unusedTokens: 0 });
  parts.push({
    key: "skills",
    label: "작업 설명서·명령 목록",
    tokens: sum((e) => e.item.kind === "skill" || e.item.kind === "command"),
    unusedTokens: sum((e) => e.item.kind === "skill" || e.item.kind === "command", true),
  });
  parts.push({
    key: "agents",
    label: "에이전트 목록",
    tokens: sum((e) => e.item.kind === "agent"),
    unusedTokens: sum((e) => e.item.kind === "agent", true),
  });
  const ss = ux.events.get("SessionStart");
  parts.push({ key: "hooks", label: "자동 실행 규칙이 시작할 때 넣는 글", tokens: ss && ss.n ? Math.round(ss.tokens / ss.n) : 0, unusedTokens: 0 });
  return {
    budgetTokens: 200000,
    totalTokens: parts.reduce((s, p) => s + p.tokens, 0),
    unusedTokens: parts.reduce((s, p) => s + p.unusedTokens, 0),
    parts,
  };
}

function buildGroups(items: Item[]): Group[] {
  const map = new Map<string, Group>();
  for (const it of items) {
    const s = it.source;
    const single = it.kind === "plugin";
    const key = single ? "group:plugin" : `group:${it.kind}:${sourceKey(s)}`.toLowerCase();
    let g = map.get(key);
    if (!g) {
      const title = single ? "플러그인" : s.type === "user" ? "개인" : s.type === "builtin" ? "기본 제공" : s.type === "history" ? "기록에만 있음" : s.type === "plugin" ? (s.plugin ?? "플러그인") : (s.project ?? "프로젝트");
      map.set(key, (g = { id: key, kind: it.kind, title, source: single ? { type: "plugin" } : s, items: [] }));
    }
    g.items.push(it.id);
  }
  return [...map.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      SOURCE_ORDER[a.source.type] - SOURCE_ORDER[b.source.type] ||
      a.title.localeCompare(b.title),
  );
}

const zeroLeaks = (): Leaks => ({ unreachable: 0, brokenLinks: 0, unread: 0, unusedTokens: 0 });

const CATEGORIES: Category[] = ["risk", "broken", "leak", "waste", "confusion"];

// 전후 비교와 기록에 쓰는 요약. Task 4 가 이 함수를 옮긴다
export function summaryOf(s: Pick<Snapshot, "generatedAt" | "context" | "findings" | "leaks">): HistorySummary {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const f of s.findings) byCategory[f.category]++;
  return {
    at: s.generatedAt,
    totalTokens: s.context.totalTokens,
    unusedTokens: s.context.unusedTokens,
    leaks: { ...s.leaks },
    byCategory,
  };
}

export async function scan(home: string, opts: ScanOpts = {}): Promise<Snapshot> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const emit = (p: Progress) => opts.onProgress?.(p);
  emit({ phase: "inventory", filesDone: 0, filesTotal: 0, message: "설정을 읽는 중이에요" });

  const inv = buildInventory(home);
  const warnings = [...inv.warnings];
  const days = windowDays(now);

  const claudeDir = join(home, ".claude");
  let lastEmit = 0;
  const tr = await loadTranscripts(claudeDir, {
    cachePath: opts.cache === false ? null : join(home, ".claude-checkup", "cache.json"),
    concurrency: opts.concurrency,
    onFile: (done, total) => {
      const t = Date.now();
      if (done === 0 || done === total || t - lastEmit > 100) {
        lastEmit = t;
        emit({ phase: "transcripts", filesDone: done, filesTotal: total, message: "대화 기록을 읽는 중이에요" });
      }
    },
  });
  warnings.push(...tr.warnings);

  emit({ phase: "diagnose", filesDone: tr.files.length, filesTotal: tr.files.length, message: "진단하는 중이에요" });
  const ux = aggregate(tr.files, days);
  applyUsage(inv, ux);
  const { broken } = buildLinks(inv.entries, inv.plugins);
  const dctx = { entries: inv.entries, plugins: inv.plugins, broken };
  const findings = diagnose(dctx);
  const entryById = new Map(inv.entries.map((e) => [e.item.id, e] as const));
  for (const f of findings) {
    const t = todoFor(f, dctx, entryById);
    f.steps = t.steps.map(redactSecrets);
    f.prompt = redactSecrets(t.prompt);
    if (t.command) f.command = redactSecrets(t.command);
    f.title = redactSecrets(f.title);
    f.evidence = redactSecrets(f.evidence);
  }

  const byId = new Map(inv.entries.map((e) => [e.item.id, e.item] as const));
  for (const f of findings) for (const id of f.items) byId.get(id)?.findings.push(f.id);

  const items = inv.entries
    .map((e) => e.item)
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        SOURCE_ORDER[a.source.type] - SOURCE_ORDER[b.source.type] ||
        (a.source.plugin ?? a.source.project ?? "").localeCompare(b.source.plugin ?? b.source.project ?? "") ||
        a.name.localeCompare(b.name),
    );

  const generatedAt = new Date().toISOString();
  const context = buildContext(inv.entries, ux);
  const leaks = zeroLeaks(); // Task 3 이 채운다
  const snap: Snapshot = {
    version: 1,
    generatedAt,
    home: "~",
    window: { from: new Date(`${days[0]}T00:00:00`).toISOString(), to: now.toISOString(), days: 30 },
    stats: {
      sessions30: ux.sessions30,
      prompts30: ux.prompts30,
      toolCalls30: ux.tools30,
      transcriptsScanned: tr.files.length,
      bytesScanned: tr.bytes,
      durationMs: Date.now() - t0,
    },
    context,
    items,
    groups: buildGroups(items),
    findings,
    graph: { entries: [], nodes: [], edges: [] }, // Task 3 이 채운다
    leaks,
    summary: summaryOf({ generatedAt, context, findings, leaks }),
    warnings,
  };
  emit({ phase: "done", filesDone: tr.files.length, filesTotal: tr.files.length });
  return snap;
}
