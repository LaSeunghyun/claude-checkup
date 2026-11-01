import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scan";
import { buildGraph, leaksOf } from "../src/scan/graph";
import { buildInventory, type Inventory } from "../src/scan/inventory";
import { buildLinks } from "../src/scan/links";
import type { Item, MdGraph } from "../src/shared/types";
import { buildHomeFrom } from "./fixtures/build";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// 파일 표대로 임시 홈을 만든다
function homeWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cc-graph-"));
  dirs.push(d);
  return buildHomeFrom(d, files);
}

const MEM = ".claude/projects/C--p/memory";

function graphOf(home: string): { inv: Inventory; graph: MdGraph; broken: Map<string, string[]> } {
  const inv = buildInventory(home);
  const { edges, broken } = buildLinks(inv.entries, inv.plugins, home);
  return { inv, graph: buildGraph(inv.entries, edges), broken };
}
const idOf = (inv: Inventory, name: string): string => {
  const e = inv.entries.find((x) => x.item.name === name && ["instruction", "memory-index", "memory"].includes(x.item.kind));
  if (!e) throw new Error(`항목 없음: ${name}`);
  return e.item.id;
};
const depth = (g: { inv: Inventory; graph: MdGraph }, name: string): number | null => {
  const n = g.graph.nodes.find((x) => x.id === idOf(g.inv, name));
  if (!n) throw new Error(`노드 없음: ${name}`);
  return n.depth;
};

