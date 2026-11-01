import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, collectUsage, scan, type ScanCore } from "../src/scan";
import { exists, isDir, isFile, listDir, overlayFrom, overlayKey, readText, withOverlay, type Overlay } from "../src/scan/fsutil";
import { estimateGains } from "../src/scan/gain";
import { topTodos } from "../src/shared/rank";
import type { Category, Finding, FixKind, Gain, Snapshot } from "../src/shared/types";
import { buildFixtureHome, buildHomeFrom, hookLine, type Fixture } from "./fixtures/build";

let dir: string;
let fx: Fixture;
let core: ScanCore;
let base: Snapshot;
let gained: Snapshot;

const ov = (files: Record<string, string | null>): Overlay => overlayFrom(Object.entries(files));
const settingsPath = () => join(fx.home, ".claude", "settings.json");
const gamma = () => join(fx.home, ".claude", "projects", "C--fx-gamma", "memory");

// settings.json 에서 플러그인 하나만 끈 내용 (나머지 모양은 그대로)
function pluginOff(key: string): Overlay {
  const j = JSON.parse(readFileSync(settingsPath(), "utf8"));
  j.enabledPlugins[key] = false;
  return ov({ [settingsPath()]: JSON.stringify(j, null, 2) });
}

const strip = (s: Snapshot) => ({ ...s, generatedAt: "", summary: { ...s.summary, at: "" }, stats: { ...s.stats, durationMs: 0 } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-overlay-"));
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  fx = buildFixtureHome(dir, now);
  core = await collectUsage(fx.home, { now: fx.now, cache: false });
  base = analyze(fx.home, core);
  gained = analyze(fx.home, core);
  estimateGains(fx.home, core, gained);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("가상 덮어쓰기 (fsutil)", () => {
  test("덮어쓴 파일은 새 내용, null 은 없음, 새 파일과 새 폴더는 목록에 나타남", () => {
    const g = gamma();
    const o = ov({
      [join(g, "gamma-one.md")]: "바뀐 내용\n",
      [join(g, "gamma-two.md")]: null,
      [join(g, "new-note.md")]: "새 메모\n",
      [join(g, "deep", "inner.md")]: "안쪽\n",
    });
    withOverlay(o, () => {
      expect(readText(join(g, "gamma-one.md"))).toBe("바뀐 내용\n");
      expect(readText(join(g, "gamma-two.md"))).toBeNull();
      expect(isFile(join(g, "gamma-two.md"))).toBe(false);
      expect(exists(join(g, "gamma-two.md"))).toBe(false);
      expect(isFile(join(g, "new-note.md"))).toBe(true);
      expect(isDir(join(g, "deep"))).toBe(true); // 새 파일로만 있는 폴더
      expect(exists(join(g, "deep"))).toBe(true);
      const names = listDir(g).map((d) => d.name);
      expect(names).toContain("new-note.md");
      expect(names).toContain("deep");
      expect(names).not.toContain("gamma-two.md");
      expect(listDir(g).find((d) => d.name === "deep")!.isDirectory()).toBe(true);
      expect(listDir(join(g, "deep")).map((d) => d.name)).toEqual(["inner.md"]);
    });
    // 끝나면 실제 파일 그대로
    expect(readText(join(g, "gamma-two.md"))).not.toBeNull();
    expect(existsSync(join(g, "new-note.md"))).toBe(false);
    expect(listDir(g).map((d) => d.name)).not.toContain("new-note.md");
  });
  test("새 파일과 새 폴더 이름은 원래 대소문자 그대로", () => {
    const g = gamma();
    withOverlay(ov({ [join(g, "Foo-Bar.md")]: "새 메모\n", [join(g, "New-Dir", "Inner-File.md")]: "안쪽\n" }), () => {
      const names = listDir(g).map((d) => d.name);
      expect(names).toContain("Foo-Bar.md");
      expect(names).toContain("New-Dir");
      expect(listDir(join(g, "new-dir")).map((d) => d.name)).toEqual(["Inner-File.md"]);
      expect(names.filter((n) => n.toLowerCase() === "foo-bar.md")).toHaveLength(1);
    });
    // 이름 표 없이 키만 주면 키의 이름을 쓴다 (Windows 면 소문자)
    withOverlay({ files: new Map([[overlayKey(join(g, "Only-Key.md")), "x\n"]]) }, () => {
      expect(listDir(g).map((d) => d.name.toLowerCase())).toContain("only-key.md");
    });
    const after = analyze(fx.home, core, ov({ [join(g, "Foo-Bar.md")]: "# 새 메모\n" }));
    expect(after.items.find((i) => i.id === "memory:project:fx-gamma:foo-bar.md")?.name).toBe("Foo-Bar.md");
  });
  test("null 폴더는 그 아래 전부 없음", () => {
    const skill = join(fx.home, ".claude", "skills", "unused-one");
    withOverlay(ov({ [skill]: null }), () => {
      expect(isDir(skill)).toBe(false);
      expect(isFile(join(skill, "SKILL.md"))).toBe(false);
      expect(listDir(join(fx.home, ".claude", "skills")).map((d) => d.name)).not.toContain("unused-one");
    });
    expect(isFile(join(skill, "SKILL.md"))).toBe(true);
  });
  test("안에서 오류가 나도 덮어쓰기는 풀린다", () => {
    const p = join(gamma(), "gamma-one.md");
    expect(() => withOverlay(ov({ [p]: null }), () => { throw new Error("x"); })).toThrow("x");
    expect(readText(p)).not.toBeNull();
  });
});

describe("분석 분리", () => {
  test("scan 은 collectUsage + analyze (+ 사전 기대 효과) 와 같다", async () => {
    const s = await scan(fx.home, { now: fx.now, cache: false });
    expect(strip(s)).toEqual(strip(gained));
    const noGain = (x: Snapshot) => strip({ ...x, findings: x.findings.map(({ gain: _g, ...f }) => f as Finding) });
    expect(noGain(s)).toEqual(noGain(base));
  });
  test("같은 core 로 여러 번 분석해도 결과가 같다 (core 를 바꾸지 않는다)", () => {
    expect(strip(analyze(fx.home, core))).toEqual(strip(base));
    expect(strip(analyze(fx.home, core, { files: new Map() }))).toEqual(strip(base));
  });
  test("overlay 로 플러그인을 끄면 목록 토큰이 준다", () => {
    const before = readFileSync(settingsPath(), "utf8");
    const after = analyze(fx.home, core, pluginOff("plugin-a@mkt"));
    const own = base.items.filter((i) => i.source.type === "plugin" && i.source.plugin === "plugin-a" && i.enabled && i.alwaysLoaded);
    const sum = own.reduce((n, i) => n + i.alwaysLoaded!.tokens, 0);
    expect(sum).toBeGreaterThan(0);
    expect(after.context.totalTokens).toBe(base.context.totalTokens - sum);
    expect(after.items.find((i) => i.id === "plugin:plugin:plugin-a:plugin-a")!.enabled).toBe(false);
    expect(readFileSync(settingsPath(), "utf8")).toBe(before); // 실제 파일은 그대로
    expect(analyze(fx.home, core).context.totalTokens).toBe(base.context.totalTokens);
  });
  test("overlay null 은 파일이 없는 것", () => {
    const p = join(gamma(), "gamma-two.md");
    const after = analyze(fx.home, core, ov({ [p]: null }));
    expect(base.items.some((i) => i.id === "memory:project:fx-gamma:gamma-two.md")).toBe(true);
    expect(after.items.some((i) => i.id === "memory:project:fx-gamma:gamma-two.md")).toBe(false);
    expect(existsSync(p)).toBe(true);
  });
  test("overlay 새 파일은 목록에 나타남", () => {
    const p = join(gamma(), "new-note.md");
    const skill = join(fx.home, ".claude", "skills", "brand-new", "SKILL.md");
    const after = analyze(fx.home, core, ov({ [p]: "# 새 메모\n\n새로 생긴 메모예요.\n", [skill]: "---\nname: brand-new\ndescription: 새로 생긴 작업 설명서예요.\n---\n본문\n" }));
    const it = after.items.find((i) => i.id === "memory:project:fx-gamma:new-note.md");
    expect(it?.summary).toContain("새로 생긴 메모");
    expect(after.items.find((i) => i.id === "skill:user::brand-new")?.alwaysLoaded?.tokens).toBeGreaterThan(0);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(skill)).toBe(false);
  });
});

describe("사전 기대 효과", () => {
  const one = (rule: string): Finding => {
    const f = gained.findings.filter((x) => x.rule === rule);
    expect(f).toHaveLength(1);
    return f[0];
  };
  test("unused-plugin gain 은 정확한 값", () => {
    const g = one("unused-plugin").gain!;
    const diff = base.context.totalTokens - analyze(fx.home, core, pluginOff("plugin-unused@mkt")).context.totalTokens;
    expect(diff).toBeGreaterThan(0);
    expect(g.upTo).toBe(false);
    expect(g.tokens).toBe(diff);
    const m = /^대화마다 A4 약 ([0-9.]+)쪽이 줄어요$/.exec(g.text);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]) - diff / 1500)).toBeLessThan(0.051);
    expect(Number(m![1])).toBeGreaterThan(0); // 작아도 0.0쪽으로 보이지 않는다
  });
  test("플러그인을 끄는 효과는 여러 플러그인을 한꺼번에 계산해도 하나씩 끈 차이와 같다", () => {
    const fs = gained.findings.filter((f) => f.fixKind === "mechanical" && f.items[0].includes(":plugin:") && f.gain?.tokens != null);
    expect(new Set(fs.map((f) => f.rule))).toEqual(new Set(["unused-plugin", "unused-items"]));
    for (const f of fs) {
      const name = base.items.find((i) => i.id === f.items[0])!.source.plugin!;
      const diff = base.context.totalTokens - analyze(fx.home, core, pluginOff(`${name}@mkt`)).context.totalTokens;
      expect(f.gain!.tokens).toBe(diff);
    }
  });
  test("개인 unused-items gain 은 그 파일들을 뺀 overlay 의 차이", () => {
    const f = gained.findings.find((x) => x.rule === "unused-items" && x.items.every((id) => id.includes(":user:")))!;
    expect(f.fixKind).toBe("mechanical");
    const files: Record<string, string | null> = {};
    for (const id of f.items) {
      const it = base.items.find((i) => i.id === id)!;
      const abs = join(fx.home, it.path!.slice(2));
      files[it.kind === "skill" ? join(abs, "..") : abs] = null; // 작업 설명서는 폴더째 옮긴다
    }
    const diff = base.context.totalTokens - analyze(fx.home, core, ov(files)).context.totalTokens;
    expect(diff).toBeGreaterThan(0);
    expect(f.gain).toMatchObject({ upTo: false, tokens: diff });
  });
  test("unread-md gain 은 옮기는 파일 수 (정확)", () => {
    for (const f of gained.findings.filter((x) => x.rule === "unread-md")) {
      expect(f.gain?.upTo).toBe(false);
      expect(f.gain?.count).toBe(f.items.length);
    }
    expect(gained.findings.some((x) => x.rule === "unread-md")).toBe(true);
  });
  test("claude 규칙 gain 은 상한", () => {
    const fs = gained.findings.filter((x) => x.rule === "unreachable-md" && x.fixKind === "claude");
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) {
      const folder = gained.graph.nodes.find((n) => n.id === f.items[0])!.folder;
      const lost = gained.graph.nodes.filter((n) => n.folder === folder && n.depth === null).length;
      expect(f.gain).toMatchObject({ upTo: true, count: lost });
      expect(f.gain!.text).toContain("최대");
    }
    const trunc = one("memory-index-truncated");
    expect(trunc.gain).toMatchObject({ upTo: true, count: 5 }); // 205줄 - 200줄
    expect(trunc.gain!.text).toContain("최대");
  });
  test("고치기가 되는 진단은 모두 효과가 있고, mechanical 은 정확, 나머지는 최대", () => {
    for (const f of gained.findings) {
      if (f.category === "risk") continue;
      if (f.fixKind !== "manual") expect(f.gain).toBeDefined();
      if (!f.gain) continue;
      expect(f.gain.upTo).toBe(f.fixKind !== "mechanical");
      if (f.gain.upTo) expect(f.gain.text).toContain("최대");
      expect(f.gain.text).not.toMatch(/[—–]|이\(가\)|을\(를\)/);
      expect(f.gain.text).toMatch(/요$/);
    }
  });
  test("기대 효과를 계산해도 실제 파일과 나머지 결과는 그대로", () => {
    expect(readFileSync(settingsPath(), "utf8")).toContain('"plugin-unused@mkt": true');
    expect(existsSync(join(fx.home, ".claude", "skills", "unused-one", "SKILL.md"))).toBe(true);
    const noGain = (x: Snapshot) => strip({ ...x, findings: x.findings.map(({ gain: _g, ...f }) => f as Finding) });
    expect(noGain(gained)).toEqual(noGain(base));
  });
});

