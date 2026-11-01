import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlanned, listBackups, undo } from "../src/fix/backup";
import { planMoveOff, planPluginsOff } from "../src/fix/mechanical";
import { backupsDir, offDir } from "../src/fix/paths";
import { buildFixtureHome } from "./fixtures/build";

let dir: string;
let home: string;
const settings = () => join(home, ".claude", "settings.json");
const manifestPath = (id: string) => join(backupsDir(home), id, "manifest.json");
const readManifest = (id: string) => JSON.parse(readFileSync(manifestPath(id), "utf8"));
const KEY = "plugin-unused@mkt";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fixs-"));
  home = buildFixtureHome(join(dir, "home")).home;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("플러그인 CLI 경로", () => {
  test("모든 키를 CLI 로 껐으면 settings.json 은 쓰지 않는다", async () => {
    const before = readFileSync(settings(), "utf8");
    await applyPlanned(home, planPluginsOff(home, [KEY]), "x", async () => 0);
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  test("일부만 CLI 로 껐으면 나머지는 settings.json 으로 끄고, 되돌릴 때는 CLI 로 끈 것만 enable", async () => {
    const calls: string[][] = [];
    const run = async (a: string[]) => (calls.push(a), a[2] === "plugin-a@mkt" ? 0 : 1);
    const m = await applyPlanned(home, planPluginsOff(home, ["plugin-a@mkt", KEY]), "x", run);
    const j = JSON.parse(readFileSync(settings(), "utf8"));
    expect(j.enabledPlugins[KEY]).toBe(false);
    expect(j.enabledPlugins["plugin-a@mkt"]).toBe(false);
    expect(m.cliKeys).toEqual(["plugin-a@mkt"]);
    calls.length = 0;
    expect((await undo(home, m.id, run)).ok).toBe(true);
    expect(calls).toEqual([["plugin", "enable", "plugin-a@mkt"]]);
  });
});

describe("적용 실패와 중단", () => {
  test("도중에 실패하면 전부 원래대로 돌리고 목록에서 빠진다", async () => {
    const reviewer = join(home, ".claude", "agents", "reviewer.md");
    const skill = join(home, ".claude", "skills", "unused-one");
    const p = planMoveOff(home, [reviewer, skill]);
    mkdirSync(offDir(home), { recursive: true });
    writeFileSync(join(offDir(home), "skills"), "i am a file"); // 두 번째 이동이 실패한다
    await expect(applyPlanned(home, p, "x")).rejects.toThrow();
    expect(existsSync(reviewer)).toBe(true);
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
    expect(existsSync(join(offDir(home), "agents", "reviewer.md"))).toBe(false);
    expect(listBackups(home)).toEqual([]);
    const id = readdirSync(backupsDir(home))[0];
    expect(readManifest(id).status).toBe("failed");
    const r = await undo(home, id);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("다시 바뀌어");
  });

  test("성공하면 status 는 applied", async () => {
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "x");
    expect(readManifest(m.id).status).toBe("applied");
  });

  test("중간에 멈춘 적용(applying)은 해시 검사 없이 파일과 이동을 되돌린다", async () => {
    const skill = join(home, ".claude", "skills", "unused-one");
    const before = readFileSync(settings(), "utf8");
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "x");
    const mf = readManifest(m.id);
    mf.status = "applying";
    mf.files = mf.files.map((f: any) => ({ ...f, appliedHash: null }));
    writeFileSync(manifestPath(m.id), JSON.stringify(mf));
    writeFileSync(settings(), "{}");
    expect(listBackups(home).some((b) => b.id === m.id)).toBe(true);
    expect((await undo(home, m.id)).ok).toBe(true);
    expect(readFileSync(settings(), "utf8")).toBe(before);

    const m2 = await applyPlanned(home, planMoveOff(home, [skill]), "y");
    const mf2 = readManifest(m2.id);
    mf2.status = "applying";
    writeFileSync(manifestPath(m2.id), JSON.stringify(mf2));
    expect((await undo(home, m2.id)).ok).toBe(true);
    expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  });

  test("applying 상태로 남은 백업은 이동 계획이 manifest 에 이미 있다", async () => {
    // 이동 직전에 manifest 가 이미 이동 계획과 status 를 담는지: 이동 실패를 일으켜 failed manifest 에서 확인
    const skill = join(home, ".claude", "skills", "unused-one");
    mkdirSync(offDir(home), { recursive: true });
    writeFileSync(join(offDir(home), "skills"), "file");
    await expect(applyPlanned(home, planMoveOff(home, [skill]), "x")).rejects.toThrow();
    const id = readdirSync(backupsDir(home))[0];
    expect(readManifest(id).moves).toEqual([{ fromRel: "skills/unused-one", toRel: "skills/unused-one" }]);
  });
});