describe("연결 그래프", () => {
  test("출발점에서 깊이를 센다", () => {
    const g = graphOf(
      homeWith({
        [`${MEM}/MEMORY.md`]: "# 목차\n- [A](a.md) - 첫째\n",
        [`${MEM}/a.md`]: "둘째로 가는 [B](b.md)\n",
        [`${MEM}/b.md`]: "끝\n",
        [`${MEM}/c.md`]: "외톨이\n",
      }),
    );
    expect(depth(g, "MEMORY.md")).toBe(0);
    expect(depth(g, "a.md")).toBe(1);
    expect(depth(g, "b.md")).toBe(2);
    expect(depth(g, "c.md")).toBeNull();
    expect(g.graph.entries).toEqual([idOf(g.inv, "MEMORY.md")]);
    const kinds = g.graph.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);
    expect(kinds).toContain(`${idOf(g.inv, "MEMORY.md")}>${idOf(g.inv, "a.md")}:index`);
    expect(kinds).toContain(`${idOf(g.inv, "a.md")}>${idOf(g.inv, "b.md")}:link`);
  });

  test("노드는 지시문, 목차, 메모리 파일만이고 깊이는 폴더와 읽힌 횟수를 함께 담는다", () => {
    const g = graphOf(
      homeWith({
        ".claude/CLAUDE.md": "# 전역\n",
        ".claude/skills/s/SKILL.md": "---\nname: s\ndescription: 작업 설명서 하나예요.\n---\n본문\n",
        [`${MEM}/MEMORY.md`]: "- [A](a.md)\n",
        [`${MEM}/a.md`]: "a\n",
      }),
    );
    const byId = new Map(g.inv.entries.map((e) => [e.item.id, e.item] as const));
    for (const n of g.graph.nodes) expect(["instruction", "memory-index", "memory"]).toContain(byId.get(n.id)!.kind);
    expect(g.graph.nodes).toHaveLength(3);
    const a = g.graph.nodes.find((n) => n.id === idOf(g.inv, "a.md"))!;
    expect(a.folder).toBe("~/.claude/projects/C--p/memory");
    expect(a.read30).toBe(0);
    expect(g.graph.entries.sort()).toEqual([idOf(g.inv, "CLAUDE.md"), idOf(g.inv, "MEMORY.md")].sort());
  });

  test("이름만 적힌 목차도 길이다", () => {
    const g = graphOf(
      homeWith({
        [`${MEM}/MEMORY.md`]: "# 목차\n- 이름만 적은 메모리: named-only (링크 없음)\n",
        [`${MEM}/named-only.md`]: "본문\n",
      }),
    );
    expect(depth(g, "named-only.md")).toBe(1);
    const e = g.graph.edges.find((x) => x.to === idOf(g.inv, "named-only.md"))!;
    expect(e.kind).toBe("index");
    expect(e.from).toBe(idOf(g.inv, "MEMORY.md"));
  });

  test("본문에 파일 이름이 나오면 언급 길이고, 다른 폴더의 같은 이름 파일과는 이어지지 않는다", () => {
    const g = graphOf(
      homeWith({
        [`${MEM}/MEMORY.md`]: "- [A](a.md)\n",
        [`${MEM}/a.md`]: "자세한 건 `mentioned.md` 를 보세요.\n",
        [`${MEM}/mentioned.md`]: "언급된 파일\n",
        ".claude/memory/mentioned.md": "다른 폴더의 같은 이름\n",
      }),
    );
    const same = g.inv.entries.find((e) => e.item.name === "mentioned.md" && e.item.path!.includes("projects"))!;
    const other = g.inv.entries.find((e) => e.item.name === "mentioned.md" && !e.item.path!.includes("projects"))!;
    const dep = (id: string) => g.graph.nodes.find((n) => n.id === id)!.depth;
    expect(dep(same.item.id)).toBe(2);
    expect(g.graph.edges.find((x) => x.to === same.item.id)!.kind).toBe("mention");
    expect(dep(other.item.id)).toBeNull();
  });

  test("목차 없는 폴더", async () => {
    const home = homeWith({ ".claude/memory/x.md": "목차가 없는 폴더의 파일\n" });
    const g = graphOf(home);
    expect(depth(g, "x.md")).toBeNull();
    const s = await scan(home, { cache: false });
    const f = s.findings.filter((x) => x.rule === "unreachable-md");
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toContain("목차 파일이 없는 폴더");
    expect(f[0].items).toEqual([idOf(g.inv, "x.md")]);
  });

  // 7: ~/.claude/memory 처럼 Claude Code 가 메모리로 읽지 않는 폴더에는 MEMORY.md 를 만들어도 닿지 않는다
  test("읽히지 않는 폴더(~/.claude/memory)의 목차 없음은 직접 하는 안내(manual)로 바뀐다", async () => {
    const home = homeWith({ ".claude/memory/x.md": "목차가 없는 폴더의 파일\n" });
    const s = await scan(home, { cache: false });
    const f = s.findings.find((x) => x.rule === "unreachable-md")!;
    expect(f.fixKind).toBe("manual");
    const steps = f.steps.join("\n");
    expect(steps).toContain("전역 CLAUDE.md");
    expect(steps).toContain("~/.claude/projects/<프로젝트>/memory/");
    expect(steps).not.toContain("MEMORY.md 가 없어요. 같은 폴더에 새로 만들어요");
    expect(f.prompt).toContain("전역 CLAUDE.md");
    expect(f.prompt).toContain("~/.claude/projects/<프로젝트>/memory/");
    expect(f.prompt).not.toContain("MEMORY.md 를 새로 만들어");
    expect(f.fix).not.toContain("MEMORY.md 에 한 줄씩 적어서 이어"); // 만들어도 안 닿는 방법은 권하지 않는다
  });

  test("프로젝트 메모리 폴더(~/.claude/projects/*/memory)에 MEMORY.md 가 없으면 만들라는 기존 안내(claude)를 유지한다", async () => {
    const home = homeWith({ [`${MEM}/x.md`]: "목차가 없는 프로젝트 메모리\n" });
    const s = await scan(home, { cache: false });
    const f = s.findings.find((x) => x.rule === "unreachable-md")!;
    expect(f.evidence).toContain("목차 파일이 없는 폴더");
    expect(f.fixKind).toBe("claude");
    expect(f.steps.join("\n")).toContain("MEMORY.md 가 없어요. 같은 폴더에 새로 만들어요");
    expect(f.prompt).toContain("MEMORY.md 가 없어서");
    expect(f.steps.join("\n")).not.toContain("전역 CLAUDE.md");
  });

  test("전역 CLAUDE.md 에 ~/ 경로를 적으면 언급 길이 생겨 닿는다 (읽히지 않는 폴더의 직접 해결 방법)", () => {
    const g = graphOf(
      homeWith({
        ".claude/CLAUDE.md": "# 전역\n- 참고 자료: ~/.claude/memory/x.md\n",
        ".claude/memory/x.md": "경로가 적힌 파일\n",
        ".claude/memory/y.md": "아무도 안 적은 파일\n",
      }),
    );
    expect(depth(g, "x.md")).toBe(1);
    expect(depth(g, "y.md")).toBeNull();
    const e = g.graph.edges.find((x) => x.to === idOf(g.inv, "x.md"))!;
    expect(e.kind).toBe("mention");
    expect(e.from).toBe(idOf(g.inv, "CLAUDE.md"));
  });

  // 8: MEMORY.md 는 앞 200줄만 읽히므로 201줄부터 적은 길은 AI에게 닿지 않는다
  test("MEMORY.md 의 201줄부터 적힌 파일은 길이 없고, 5줄과 200줄에 적힌 파일은 닿는다", () => {
    const rows = Array.from({ length: 205 }, (_, i) => `- 메모 ${i + 1}번째 줄`);
    rows[0] = "# 목차";
    rows[4] = "- [A](a.md) - 5번째 줄에 링크";
    rows[199] = "- [C](c.md) - 200번째 줄에 링크";
    rows[200] = "- [B](b.md) - 201번째 줄에 링크";
    rows[201] = "- 이름만 적은 메모리: named-late";
    rows[202] = "- 자세한 건 late-mention.md 에 있음";
    const g = graphOf(
      homeWith({
        [`${MEM}/MEMORY.md`]: rows.join("\n") + "\n",
        [`${MEM}/a.md`]: "a\n",
        [`${MEM}/b.md`]: "b\n",
        [`${MEM}/c.md`]: "c\n",
        [`${MEM}/named-late.md`]: "named-late\n",
        [`${MEM}/late-mention.md`]: "late-mention\n",
      }),
    );
    expect(depth(g, "a.md")).toBe(1);
    expect(depth(g, "c.md")).toBe(1); // 200번째 줄은 아직 읽힌다
    expect(depth(g, "b.md")).toBeNull(); // 링크
    expect(depth(g, "named-late.md")).toBeNull(); // 이름 적기
    expect(depth(g, "late-mention.md")).toBeNull(); // 언급
    // 목차 길은 잘린 부분을 뺀 만큼만 있다
    expect(g.graph.edges.filter((x) => x.kind === "index").map((x) => x.to).sort()).toEqual([idOf(g.inv, "a.md"), idOf(g.inv, "c.md")].sort());
  });

  test("@import 는 import 길이고 불려 온 파일은 한 걸음 안쪽에 있다", () => {
    const g = graphOf(
      homeWith({
        ".claude/CLAUDE.md": "# 전역\n\n@rules/style.md\n",
        ".claude/rules/style.md": "# 문체\n- 짧게\n",
      }),
    );
    const e = g.graph.edges.find((x) => x.kind === "import")!;
    expect(e.from).toBe(idOf(g.inv, "CLAUDE.md"));
    expect(e.to).toBe(idOf(g.inv, "rules/style.md"));
    expect(depth(g, "CLAUDE.md")).toBe(0);
    expect(depth(g, "rules/style.md")).toBe(1);
    expect(g.graph.entries).toEqual([idOf(g.inv, "CLAUDE.md")]);
  });

  test("같은 쌍에 길이 여럿이면 목차, import, 링크, 언급 순으로 하나만 남긴다", () => {
    const g = graphOf(
      homeWith({
        [`${MEM}/MEMORY.md`]: "- [A](a.md) 그리고 a.md 를 또 적음\n",
        [`${MEM}/a.md`]: "a\n",
      }),
    );
    const to = idOf(g.inv, "a.md");
    expect(g.graph.edges.filter((x) => x.to === to)).toHaveLength(1);
    expect(g.graph.edges.find((x) => x.to === to)!.kind).toBe("index");
  });

  test(".claude 가 아예 없는 홈에서도 깨지지 않는다", () => {
    const d = mkdtempSync(join(tmpdir(), "cc-graph-"));
    dirs.push(d);
    const inv = buildInventory(d);
    const { edges } = buildLinks(inv.entries, inv.plugins);
    expect(edges).toEqual([]);
    expect(buildGraph(inv.entries, edges)).toEqual({ entries: [], nodes: [], edges: [] });
  });
});

