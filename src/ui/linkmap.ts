// 연결 그래프를 화면의 칸과 상자로 배치한다. React 를 쓰지 않는 순수 함수만 둔다.
import type { Item, MdEdge, MdGraph } from "../shared/types";

export interface LinkBox {
  folder: string;
  count: number; // 파일 수
  read30: number; // 그중 30일 안에 읽힌 파일 수
  ids: string[];
  lost: boolean; // 길 없음 칸의 상자
}

export interface LinkColumn {
  title: string;
  boxes: LinkBox[];
}

export const COLUMN_TITLES = ["출발점", "1단계", "2단계 이상", "길 없음"] as const;

/** 깊이 -> 칸 번호. 0 출발점, 1 한 단계, 2 이상 두 단계 이상, null 길 없음 */
export function columnOf(depth: number | null): number {
  if (depth === null) return 3;
  return Math.min(depth, 2);
}

/** 칸마다 메모리 폴더별로 묶는다. 항목 목록에 없는 노드는 열 수 없으니 뺀다. 큰 묶음이 위로 온다 */
export function layoutLinks(graph: MdGraph, items: Map<string, Item>): { columns: LinkColumn[] } {
  const cols: Map<string, LinkBox>[] = COLUMN_TITLES.map(() => new Map());
  for (const n of graph.nodes) {
    if (!items.has(n.id)) continue;
    const c = columnOf(n.depth);
    const m = cols[c]!;
    let box = m.get(n.folder);
    if (!box) m.set(n.folder, (box = { folder: n.folder, count: 0, read30: 0, ids: [], lost: c === 3 }));
    box.count++;
    if (n.read30 > 0) box.read30++;
    box.ids.push(n.id);
  }
  return {
    columns: COLUMN_TITLES.map((title, i) => ({
      title,
      boxes: [...cols[i]!.values()].sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder)),
    })),
  };
}

export interface LinkFlow {
  fromCol: number;
  fromBox: number;
  toCol: number;
  toBox: number;
  count: number;
  mentionOnly: boolean; // 이름 언급으로만 이어짐 (점선)
}

/** 칸 사이 길. 상자와 상자 사이의 선 하나로 합친다. 같은 칸이나 거슬러 가는 선은 그리지 않는다 */
export function flowsOf(graph: MdGraph, layout: { columns: LinkColumn[] }): LinkFlow[] {
  const where = new Map<string, [number, number]>();
  layout.columns.forEach((col, ci) => col.boxes.forEach((b, bi) => b.ids.forEach((id) => where.set(id, [ci, bi]))));
  const acc = new Map<string, LinkFlow>();
  for (const e of graph.edges) {
    const a = where.get(e.from);
    const b = where.get(e.to);
    if (!a || !b || a[0] >= b[0] || b[0] === 3) continue;
    const key = `${a}|${b}`;
    const f = acc.get(key);
    const mention = e.kind === "mention";
    if (f) {
      f.count++;
      f.mentionOnly &&= mention;
    } else acc.set(key, { fromCol: a[0], fromBox: a[1], toCol: b[0], toBox: b[1], count: 1, mentionOnly: mention });
  }
  return [...acc.values()];
}

export interface PathStep {
  id: string;
  via: MdEdge["kind"] | null; // 이 노드로 들어온 길 종류. 출발점은 null
}

/** 출발점에서 이 파일까지 가장 짧은 길. 길이 없으면 빈 배열 */
export function pathTo(graph: MdGraph, id: string): PathStep[] {
  const next = new Map<string, MdEdge[]>();
  for (const e of graph.edges) (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e);
  const prev = new Map<string, MdEdge | null>(graph.entries.map((x) => [x, null] as const));
  const queue = [...graph.entries];
  for (let i = 0; i < queue.length && !prev.has(id); i++) {
    for (const e of next.get(queue[i]!) ?? []) {
      if (prev.has(e.to)) continue;
      prev.set(e.to, e);
      queue.push(e.to);
    }
  }
  if (!prev.has(id)) return [];
  const steps: PathStep[] = [];
  for (let cur: string | undefined = id; cur !== undefined; ) {
    const e: MdEdge | null = prev.get(cur) ?? null;
    steps.push({ id: cur, via: e ? e.kind : null });
    cur = e?.from;
  }
  return steps.reverse();
}
