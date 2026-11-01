// 스냅샷에서 화면용 숫자와 묶음을 뽑는다. React 를 쓰지 않는 순수 함수만 둔다.
import type { ContextPart, Finding, Item, ItemKind, Snapshot, Source } from "../shared/types";
import { itemSourceName, sourceKey } from "./format";

export type SectionKey = "instruction" | "memory-index" | "memory" | "skill" | "agent" | "hook" | "mcp";
export type ViewMode = "groups" | "usage" | "idle";

export interface SectionDef {
  key: SectionKey;
  kinds: ItemKind[];
  noun: string; // 화면 제목에 쓰는 말
  contextKey?: ContextPart["key"];
  hasUsage: boolean; // 지시문·메모리 목차는 매번 읽혀서 "안 쓴 것"이 없다
}

export const SECTIONS: Record<SectionKey, SectionDef> = {
  instruction: { key: "instruction", kinds: ["instruction"], noun: "지시문", contextKey: "instructions", hasUsage: false },
  "memory-index": { key: "memory-index", kinds: ["memory-index"], noun: "메모리 목차", contextKey: "memory-index", hasUsage: false },
  memory: { key: "memory", kinds: ["memory"], noun: "메모리 파일", hasUsage: true },
  skill: { key: "skill", kinds: ["skill", "command"], noun: "작업 설명서", contextKey: "skills", hasUsage: true },
  agent: { key: "agent", kinds: ["agent"], noun: "에이전트", contextKey: "agents", hasUsage: true },
  hook: { key: "hook", kinds: ["hook"], noun: "자동 실행 규칙", contextKey: "hooks", hasUsage: true },
  mcp: { key: "mcp", kinds: ["mcp"], noun: "연결된 서비스", hasUsage: true },
};

export function isSectionKey(v: string | null | undefined): v is SectionKey {
  return !!v && v in SECTIONS;
}

export interface Model {
  snap: Snapshot;
  byId: Map<string, Item>;
  findingsById: Map<string, Finding>;
}

export function buildModel(snap: Snapshot): Model {
  return {
    snap,
    byId: new Map(snap.items.map((i) => [i.id, i])),
    findingsById: new Map(snap.findings.map((f) => [f.id, f])),
  };
}

/** 훅은 사용 횟수 대신 실행 횟수를 쓴다 */
export function usageOf(i: Item): number {
  return i.kind === "hook" ? (i.hook?.runs30 ?? i.usage.count30) : i.usage.count30;
}

/** 켜져 있는데 한 달 동안 한 번도 안 쓴 항목 */
export function isIdle(i: Item): boolean {
  return i.enabled && usageOf(i) === 0;
}

export function sectionItems(m: Model, key: SectionKey): Item[] {
  const kinds = SECTIONS[key].kinds;
  return m.snap.items.filter((i) => kinds.includes(i.kind));
}

export function contextPart(m: Model, key: SectionKey): ContextPart | undefined {
  const ck = SECTIONS[key].contextKey;
  return ck ? m.snap.context.parts.find((p) => p.key === ck) : undefined;
}

export interface SectionStats {
  total: number;
  used: number;
  idle: number;
  tokens: number; // 대화마다 미리 채워지는 양(추정). 해당 없으면 0
}

export function sectionStats(m: Model, key: SectionKey): SectionStats {
  const items = sectionItems(m, key).filter((i) => i.enabled);
  const used = items.filter((i) => usageOf(i) > 0).length;
  return { total: items.length, used, idle: items.length - used, tokens: contextPart(m, key)?.tokens ?? 0 };
}

/** 요약 카드의 "안 쓴 것" 배지용: 켜진 작업 설명서·명령·에이전트·서비스 중 0회 */
export function idleTotal(m: Model): number {
  return m.snap.items.filter(
    (i) => (i.kind === "skill" || i.kind === "command" || i.kind === "agent" || i.kind === "mcp") && isIdle(i),
  ).length;
}

export interface GroupCard {
  id: string;
  title: string;
  source: Source;
  items: Item[];
  used: number;
}

function byUsageThenName(a: Item, b: Item): number {
  return usageOf(b) - usageOf(a) || a.name.localeCompare(b.name);
}

/** 스캐너가 준 Group 을 화면 묶음으로 쓴다. 같은 출처의 작업 설명서와 명령은 한 카드로 합친다 */
export function groupCards(m: Model, key: SectionKey): GroupCard[] {
  const def = SECTIONS[key];
  const cards = new Map<string, GroupCard>();
  const placed = new Set<string>();
  const add = (k: string, id: string, title: string, source: Source, item: Item) => {
    let card = cards.get(k);
    if (!card) {
      card = { id, title, source, items: [], used: 0 };
      cards.set(k, card);
    }
    card.items.push(item);
    placed.add(item.id);
  };
  for (const g of m.snap.groups) {
    if (!def.kinds.includes(g.kind)) continue;
    for (const id of g.items) {
      const item = m.byId.get(id);
      if (item && !placed.has(id)) add(`${sourceKey(g.source)}|${g.title}`, g.id, g.title, g.source, item);
    }
  }
  for (const item of sectionItems(m, key)) {
    if (!placed.has(item.id)) add(`${sourceKey(item.source)}|${itemSourceName(item)}`, `x-${sourceKey(item.source)}`, itemSourceName(item), item.source, item);
  }
  const list = [...cards.values()];
  for (const c of list) {
    c.items.sort(byUsageThenName);
    c.used = c.items.filter((i) => usageOf(i) > 0).length;
  }
  return list.sort((a, b) => (b.used > 0 ? 1 : 0) - (a.used > 0 ? 1 : 0) || b.used - a.used || b.items.length - a.items.length);
}

export function usageList(m: Model, key: SectionKey): Item[] {
  return [...sectionItems(m, key)].sort(byUsageThenName);
}

/** 안 쓴 것은 대화마다 차지하는 글자가 많은 순 (정리 효과가 큰 것부터) */
export function idleList(m: Model, key: SectionKey): Item[] {
  return sectionItems(m, key)
    .filter(isIdle)
    .sort((a, b) => (b.alwaysLoaded?.chars ?? 0) - (a.alwaysLoaded?.chars ?? 0) || a.name.localeCompare(b.name));
}

export function itemsByIds(m: Model, ids: string[]): Item[] {
  return ids.map((id) => m.byId.get(id)).filter((i): i is Item => !!i);
}