describe("CLI 로 끈 플러그인의 복구", () => {
  test("A 를 끈 뒤 B 에서 예외가 나면 A 를 다시 켜고 settings.json 은 그대로", async () => {
    const before = readFileSync(settings(), "utf8");
    const calls: string[][] = [];
    const run = async (a: string[]) => {
      calls.push(a);
      if (a[1] === "disable" && a[2] === KEY) throw new Error("boom");
      return 0;
    };
    await expect(applyPlanned(home, planPluginsOff(home, ["plugin-a@mkt", KEY]), "x", run)).rejects.toThrow("boom");
    expect(calls).toContainEqual(["plugin", "enable", "plugin-a@mkt"]);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(listBackups(home)).toEqual([]);
  });

  test("applying 기록이 cliKeys 를 담고 있으면 undo 가 enable 한다", async () => {
    const m = await applyPlanned(home, planPluginsOff(home, [KEY]), "x", async () => 0);
    const mf = readManifest(m.id);
    mf.status = "applying";
    expect(mf.cliKeys).toEqual([KEY]);
    writeFileSync(manifestPath(m.id), JSON.stringify(mf));
    const calls: string[][] = [];
    const r = await undo(home, m.id, async (a) => (calls.push(a), 0));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([["plugin", "enable", KEY]]);
  });

  test("키 하나를 끌 때마다 manifest 에 바로 남는다", async () => {
    let seen: string[] | undefined;
    const run = async (a: string[]) => {
      if (a[2] === KEY) seen = readManifest(readdirSync(backupsDir(home))[0]).cliKeys;
      return 0;
    };
    await applyPlanned(home, planPluginsOff(home, ["plugin-a@mkt", KEY]), "x", run);
    expect(seen).toEqual(["plugin-a@mkt"]);
  });
});

describe("링크와 임시 파일", () => {
  test("링크로 연결된 폴더 안은 옮기지 않고, 링크 자체도 거부한다", async () => {
    const outside = join(dir, "dotfiles");
    mkdirSync(join(outside, "foo"), { recursive: true });
    writeFileSync(join(outside, "foo", "SKILL.md"), "x");
    const link = join(home, ".claude", "linked-skills");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // 링크를 만들 수 없는 환경
    }
    await expect(applyPlanned(home, planMoveOff(home, [join(link, "foo")]), "x")).rejects.toThrow("링크로 연결된 곳이라 고치지 않아요");
    expect(existsSync(join(outside, "foo", "SKILL.md"))).toBe(true);
    await expect(applyPlanned(home, planMoveOff(home, [link]), "x")).rejects.toThrow("링크");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "foo", "SKILL.md"))).toBe(true);
  });

  test("settings.json 이 링크면 고치지 않는다", async () => {
    const real = join(dir, "real-settings.json");
    writeFileSync(real, readFileSync(settings()));
    rmSync(settings());
    try {
      symlinkSync(real, settings(), "file");
    } catch {
      return;
    }
    await expect(applyPlanned(home, planPluginsOff(home, [KEY]), "x")).rejects.toThrow("링크");
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
  });

  test("임시 파일을 .claude 안에 만들지 않는다", async () => {
    await applyPlanned(home, planPluginsOff(home, [KEY]), "x");
    expect(readdirSync(join(home, ".claude")).some((n) => n.includes("checkup-tmp"))).toBe(false);
  });
});
