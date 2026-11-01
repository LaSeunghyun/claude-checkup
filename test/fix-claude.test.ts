import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnv, planWithClaude, resolveClaude, runClaudeCli, SecretInTargetError } from "../src/fix/claude";
import { applyPlanned } from "../src/fix/backup";
import { absOf, tmpDir } from "../src/fix/paths";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const CMD = [process.execPath, "run", FAKE];
let dir: string;
let home: string;
let planFile: string;
const setPlan = (p: object) => writeFileSync(planFile, JSON.stringify(p));
const put = (rel: string, body: string) => {
  const a = absOf(home, rel);
  mkdirSync(join(a, ".."), { recursive: true });
  writeFileSync(a, body);
};
const SECRET = "sk-abcdefghijklmnop1234";
const leftovers = () => (existsSync(tmpDir(home)) ? readdirSync(tmpDir(home)) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fixc-"));
  home = join(dir, "home");
  mkdirSync(join(home, ".claude", "memory"), { recursive: true });
  planFile = join(dir, "plan.json");
  process.env.CHECKUP_FAKE_PLAN = planFile;
  put("memory/MEMORY.md", "# 목차\n- [a](a.md)\n");
  put("memory/a.md", "hello\n");
  put("memory/notes-token.md", "비밀이름\n");
  put("memory/leak.md", `키 ${SECRET}\n`);
  put("other/keep.md", "남의 폴더\n");
});
afterEach(() => {
  delete process.env.CHECKUP_FAKE_PLAN;
  rmSync(dir, { recursive: true, force: true });
});

const run = (extra: Partial<Parameters<typeof planWithClaude>[1]> = {}) =>
  planWithClaude(home, {
    targets: [absOf(home, "memory/MEMORY.md")],
    scopeDirs: [absOf(home, "memory")],
    prompt: "MEMORY.md 를 정리해 줘",
    cmd: CMD,
    ...extra,
  });

