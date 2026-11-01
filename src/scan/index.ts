// 스캐너 진입점: scan(home, opts) => Snapshot
import { join } from "node:path";
import type { ContextPart, Group, Item, ItemKind, Progress, Snapshot, Source } from "../shared/types";
import { diagnose } from "./findings";
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
const SOURCE_ORDER = { user: 0, project: 1, plugin: 2, builtin: 3 } as const;
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

  for (const [key, acc] of ux.counters) {
    const tag = key.slice(0, 2);
    const name = key.slice(2);
    let target: Entry | undefined;
    let via: "user" | "model" | undefined;
    if (tag === "S|") (target = skillish(name)), (via = "model");
    else if (tag === "U|") (target = skillish(name)), (via = "user");
    else if (tag === "A|") (target = agentOf(name)), (via = "model");
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
      const title = single ? "플러그인" : s.type === "user" ? "개인" : s.type === "builtin" ? "기본 제공" : s.type === "plugin" ? (s.plugin ?? "플러그인") : (s.project ?? "프로젝트");
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
  const findings = diagnose({ entries: inv.entries, plugins: inv.plugins, broken });
  for (const f of findings) {
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

  const snap: Snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
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
    context: buildContext(inv.entries, ux),
    items,
    groups: buildGroups(items),
    findings,
    warnings,
  };
  emit({ phase: "done", filesDone: tr.files.length, filesTotal: tr.files.length });
  return snap;
}
