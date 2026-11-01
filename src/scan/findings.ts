// 진단 규칙 (design.md 6절). 문구는 비전문가용 해요체, 단정 대신 "~일 수 있어요".
import type { Finding, Severity } from "../shared/types";
import type { Entry, PluginEntry } from "./inventory";
import { MEMORY_INDEX_LINES } from "./inventory";
import { countLines, jaccard, normalizeLine, truncate, wordSet } from "./text";

export interface DiagnoseCtx {
  entries: Entry[];
  plugins: PluginEntry[];
  broken: Map<string, string[]>;
}

export const LONG_SKILL_CHARS = 20_000;
export const NEAR_LIMIT_LINES = 180;
export const SLOW_AVG_MS = 3000;
export const SLOW_MAX_MS = 10_000;
export const FAILING_HIGH = 3; // 기록에 남은 실패가 이 횟수 이상이면 높음
export const MIN_DUP_CHARS = 25;
export const SIMILAR_JACCARD = 0.5;

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const a4 = (tokens: number): string => (tokens / 1500).toFixed(1);

const sourceKey = (e: Entry): string => `${e.item.source.type}:${e.item.source.plugin ?? e.item.source.project ?? ""}`;
const sourceLabel = (e: Entry): string => {
  const s = e.item.source;
  return s.type === "user" ? "개인 설정" : s.type === "plugin" ? `플러그인 ${s.plugin}` : s.type === "project" ? `프로젝트 ${s.project}` : "기본 제공";
};
const shortName = (e: Entry): string => (e.item.source.type === "project" ? `${e.item.source.project}/${e.item.name}` : e.item.name);
const where = (e: Entry): string => {
  const s = e.item.source;
  return s.type === "project" ? `프로젝트 ${s.project} 의 ` : s.type === "user" ? "개인 " : "";
};
const kindWord = (k: string): string => (k === "agent" ? "에이전트" : k === "command" ? "명령" : "작업 설명서");

