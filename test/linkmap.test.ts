import { describe, expect, test } from "bun:test";
import type { Item, MdGraph } from "../src/shared/types";
import { layoutLinks, flowsOf, pathTo } from "../src/ui/linkmap";

const item = (id: string): Item => ({ id }) as Item;
const items = (ids: string[]) => new Map(ids.map((id) => [id, item(id)] as const));

const graph: MdGraph = {
  entries: ["claude", "idx-a"],
  nodes: [
    { id: "claude", depth: 0, folder: "~/.claude", read30: 0 },
    { id: "idx-a", depth: 0, folder: "~/.claude/projects/a/memory", read30: 0 },
    { id: "a1", depth: 1, folder: "~/.claude/projects/a/memory", read30: 3 },
    { id: "a2", depth: 1, folder: "~/.claude/projects/a/memory", read30: 0 },
    { id: "a3", depth: 2, folder: "~/.claude/projects/a/memory", read30: 1 },
    { id: "a4", depth: 3, folder: "~/.claude/projects/a/memory", read30: 0 },
    { id: "g1", depth: 1, folder: "~/.claude/notes", read30: 2 },
    { id: "lost1", depth: null, folder: "~/.claude/projects/a/memory", read30: 0 },
    { id: "lost2", depth: null, folder: "~/.claude/projects/a/memory", read30: 1 },
    { id: "lost3", depth: null, folder: "~/.claude/memory", read30: 0 },
  ],
  edges: [
    { from: "idx-a", to: "a1", kind: "index" },
    { from: "idx-a", to: "a2", kind: "index" },
    { from: "claude", to: "g1", kind: "import" },
    { from: "a1", to: "a3", kind: "link" },
    { from: "a2", to: "a4", kind: "mention" },
    { from: "a3", to: "a4", kind: "mention" },
    { from: "a4", to: "a1", kind: "link" },
  ],
};
const all = items(graph.nodes.map((n) => n.id));

describe("layoutLinks", () => {
  const { columns } = layoutLinks(graph, all);

  test("칸은 출발점, 1단계, 2단계 이상, 길 없음 순서로 늘 네 개", () => {
    expect(columns.map((c) => c.title)).toEqual(["출발점", "1단계", "2단계 이상", "길 없음"]);
    expect(layoutLinks({ entries: [], nodes: [], edges: [] }, new Map()).columns.map((c) => c.boxes.length)).toEqual([0, 0, 0, 0]);
  });

  test("깊이 3 이상은 2단계 이상 칸에 들어간다", () => {
    expect(columns[2]!.boxes.map((b) => b.ids).flat().sort()).toEqual(["a3", "a4"]);
  });

  test("칸 안은 폴더별로 묶고 큰 묶음이 먼저 온다", () => {
    expect(columns[0]!.boxes.map((b) => [b.folder, b.count])).toEqual([
      ["~/.claude", 1],
      ["~/.claude/projects/a/memory", 1],
    ]);
    expect(columns[1]!.boxes.map((b) => [b.folder, b.count])).toEqual([
      ["~/.claude/projects/a/memory", 2],
      ["~/.claude/notes", 1],
    ]);
  });

  test("읽힌 파일 수를 센다", () => {
    expect(columns[1]!.boxes[0]!.read30).toBe(1); // a1 만 읽힘
    expect(columns[3]!.boxes[0]!.read30).toBe(1); // lost2
  });

  test("길 없음 칸의 상자만 lost 이다", () => {
    expect(columns.map((c) => c.boxes.every((b) => b.lost))).toEqual([false, false, false, true]);
    expect(columns[3]!.boxes.map((b) => [b.folder, b.count])).toEqual([
      ["~/.claude/projects/a/memory", 2],
      ["~/.claude/memory", 1],
    ]);
  });

  test("항목 목록에 없는 노드는 뺀다", () => {
    const some = items(["claude", "a1"]);
    const { columns: c } = layoutLinks(graph, some);
    expect(c.flatMap((x) => x.boxes).reduce((n, b) => n + b.count, 0)).toBe(2);
  });
});

describe("flowsOf", () => {
  const layout = layoutLinks(graph, all);
  const flows = flowsOf(graph, layout);

  test("앞 칸에서 뒤 칸으로 가는 길만 상자 단위로 합친다", () => {
    // idx-a(0,1) -> a1,a2 (1,0) 는 한 줄, 거슬러 가는 a4 -> a1 과 같은 칸 길은 없다
    const f = flows.find((x) => x.fromCol === 0 && x.fromBox === 1 && x.toCol === 1 && x.toBox === 0)!;
    expect(f.count).toBe(2);
    expect(f.mentionOnly).toBe(false);
    expect(flows.some((x) => x.fromCol >= x.toCol)).toBe(false);
  });

  test("언급으로만 이어진 길은 mentionOnly", () => {
    const f = flows.find((x) => x.toCol === 2)!;
    expect(f.mentionOnly).toBe(false); // a1 -> a3 는 link 라서 합친 줄은 실선
    const m = flowsOf({ ...graph, edges: [{ from: "a2", to: "a4", kind: "mention" }] }, layout);
    expect(m).toHaveLength(1);
    expect(m[0]!.mentionOnly).toBe(true);
  });
});

describe("pathTo", () => {
  test("출발점에서 가장 짧은 길과 길 종류", () => {
    expect(pathTo(graph, "a3")).toEqual([
      { id: "idx-a", via: null },
      { id: "a1", via: "index" },
      { id: "a3", via: "link" },
    ]);
  });
  test("출발점 자신은 한 걸음, 길 없는 파일은 빈 배열", () => {
    expect(pathTo(graph, "claude")).toEqual([{ id: "claude", via: null }]);
    expect(pathTo(graph, "lost1")).toEqual([]);
  });
});