describe("할 일 순서", () => {
  let n = 0;
  const F = (category: Category, fixKind: FixKind, gain?: Partial<Gain>): Finding => ({
    id: `f:${++n}`,
    rule: "x",
    category,
    fixKind,
    ...(gain ? { gain: { text: "", upTo: false, ...gain } } : {}),
    severity: "low",
    title: `${category}-${fixKind}-${gain?.tokens ?? gain?.count ?? 0}`,
    why: "",
    fix: "",
    items: [],
    evidence: "",
    steps: [],
    prompt: "",
  });
  test("분류 순, 같은 분류는 효과 큰 순, 위험과 manual 은 빼고 최대 3개", () => {
    const list = [
      F("risk", "manual", { count: 99 }),
      F("confusion", "claude", { count: 9 }),
      F("waste", "mechanical", { tokens: 1500 }),
      F("broken", "manual", { count: 50 }),
      F("waste", "mechanical", { tokens: 4500 }),
      F("leak", "claude", { count: 2 }),
      F("waste", "claude", { count: 2 }), // count 는 그대로: A4 3쪽보다 작고 1쪽보다 크다
      F("leak", "mechanical", { count: 7 }),
      F("broken", "claude", { count: 1 }),
      F("waste", "claude"), // 효과를 모르면 그 분류 맨 뒤
    ];
    const titles = (xs: Finding[]) => xs.map((f) => f.title);
    expect(titles(topTodos(list))).toEqual(["broken-claude-1", "leak-mechanical-7", "leak-claude-2"]);
    expect(titles(topTodos(list, 20))).toEqual([
      "broken-claude-1",
      "leak-mechanical-7",
      "leak-claude-2",
      "waste-mechanical-4500",
      "waste-claude-2",
      "waste-mechanical-1500",
      "waste-claude-0",
      "confusion-claude-9",
    ]);
    expect(topTodos([F("risk", "manual"), F("waste", "manual", { tokens: 9000 })])).toEqual([]);
  });
  test("가짜 홈: 할 일은 고치기가 되는 진단만, 분류 순", () => {
    const top = topTodos(gained.findings);
    expect(top.length).toBe(3);
    const order: Category[] = ["broken", "leak", "waste", "confusion"];
    const idx = top.map((f) => order.indexOf(f.category));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(top.every((f) => f.fixKind !== "manual")).toBe(true);
    expect(top[0].rule).toBe("memory-index-truncated"); // 고장 중 고치기가 되는 유일한 것
  });
  test("실패가 1~2번인 훅은 할 일에서 빠지고 진단에는 남는다, 3번이면 할 일에 들어간다", async () => {
    const d = mkdtempSync(join(tmpdir(), "cc-failhook-"));
    try {
      const pdir = join(d, ".claude", "plugins", "cache", "mkt", "pp", "1.0.0");
      const twice = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/twice.mjs"';
      const thrice = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/thrice.mjs"';
      const at = (k: number) => new Date(fx.now.getTime() - 60_000 * (k + 1)).toISOString();
      const fail = (cmd: string, k: number) => hookLine(at(k), "Stop", cmd, 10, 1, "hook_non_blocking_error");
      const home = buildHomeFrom(d, {
        ".claude/settings.json": JSON.stringify({ enabledPlugins: { "pp@mkt": true } }),
        ".claude/plugins/installed_plugins.json": JSON.stringify({ version: 2, plugins: { "pp@mkt": [{ scope: "user", installPath: pdir, version: "1.0.0" }] } }),
        ".claude/plugins/cache/mkt/pp/1.0.0/.claude-plugin/plugin.json": JSON.stringify({ name: "pp" }),
        ".claude/plugins/cache/mkt/pp/1.0.0/hooks/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: twice }, { type: "command", command: thrice }] }] } }),
        ".claude/projects/C--mini/s.jsonl": [fail(twice, 1), fail(twice, 2), fail(thrice, 3), fail(thrice, 4), fail(thrice, 5)].join("\n") + "\n",
      });
      const s = await scan(home, { now: fx.now, cache: false });
      const hooks = s.findings.filter((f) => f.rule === "failing-hook");
      const two = hooks.find((f) => f.items[0].includes("twice"))!;
      const three = hooks.find((f) => f.items[0].includes("thrice"))!;
      expect(two).toMatchObject({ severity: "medium", fixKind: "mechanical" });
      expect(three).toMatchObject({ severity: "high", fixKind: "mechanical" });
      const top = topTodos(s.findings, 20);
      expect(top).not.toContain(two);
      expect(top).toContain(three);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("작은 홈: .claude 가 없으면 할 일도 효과도 없다", async () => {
    const d = mkdtempSync(join(tmpdir(), "cc-empty-"));
    try {
      const home = d; // .claude 폴더가 없는 홈
      const c = await collectUsage(home, { cache: false });
      const s = analyze(home, c);
      estimateGains(home, c, s);
      expect(s.findings).toEqual([]);
      expect(topTodos(s.findings)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