export function diagnose(ctx: DiagnoseCtx): Finding[] {
  const out: Finding[] = [];
  const counters = new Map<string, number>();
  const push = (rule: string, severity: Severity, f: Omit<Finding, "id" | "rule" | "severity" | "steps" | "prompt" | "command">) => {
    const n = (counters.get(rule) ?? 0) + 1;
    counters.set(rule, n);
    out.push({ id: `${rule}:${n}`, rule, severity, ...f, steps: [], prompt: "" }); // 할 일은 todo.ts 가 채운다
  };
  const { entries } = ctx;
  const byId = new Map(entries.map((e) => [e.item.id, e] as const));

  // memory-index-truncated / near-limit
  for (const e of entries) {
    if (e.item.kind !== "memory-index" || !e.text) continue;
    const lines = countLines(e.text);
    if (lines > MEMORY_INDEX_LINES) {
      push("memory-index-truncated", "high", {
        title: `${where(e)}MEMORY.md 가 ${lines}줄이라 뒷부분이 잘려요`,
        why: `AI는 MEMORY.md 의 앞 ${MEMORY_INDEX_LINES}줄만 읽어요. ${MEMORY_INDEX_LINES + 1}줄부터는 AI가 볼 수 없어서, 거기 적은 메모리는 쓰이지 않을 수 있어요.`,
        fix: `오래됐거나 덜 중요한 줄은 지우고, 자세한 내용은 메모리 파일로 옮겨서 MEMORY.md 를 ${MEMORY_INDEX_LINES}줄 아래로 줄여 주세요.`,
        items: [e.item.id],
        evidence: `${lines}줄 (한도 ${MEMORY_INDEX_LINES}줄), 잘리는 줄 ${lines - MEMORY_INDEX_LINES}개`,
      });
    } else if (lines >= NEAR_LIMIT_LINES) {
      push("memory-index-near-limit", "low", {
        title: `${where(e)}MEMORY.md 가 한도에 가까워요`,
        why: `AI는 MEMORY.md 의 앞 ${MEMORY_INDEX_LINES}줄까지만 읽어요. 조금만 더 늘면 뒷부분이 잘릴 수 있어요.`,
        fix: "더 이상 안 쓰는 줄을 정리하거나, 비슷한 항목을 한 줄로 합쳐 두면 좋아요.",
        items: [e.item.id],
        evidence: `${lines}줄 (한도 ${MEMORY_INDEX_LINES}줄)`,
      });
    }
  }

  // broken-link
  for (const e of entries) {
    const bad = ctx.broken.get(e.item.id);
    if (!bad?.length) continue;
    push("broken-link", "medium", {
      title: `${where(e)}${e.item.name} 에 없는 파일로 가는 링크가 ${bad.length}개 있어요`,
      why: "링크가 가리키는 메모리 파일이 없으면, AI가 그 내용을 찾지 못할 수 있어요.",
      fix: "파일을 다시 만들거나, 더 이상 필요 없으면 링크를 지워 주세요.",
      items: [e.item.id],
      evidence: `끊긴 링크 ${bad.length}개: ${truncate(bad.slice(0, 5).join(", "), 120)}${bad.length > 5 ? " 외" : ""}`,
    });
  }

  // orphan-memory (메모리 폴더마다 1건)
  const dirs = new Map<string, Entry[]>();
  for (const e of entries) if (e.memDir) (dirs.get(e.memDir) ?? dirs.set(e.memDir, []).get(e.memDir)!).push(e);
  for (const list of dirs.values()) {
    if (!list.some((e) => e.item.kind === "memory-index")) continue;
    const orphans = list.filter(
      (e) => e.item.kind === "memory" && !e.item.links.in.some((id) => byId.get(id)?.memDir),
    );
    if (!orphans.length) continue;
    const first = orphans[0];
    push("orphan-memory", "low", {
      title: `${where(first)}MEMORY.md 에 적히지 않은 메모리 파일이 ${orphans.length}개 있어요`,
      why: "AI는 MEMORY.md 에 적힌 목록을 보고 메모리를 찾아가요. 목록에 없고 다른 메모리에서도 안 이어진 파일은 거의 읽히지 않을 수 있어요.",
      fix: "MEMORY.md 에 한 줄씩 추가하거나, 필요 없는 파일은 지워 주세요.",
      items: orphans.map((e) => e.item.id),
      evidence: `${list.filter((e) => e.item.kind === "memory").length}개 중 ${orphans.length}개: ${truncate(orphans.slice(0, 3).map((e) => e.item.name).join(", "), 100)}${orphans.length > 3 ? " 외" : ""}`,
    });
  }

  // duplicate-rule (지시문·MEMORY.md 2곳 이상에 같은 줄)
  const lineMap = new Map<string, { ids: Set<string>; sample: string }>();
  for (const e of entries) {
    if ((e.item.kind !== "instruction" && e.item.kind !== "memory-index") || !e.text) continue;
    for (const raw of e.text.split("\n")) {
      const n = normalizeLine(raw);
      if (n.length < MIN_DUP_CHARS) continue;
      let r = lineMap.get(n);
      if (!r) lineMap.set(n, (r = { ids: new Set(), sample: raw.trim() }));
      r.ids.add(e.item.id);
    }
  }
  const dupGroups = new Map<string, { ids: string[]; samples: string[] }>();
  for (const r of lineMap.values()) {
    if (r.ids.size < 2) continue;
    const ids = [...r.ids].sort();
    const k = ids.join("|");
    let g = dupGroups.get(k);
    if (!g) dupGroups.set(k, (g = { ids, samples: [] }));
    g.samples.push(r.sample);
  }
  const dupList = [...dupGroups.values()].sort((a, b) => b.samples.length - a.samples.length || a.ids.join().localeCompare(b.ids.join()));
  for (const g of dupList.slice(0, 20)) {
    const names = g.ids.map((id) => (byId.get(id) ? shortName(byId.get(id)!) : id));
    push("duplicate-rule", "medium", {
      title: `같은 규칙이 ${g.ids.length}곳에 겹쳐 있어요 (${truncate(names.join(", "), 60)})`,
      why: "같은 말이 여러 곳에 있으면 한쪽만 고쳤을 때 서로 달라질 수 있어요. 컨텍스트도 그만큼 더 차지해요.",
      fix: "한 곳에만 남기고, 나머지는 지우거나 그곳을 가리키는 한 줄로 바꿔 주세요.",
      items: g.ids,
      evidence: `겹치는 줄 ${g.samples.length}개, 예: "${truncate(g.samples[0], 50)}"`,
    });
  }

  // duplicate-name (켜진 작업 설명서·에이전트, 출처 2곳 이상)
  const names = new Map<string, Entry[]>();
  for (const e of entries) {
    if ((e.item.kind !== "skill" && e.item.kind !== "agent") || !e.item.enabled || (e.item.source.type === "builtin" || e.item.source.type === "history")) continue;
    const k = `${e.item.kind}:${e.item.name.toLowerCase()}`;
    (names.get(k) ?? names.set(k, []).get(k)!).push(e);
  }
  for (const list of names.values()) {
    if (new Set(list.map(sourceKey)).size < 2) continue;
    const e0 = list[0];
    push("duplicate-name", "medium", {
      title: `같은 이름이 ${list.length}곳에 켜져 있어요: ${kindWord(e0.item.kind)} ${e0.item.name}`,
      why: "이름이 같으면 AI나 내가 부를 때 어느 쪽이 실행될지 헷갈릴 수 있어요.",
      fix: "안 쓰는 쪽을 끄거나 이름을 바꿔 주세요.",
      items: list.map((e) => e.item.id),
      evidence: `출처: ${[...new Set(list.map(sourceLabel))].join(", ")}`,
    });
  }

  // similar-description (켜진 작업 설명서끼리)
  const skills = entries.filter((e) => e.item.kind === "skill" && e.item.enabled && !e.secret && e.item.source.type !== "builtin" && e.item.source.type !== "history"); // 기록에만 있는 항목은 설명이 같은 안내 문구라 뺀다
  const sets = skills.map((e) => wordSet(e.wordsSource || e.item.summary));
  const sims: { a: number; b: number; j: number }[] = [];
  for (let i = 0; i < skills.length; i++) {
    if (sets[i].size < 6) continue;
    for (let j = i + 1; j < skills.length; j++) {
      if (sets[j].size < 6 || skills[i].item.name.toLowerCase() === skills[j].item.name.toLowerCase()) continue;
      const jc = jaccard(sets[i], sets[j]);
      if (jc >= SIMILAR_JACCARD) sims.push({ a: i, b: j, j: jc });
    }
  }
  sims.sort((x, y) => y.j - x.j);
  for (const s of sims.slice(0, 15)) {
    const A = skills[s.a];
    const B = skills[s.b];
    push("similar-description", "low", {
      title: `설명이 거의 같은 작업 설명서 두 개: ${A.item.name}, ${B.item.name}`,
      why: "설명이 비슷하면 AI가 둘 중 잘못 골라 쓸 수 있어요.",
      fix: "하나로 합치거나, 설명에 언제 쓰는지 차이를 적어 주세요.",
      items: [A.item.id, B.item.id],
      evidence: `설명 단어가 ${Math.round(s.j * 100)}% 겹쳐요`,
    });
  }

  // missing-description (출처마다 1건)
  const noDesc = new Map<string, Entry[]>();
  for (const e of entries) {
    if ((e.item.kind !== "skill" && e.item.kind !== "agent") || !e.item.enabled || e.secret || (e.item.source.type === "builtin" || e.item.source.type === "history")) continue;
    if (e.hasDescription) continue;
    (noDesc.get(sourceKey(e)) ?? noDesc.set(sourceKey(e), []).get(sourceKey(e))!).push(e);
  }
  for (const list of noDesc.values()) {
    push("missing-description", "medium", {
      title: `${sourceLabel(list[0])}에 설명이 없는 작업 설명서·에이전트가 ${list.length}개 있어요`,
      why: "AI는 설명을 보고 어떤 일에 쓸지 골라요. 설명이 없으면 필요할 때 제때 불리지 않을 수 있어요.",
      fix: "파일 맨 위에 description 한 줄을 적어 주세요. 언제 쓰는지 한 문장이면 충분해요.",
      items: list.map((e) => e.item.id),
      evidence: `${truncate(list.slice(0, 4).map((e) => e.item.name).join(", "), 100)}${list.length > 4 ? " 외" : ""}`,
    });
  }

  // unused-plugin / unused-items
  const pluginUnused = new Set<string>();
  for (const p of ctx.plugins) {
    if (!p.enabled) continue;
    const comps = entries.filter((e) => e.pluginKey === p.key && ["skill", "command", "agent", "mcp"].includes(e.item.kind));
    if (!comps.length) continue;
    if (comps.reduce((s, e) => s + e.item.usage.count30, 0) > 0) continue;
    // 자동 실행 규칙이 돌고 있으면 플러그인은 일하고 있다. 안 쓴 구성만 unused-items 로 보낸다
    const hooks = entries.filter((e) => e.pluginKey === p.key && e.item.kind === "hook");
    if (hooks.some((e) => e.item.usage.count30 > 0)) continue;
    pluginUnused.add(p.key);
    const n = (k: string) => comps.filter((e) => e.item.kind === k).length;
    const tokens = comps.reduce((s, e) => s + (e.item.alwaysLoaded?.tokens ?? 0), 0);
    push("unused-plugin", "medium", {
      title: `한 달 동안 한 번도 안 쓴 플러그인: ${p.name}`,
      why: "쓰지 않아도 켜져 있으면 이 플러그인의 목록이 대화마다 컨텍스트를 차지할 수 있어요.",
      fix: "앞으로도 안 쓸 것 같다면 플러그인을 끄거나 지워 주세요.",
      items: [p.item.id],
      evidence: `작업 설명서 ${n("skill")}개, 명령 ${n("command")}개, 에이전트 ${n("agent")}개, 연결된 서비스 ${n("mcp")}개 모두 30일 0회${tokens ? `, 대화마다 A4 약 ${a4(tokens)}쪽 차지` : ""}`,
    });
  }
  const unused = new Map<string, Entry[]>();
  const total = new Map<string, number>();
  for (const e of entries) {
    if (!["skill", "agent", "command"].includes(e.item.kind) || !e.item.enabled || (e.item.source.type === "builtin" || e.item.source.type === "history")) continue;
    if (e.pluginKey && pluginUnused.has(e.pluginKey)) continue;
    const k = sourceKey(e);
    total.set(k, (total.get(k) ?? 0) + 1);
    if (e.item.usage.count30 === 0) (unused.get(k) ?? unused.set(k, []).get(k)!).push(e);
  }
  for (const [k, list] of unused) {
    const tokens = list.reduce((s, e) => s + (e.item.alwaysLoaded?.tokens ?? 0), 0);
    push("unused-items", "low", {
      title: `${sourceLabel(list[0])}에서 한 달 동안 안 쓴 항목이 ${list.length}개 있어요`,
      why: "쓰지 않아도 켜져 있으면 목록 한 줄씩이 대화마다 컨텍스트를 차지할 수 있어요.",
      fix: "자주 쓰지 않는 것은 끄거나 지워서 컨텍스트를 아껴 보세요.",
      items: list.map((e) => e.item.id),
      evidence: `${total.get(k)}개 중 ${list.length}개가 30일 0회${tokens ? `, 대화마다 A4 약 ${a4(tokens)}쪽 차지` : ""}`,
    });
  }

  // long-skill
  for (const e of entries) {
    if (e.item.kind !== "skill" || !e.item.enabled || !e.body) continue;
    if (e.body.length <= LONG_SKILL_CHARS) continue;
    push("long-skill", "low", {
      title: `너무 긴 작업 설명서: ${e.item.name}`,
      why: "이 작업 설명서를 부를 때마다 전체를 읽어서 컨텍스트를 많이 쓸 수 있어요.",
      fix: "자주 안 쓰는 부분은 별도 파일로 빼고, 본문에는 핵심만 남겨 주세요.",
      items: [e.item.id],
      evidence: `본문 ${e.body.length.toLocaleString("en-US")}자 (기준 ${LONG_SKILL_CHARS.toLocaleString("en-US")}자), 부를 때마다 A4 약 ${a4(e.item.size.tokens)}쪽을 읽어요`,
    });
  }

  // slow-hook / failing-hook
  for (const e of entries) {
    const h = e.item.hook;
    if (!h || !e.item.enabled || h.runs30 === 0) continue;
    if (h.avgMs >= SLOW_AVG_MS || h.maxMs >= SLOW_MAX_MS) {
      push("slow-hook", "medium", {
        title: `자동 실행 규칙 하나가 느려요: ${e.item.name}`,
        why: "이 규칙은 정해진 때마다 자동으로 실행돼서, 느리면 그때마다 기다리게 될 수 있어요.",
        fix: "하는 일을 줄이거나, 오래 걸리는 부분은 백그라운드로 돌리도록 바꿔 보세요.",
        items: [e.item.id],
        evidence: `평균 ${(h.avgMs / 1000).toFixed(1)}초, 최대 ${(h.maxMs / 1000).toFixed(1)}초 (기록에 남은 실행 ${h.runs30}번 기준)`,
      });
    }
    // Claude Code 는 성공한 실행을 다 기록하지 않아 실패율을 못 낸다. 실패 횟수로만 나눈다
    if (h.failures30 >= 1) {
      push("failing-hook", h.failures30 >= FAILING_HIGH ? "high" : "medium", {
        title: `자동 실행 규칙 하나가 실패했어요: ${e.item.name}`,
        why: "실패하면 원래 하려던 일이 빠지거나, 오류 메시지가 대화에 끼어들 수 있어요.",
        fix: "명령을 터미널에서 직접 실행해 오류를 확인하고, 경로나 설치 상태를 점검해 주세요.",
        items: [e.item.id],
        evidence: `최근 30일 기록에 남은 실패 ${h.failures30}번. 한 번뿐이면 그때만의 일시적인 문제일 수도 있어요`,
      });
    }
  }

  out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return out;
}
