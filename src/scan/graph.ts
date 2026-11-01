// 연결 그래프와 연결 누수 (design.md 6절): md 문서가 AI에게 닿는 길을 본다.
import type { Item, Leaks, MdEdge, MdGraph, MdNode } from "../shared/types";
import type { Entry } from "./inventory";

// 노드는 지시문, 메모리 목차, 메모리 파일뿐이다. 작업 설명서·에이전트는 매번 실리는 목록으로 늘 닿는다
const NODE_KINDS = new Set(["instruction", "memory-index", "memory"]);
const START_KINDS = new Set(["instruction", "memory-index"]);
// 같은 쌍에 길이 여럿이면 앞에 있는 종류 하나만 남긴다
const KIND_ORDER: MdEdge["kind"][] = ["index", "import", "link", "mention"];

export const zeroLeaks = (): Leaks => ({ unreachable: 0, brokenLinks: 0, unread: 0, unusedTokens: 0 });

const folderOf = (path?: string): string => (path ? path.replace(/\/[^/]*$/, "") : "");

export function buildGraph(entries: Entry[], linkEdges: MdEdge[]): MdGraph {
  const nodes = entries.filter((e) => NODE_KINDS.has(e.item.kind));
  const ids = new Set(nodes.map((e) => e.item.id));

  // 두 끝이 모두 노드인 길만, 같은 쌍은 하나로
  const best = new Map<string, MdEdge>();
  for (const e of linkEdges) {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const k = `${e.from}\n${e.to}`;
    const cur = best.get(k);
    if (!cur || KIND_ORDER.indexOf(e.kind) < KIND_ORDER.indexOf(cur.kind)) best.set(k, { from: e.from, to: e.to, kind: e.kind });
  }
  const edges = [...best.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // 출발점: 매번 실리는 지시문과 MEMORY.md. 다른 지시문이 @import 로 불러 온 파일은 그 길로 닿는 것으로 본다
  const imported = new Set(edges.filter((e) => e.kind === "import").map((e) => e.to));
  const entryIds = nodes.filter((e) => START_KINDS.has(e.item.kind) && !imported.has(e.item.id)).map((e) => e.item.id);

  // 너비 우선 탐색으로 깊이를 센다
  const next = new Map<string, string[]>();
  for (const e of edges) (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  const depth = new Map<string, number>(entryIds.map((id) => [id, 0] as const));
  const queue = [...entryIds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const to of next.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(id)! + 1);
      queue.push(to);
    }
  }

  const out: MdNode[] = nodes.map((e) => ({
    id: e.item.id,
    depth: depth.get(e.item.id) ?? null,
    folder: folderOf(e.item.path),
    read30: e.item.usage.count30,
  }));
  return { entries: entryIds, nodes: out, edges };
}

// 누수 합계. broken = 끊긴 링크 개수, unusedTokens = 매번 실리는데 안 쓴 토큰(5절)
export function leaksOf(graph: MdGraph, items: Item[], unusedTokens: number, broken: number): Leaks {
  const kind = new Map(items.map((i) => [i.id, i.kind] as const));
  let unreachable = 0;
  let unread = 0;
  for (const n of graph.nodes) {
    if (n.depth == null) unreachable++;
    else if (kind.get(n.id) === "memory" && n.read30 === 0) unread++; // MEMORY.md 는 읽는 게 아니라 늘 실린다
  }
  return { unreachable, brokenLinks: broken, unread, unusedTokens };
}
