import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readText, withOverlay } from "../src/scan/fsutil";
import { applyPlanned, ChangedSinceError, listBackups, undo } from "../src/fix/backup";
import { lineDiff } from "../src/fix/diff";
import { planMoveOff, planPluginsOff } from "../src/fix/mechanical";
import { absOf, backupsDir, claudeRoot, offDir, relOf } from "../src/fix/paths";
import { buildFixtureHome } from "./fixtures/build";

let dir: string;
let home: string;
const settings = () => join(home, ".claude", "settings.json");
const KEY = "plugin-unused@mkt";

function fakeRun(code = 0) {
  const calls: string[][] = [];
  return { calls, run: async (a: string[]) => (calls.push(a), code) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fix-"));
  home = buildFixtureHome(join(dir, "home")).home;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("플러그인 끄기", () => {
  test("미리 보기는 파일을 안 바꾼다", () => {
    const before = readFileSync(settings(), "utf8");
    const p = planPluginsOff(home, [KEY]);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(backupsDir(home))).toBe(false);
    expect(p.changes[0].kind).toBe("plugin-off");
    expect(p.changes[0].diff.some((l) => l.op === "+" && l.text.includes("false"))).toBe(true);
    // overlay 로 보면 꺼져 있다
    const seen = withOverlay(p.overlay, () => JSON.parse(readText(settings())!));
    expect(seen.enabledPlugins[KEY]).toBe(false);
    expect(seen.enabledPlugins["plugin-a@mkt"]).toBe(true);
  });

  test("claude CLI 가 되면 plugin disable 로 끄고, 백업이 남고, 되돌리면 plugin enable", async () => {
    const f = fakeRun();
    const p = planPluginsOff(home, [KEY]);
    const m = await applyPlanned(home, p, "unused-plugin", f.run);
    expect(f.calls).toEqual([["plugin", "disable", KEY]]);
    expect(listBackups(home).map((b) => b.id)).toEqual([m.id]);
    const r = await undo(home, m.id, f.run);
    expect(r.ok).toBe(true);
    expect(f.calls[1]).toEqual(["plugin", "enable", KEY]);
  });

  test("claude 가 없으면 settings.json 을 고치고, 되돌리면 원래대로", async () => {
    const before = readFileSync(settings(), "utf8");
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "unused-plugin");
    expect(JSON.parse(readFileSync(settings(), "utf8")).enabledPlugins[KEY]).toBe(false);
    expect(readFileSync(backupFileOf(m.id), "utf8")).toBe(before);
    const r = await undo(home, m.id);
    expect(r.ok).toBe(true);
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  test("CLI 가 실패(0 아님)하면 설정 파일로 대신한다", async () => {
    const f = fakeRun(1);
    await applyPlanned(home, planPluginsOff(home, [KEY]), "unused-plugin", f.run);
    expect(JSON.parse(readFileSync(settings(), "utf8")).enabledPlugins[KEY]).toBe(false);
  });

  test("settings.json 이 없는 홈도 계획되고 되돌리면 파일이 사라진다", async () => {
    rmSync(settings());
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "x");
    expect(JSON.parse(readFileSync(settings(), "utf8")).enabledPlugins[KEY]).toBe(false);
    expect((await undo(home, m.id)).ok).toBe(true);
    expect(existsSync(settings())).toBe(false);
  });
});

const backupFileOf = (id: string) => join(backupsDir(home), id, "files", "settings.json");

describe("보관 이동", () => {
  test("개인 스킬 폴더가 off/ 아래로 가고, 되돌리면 제자리", async () => {
    const skill = join(home, ".claude", "skills", "unused-one");
    expect(existsSync(skill)).toBe(true);
    const p = planMoveOff(home, [skill]);
    expect(existsSync(skill)).toBe(true); // 미리 보기는 그대로
    expect(withOverlay(p.overlay, () => exists(skill))).toBe(false);
    const m = await applyPlanned(home, p, "unused-items");
    expect(existsSync(skill)).toBe(false);
    expect(existsSync(join(offDir(home), "skills", "unused-one", "SKILL.md"))).toBe(true);
    expect((await undo(home, m.id)).ok).toBe(true);
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
    expect(existsSync(join(offDir(home), "skills", "unused-one"))).toBe(false);
  });

  test("고른 폴더 안의 파일은 따로 옮기지 않는다", () => {
    const p = planMoveOff(home, [join(home, ".claude", "skills", "unused-one", "SKILL.md"), join(home, ".claude", "skills", "unused-one")]);
    expect(p.moves.length).toBe(1);
  });

  test("제자리에 같은 이름이 새로 생겼으면 되돌리지 않는다", async () => {
    const skill = join(home, ".claude", "skills", "unused-one");
    const m = await applyPlanned(home, planMoveOff(home, [skill]), "unused-items");
    mkdirSync(skill, { recursive: true });
    const r = await undo(home, m.id);
    expect(r.ok).toBe(false);
    expect(existsSync(join(offDir(home), "skills", "unused-one", "SKILL.md"))).toBe(true);
  });
});

describe("그사이 바뀜", () => {
  test("미리 보기 뒤 원본이 바뀌면 적용을 거부한다", async () => {
    const p = planPluginsOff(home, [KEY]);
    const edited = readFileSync(settings(), "utf8") + "\n";
    writeFileSync(settings(), edited);
    const err = await applyPlanned(home, p, "x").catch((e) => e);
    expect(err).toBeInstanceOf(ChangedSinceError);
    expect(err.message).toContain("미리 보기를 다시 만들어 주세요");
    expect(readFileSync(settings(), "utf8")).toBe(edited);
    expect(listBackups(home)).toEqual([]);
  });

  test("보관 이동도 폴더 안이 바뀌면 거부한다", async () => {
    const skill = join(home, ".claude", "skills", "unused-one");
    const p = planMoveOff(home, [skill]);
    writeFileSync(join(skill, "SKILL.md"), "changed");
    expect(applyPlanned(home, p, "x")).rejects.toBeInstanceOf(ChangedSinceError);
  });

  test("적용 뒤 사용자가 다시 고친 파일은 되돌리지 않고 백업 경로를 알려 준다", async () => {
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "x");
    const mine = readFileSync(settings(), "utf8").replace("plugin-a@mkt\": true", "plugin-a@mkt\": false");
    writeFileSync(settings(), mine);
    const r = await undo(home, m.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(join(backupsDir(home), m.id));
    expect(readFileSync(settings(), "utf8")).toBe(mine);
  });
});

describe("경계", () => {
  test("plugins/ 아래와 .claude 밖은 relOf 가 null", () => {
    expect(relOf(home, join(claudeRoot(home), "plugins", "cache", "x"))).toBeNull();
    expect(relOf(home, join(claudeRoot(home), "Plugins", "x"))).toBeNull();
    expect(relOf(home, join(home, "work", "x.md"))).toBeNull();
    expect(relOf(home, join(home, ".claude-checkup", "off", "x"))).toBeNull();
    expect(relOf(home, join(claudeRoot(home), "..", "x"))).toBeNull();
    expect(relOf(home, claudeRoot(home))).toBeNull();
    expect(relOf(home, join(claudeRoot(home), "skills", "a", "SKILL.md"))).toBe("skills/a/SKILL.md");
    expect(absOf(home, "skills/a")).toBe(join(claudeRoot(home), "skills", "a"));
  });

  test("계획에 못 들어가고, 적용에서도 막는다", async () => {
    expect(() => planMoveOff(home, [join(home, ".claude", "plugins", "cache")])).toThrow();
    expect(() => planMoveOff(home, [join(home, "work")])).toThrow();
    const p = planPluginsOff(home, [KEY]);
    p.writes.push({ abs: join(home, "outside.txt"), content: "x" });
    expect(applyPlanned(home, p, "x")).rejects.toThrow();
    expect(existsSync(join(home, "outside.txt"))).toBe(false);
  });
});

describe("lineDiff", () => {
  test("추가만", () => {
    const d = lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nc\nX\nd\ne\nf", 1);
    expect(d).toEqual([
      { op: " ", text: "c" },
      { op: "+", text: "X" },
      { op: " ", text: "d" },
    ]);
  });
  test("바꿈", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d).toEqual([
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
    ]);
  });
  test("같으면 비어 있다", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([]);
  });
});

test("문구에 em dash 와 en dash 가 없다", () => {
  for (const f of ["backup", "mechanical", "diff", "paths"]) {
    const t = readFileSync(join(import.meta.dir, "..", "src", "fix", f + ".ts"), "utf8");
    expect(t.includes("—") || t.includes("–")).toBe(false);
  }
});