describe("planWithClaude", () => {
  test("임시 복사본만 바뀌고 원본은 그대로, writes 에 변경 반영", async () => {
    setPlan({ edits: [{ rel: "memory/a.md", content: "hello\nworld\n" }] });
    const p = await run();
    expect(readFileSync(absOf(home, "memory/a.md"), "utf8")).toBe("hello\n");
    expect(p.writes).toEqual([{ abs: absOf(home, "memory/a.md"), content: "hello\nworld\n" }]);
    expect(p.changes[0].kind).toBe("modified");
    expect(p.changes[0].rel).toBe("memory/a.md");
    expect(p.changes[0].diff.some((l) => l.op === "+" && l.text === "world")).toBe(true);
    expect(p.hashes[absOf(home, "memory/a.md")]).toBeTruthy();
    expect(p.usage).toEqual({ inputTokens: 120, outputTokens: 34, costUsd: 0.0123 });
    expect(p.moves).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("새 파일은 허용 폴더 안이면 added", async () => {
    setPlan({ edits: [{ rel: "memory/topic.md", content: "새 글\n" }] });
    const p = await run();
    expect(p.changes.map((c) => [c.rel, c.kind])).toEqual([["memory/topic.md", "added"]]);
    expect(p.hashes[absOf(home, "memory/topic.md")]).toBe("missing");
  });

  test("허용 폴더 밖 변경은 버리고 경고, 지운 파일도 버리고 경고", async () => {
    setPlan({
      edits: [
        { rel: "memory/a.md", content: "hello\nworld\n" },
        { rel: "other/new.md", content: "밖\n" },
        { rel: "plugins/x/y.md", content: "플러그인\n" },
        { rel: "memory/sub/deep.md", content: "새 하위 폴더도 폴더 안이라 허용\n" },
        { rel: "memory/MEMORY.md", delete: true },
      ],
    });
    const p = await run();
    expect(p.changes.map((c) => c.rel).sort()).toEqual(["memory/a.md", "memory/sub/deep.md"]);
    expect(p.warnings.some((w) => w.includes("other/new.md"))).toBe(true);
    expect(p.warnings.some((w) => w.includes("plugins/x/y.md"))).toBe(true);
    expect(p.warnings.some((w) => w.includes("MEMORY.md") && w.includes("지"))).toBe(true);
    expect(existsSync(absOf(home, "other/new.md"))).toBe(false);
  });

  test("비밀값 파일은 복사하지 않고 경고한다", async () => {
    // 복사됐다면 지우려는 시도가 "지운 파일" 경고가 된다. 복사 안 했으면 경고가 없다
    setPlan({ edits: [{ rel: "memory/leak.md", delete: true }, { rel: "memory/a.md", content: "hello\nworld\n" }] });
    const p = await run();
    expect(p.warnings.some((w) => w.includes("비밀값이 있어 Claude에게 보내지 않은 파일 2개"))).toBe(true);
    expect(p.warnings.some((w) => w.includes("leak.md") && w.includes("지"))).toBe(false);
    expect(p.changes.map((c) => c.rel)).toEqual(["memory/a.md"]);
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  test("보내지 않은 파일과 같은 자리에 Claude 가 새 파일을 만들면 버린다", async () => {
    setPlan({ edits: [{ rel: "memory/notes-token.md", content: "덮어쓰기\n" }, { rel: "memory/leak.md", content: "덮어쓰기\n" }] });
    const p = await run();
    expect(p.changes).toEqual([]);
    expect(p.writes).toEqual([]);
    expect(p.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("대상에 비밀값이 있으면 실행하지 않고 SecretInTargetError", async () => {
    const log = join(dir, "argv.json");
    setPlan({ argvLog: log, edits: [] });
    await expect(run({ targets: [absOf(home, "memory/leak.md")] })).rejects.toBeInstanceOf(SecretInTargetError);
    await expect(run({ targets: [absOf(home, "memory/notes-token.md")] })).rejects.toBeInstanceOf(SecretInTargetError);
    expect(existsSync(log)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test("실행 인자에 --no-session-persistence 와 --disallowedTools Bash, cwd 는 임시 폴더", async () => {
    const log = join(dir, "argv.json");
    setPlan({ argvLog: log, edits: [] });
    await run();
    const { argv, cwd } = JSON.parse(readFileSync(log, "utf8"));
    expect(argv[0]).toBe("-p");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Bash");
    const a = argv.indexOf("--allowedTools");
    expect(argv.slice(a + 1, a + 6)).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
    expect(argv).toContain("acceptEdits");
    expect(argv[argv.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}'); // 실제 claude 로 받아들여지는 것을 확인했다
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("json");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("30");
    expect(cwd.toLowerCase().startsWith(tmpDir(home).toLowerCase())).toBe(true);
  });

  test("요청문에 비밀값 모양이 있으면 가려서 보낸다", async () => {
    const log = join(dir, "argv.json");
    setPlan({ argvLog: log, edits: [] });
    await run({ prompt: `이 키 ${SECRET} 는 쓰지 마` });
    expect(readFileSync(log, "utf8")).not.toContain(SECRET);
  });

  test("로그인 안 됨(is_error)이면 쉬운 말로 실패하고 임시 폴더를 지운다", async () => {
    setPlan({ isError: true, edits: [] });
    await expect(run()).rejects.toThrow(/Claude/);
    expect(leftovers()).toEqual([]);
  });

  test("타임아웃이면 프로세스를 죽이고 실패", async () => {
    setPlan({ sleepMs: 20000, edits: [{ rel: "memory/a.md", content: "late\n" }] });
    const t0 = Date.now();
    await expect(run({ timeoutMs: 800 })).rejects.toThrow(/시간/);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(readFileSync(absOf(home, "memory/a.md"), "utf8")).toBe("hello\n");
    expect(leftovers()).toEqual([]);
  });

  test("허용 범위가 .claude 밖이면 거부", async () => {
    setPlan({ edits: [] });
    await expect(run({ scopeDirs: [join(home, "elsewhere")] })).rejects.toThrow();
    await expect(run({ targets: [join(home, "x.md")] })).rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });

  test("만든 계획은 applyPlanned 로 적용된다", async () => {
    setPlan({ edits: [{ rel: "memory/a.md", content: "hello\nworld\n" }] });
    const p = await run();
    await applyPlanned(home, p, "f1");
    expect(readFileSync(absOf(home, "memory/a.md"), "utf8")).toBe("hello\nworld\n");
  });
});

describe("resolveClaude / claudeEnv", () => {
  test("환경변수가 있으면 공백으로 나눈 명령", () => {
    process.env.CLAUDE_CHECKUP_CLAUDE = "node  some/script.js";
    try {
      expect(resolveClaude()).toEqual(["node", "some/script.js"]);
    } finally {
      delete process.env.CLAUDE_CHECKUP_CLAUDE;
    }
  });

  test("없는 명령을 가리키면 available false 와 쉬운 말", async () => {
    process.env.CLAUDE_CHECKUP_CLAUDE = join(dir, "no-such-claude");
    try {
      const e = await claudeEnv();
      expect(e.available).toBe(false);
      expect(e.reason).toBeTruthy();
      expect(e.reason).not.toMatch(/ENOENT|spawn/);
      expect(e.reason).not.toMatch(/[—–]/);
    } finally {
      delete process.env.CLAUDE_CHECKUP_CLAUDE;
    }
  });

  test("가짜 claude 는 available true", async () => {
    process.env.CLAUDE_CHECKUP_CLAUDE = CMD.join(" ");
    try {
      expect((await claudeEnv()).available).toBe(true);
    } finally {
      delete process.env.CLAUDE_CHECKUP_CLAUDE;
    }
  });

  test("runClaudeCli 는 못 찾으면 던지지 않고 0 이 아닌 값", async () => {
    expect(await runClaudeCli([join(dir, "no-such-claude")], ["plugin", "disable", "x"])).not.toBe(0);
    expect(await runClaudeCli(null, ["x"])).not.toBe(0);
    expect(await runClaudeCli(CMD, ["--version"])).toBe(0);
  });
});