describe("연결 누수 합계", () => {
  const item = (id: string, kind: Item["kind"]): Item =>
    ({ id, kind, name: id, source: { type: "user" }, summary: "", outline: [], size: { chars: 0, lines: 0, tokens: 0 }, alwaysLoaded: null, enabled: true, usage: { count30: 0, countAll: 0, daily30: [] }, links: { out: [], in: [] }, findings: [] }) as Item;

  test("길 없음, 안 읽힘(메모리만), 끊긴 링크, 안 쓴 양을 센다", () => {
    const graph: MdGraph = {
      entries: ["idx"],
      nodes: [
        { id: "idx", depth: 0, folder: "~/m", read30: 0 }, // 목차는 늘 실려서 안 읽힘으로 세지 않는다
        { id: "a", depth: 1, folder: "~/m", read30: 0 }, // 안 읽힘
        { id: "b", depth: 2, folder: "~/m", read30: 3 }, // 읽힘
        { id: "c", depth: null, folder: "~/m", read30: 0 }, // 길 없음
        { id: "d", depth: null, folder: "~/m", read30: 0 }, // 길 없음
      ],
      edges: [],
    };
    const items = [item("idx", "memory-index"), item("a", "memory"), item("b", "memory"), item("c", "memory"), item("d", "memory")];
    expect(leaksOf(graph, items, 1234, 7)).toEqual({ unreachable: 2, brokenLinks: 7, unread: 1, unusedTokens: 1234 });
  });

  test("노드가 없으면 전부 0", () => {
    expect(leaksOf({ entries: [], nodes: [], edges: [] }, [], 0, 0)).toEqual({ unreachable: 0, brokenLinks: 0, unread: 0, unusedTokens: 0 });
  });
});
