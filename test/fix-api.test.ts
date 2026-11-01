// 고치기 API (Task 8): 가짜 홈 + 가짜 claude(test/fixtures/fake-claude.ts). 진짜 claude 와 진짜 ~/.claude 는 쓰지 않는다
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type Running } from "../src/server/main";
import { buildEvent, loadSettings, setClaudeFix, setTelemetry } from "../src/server/telemetry";
import type { Finding, FixJob, Settings, Snapshot } from "../src/shared/types";
import { buildFixtureHome, type Fixture } from "./fixtures/build";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const FAKE_CMD = `${process.execPath} run ${FAKE}`;

let dir: string;
let fx: Fixture;
let srv: Running;
let base: string;
let session: string;
let planFile: string;
let argvLog: string;

const H = () => ({ cookie: session });
const get = (p: string) => fetch(base + p, { headers: H() });
const post = (p: string, body?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...H() }, body: body === undefined ? undefined : JSON.stringify(body) });
const setPlan = (p: object) => writeFileSync(planFile, JSON.stringify({ argvLog, ...p }));
const claudeDir = () => join(fx.home, ".claude");
const settingsPath = () => join(claudeDir(), "settings.json");

async function snapshot(): Promise<Snapshot> {
  return (await (await get("/api/snapshot")).json()) as Snapshot;
}
async function findingOf(rule: string, pred: (f: Finding) => boolean = () => true): Promise<Finding> {
  const f = (await snapshot()).findings.find((x) => x.rule === rule && pred(x));
  if (!f) throw new Error("진단 없음: " + rule);
  return f;
}
async function waitJob(id: string): Promise<FixJob> {
  const t0 = Date.now();
  for (;;) {
    const j = (await (await get(`/api/fix/job?id=${id}`)).json()) as FixJob;
    if (j.status !== "running") return j;
    if (Date.now() - t0 > 30_000) throw new Error("작업이 끝나지 않음");
    await Bun.sleep(50);
  }
}
async function preview(body: object): Promise<FixJob> {
  const r = await post("/api/fix/preview", body);
  expect(r.status).toBe(200);
  const job = (await r.json()) as FixJob;
  expect(job.status).toBe("running");
  return waitJob(job.id);
}
const agree = async () => expect((await post("/api/settings", { claudeFix: "agreed" })).status).toBe(200);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-fixapi-"));
  fx = buildFixtureHome(join(dir, "home"));
  planFile = join(dir, "plan.json");
  argvLog = join(dir, "argv.json");
  writeFileSync(planFile, JSON.stringify({ edits: [] }));
  mkdirSync(join(dir, "cfg", "projects"), { recursive: true });
  process.env.CHECKUP_FAKE_PLAN = planFile;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "cfg");
  process.env.CLAUDE_CHECKUP_CLAUDE = FAKE_CMD;
  srv = startServer({ home: fx.home, port: 0, open: false });
  base = `http://127.0.0.1:${srv.port}`;
  await srv.firstScan;
  const r = await fetch(`${base}/?key=${srv.key}`, { redirect: "manual" });
  session = (r.headers.get("set-cookie") ?? "").split(";")[0];
});

afterEach(() => {
  srv.stop();
  delete process.env.CHECKUP_FAKE_PLAN;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CHECKUP_CLAUDE;
  rmSync(dir, { recursive: true, force: true });
});

describe("기계적 고치기", () => {
  test("unused-plugin 미리 보기 → 적용 → 되돌리기 전체 흐름", async () => {
    const original = readFileSync(settingsPath(), "utf8");
    const f = await findingOf("unused-plugin");
    const job = await preview({ findingId: f.id });
    expect(job.status).toBe("ready");
    expect(job.kind).toBe("mechanical");
    expect(job.preview!.changes[0]).toMatchObject({ rel: "settings.json", kind: "plugin-off" });
    expect(job.preview!.changes[0].diff.some((l) => l.op === "+" && l.text.includes('"plugin-unused@mkt": false'))).toBe(true);
    expect(readFileSync(settingsPath(), "utf8")).toBe(original); // 미리 보기는 파일을 바꾸지 않는다

    const r = await post("/api/fix/apply", { jobId: job.id });
    expect(r.status).toBe(200);
    const done = (await r.json()) as FixJob;
    expect(done.status).toBe("applied");
    expect(done.backupId).toBeTruthy();
    expect(done.result!.after.totalTokens).toBeLessThan(done.result!.before.totalTokens);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).enabledPlugins["plugin-unused@mkt"]).toBe(false);
    // 다시 점검한 결과가 서버 스냅샷에 들어갔다
    expect((await snapshot()).findings.some((x) => x.rule === "unused-plugin")).toBe(false);

    const list = (await (await get("/api/fix/backups")).json()) as { id: string; findingId: string }[];
    expect(list.map((b) => b.id)).toContain(done.backupId!);
    expect(list.find((b) => b.id === done.backupId)!.findingId).toBe(f.id);

    const u = await post("/api/fix/undo", { backupId: done.backupId });
    expect(u.status).toBe(200);
    const ur = (await u.json()) as { ok: boolean; message: string };
    expect(ur.ok).toBe(true);
    expect(readFileSync(settingsPath(), "utf8")).toBe(original);
    expect((await snapshot()).findings.some((x) => x.rule === "unused-plugin")).toBe(true);
    const job2 = (await (await get(`/api/fix/job?id=${job.id}`)).json()) as FixJob;
    expect(job2.status).toBe("undone");
    // 적용과 되돌리기 뒤 점검도 기록에 남는다
    const hist = JSON.parse(readFileSync(join(fx.home, ".claude-checkup", "history.json"), "utf8"));
    expect(hist.length).toBeGreaterThanOrEqual(3);
  });

  test("effects 에 대화마다 A4 줄어드는 항목이 good", async () => {
    const job = await preview({ findingId: (await findingOf("unused-plugin")).id });
    const good = job.preview!.effects.filter((e) => e.tone === "good");
    const perTurn = good.find((e) => e.label.includes("대화"));
    expect(perTurn).toBeTruthy();
    expect(perTurn!.before).toContain("A4");
    expect(perTurn!.before).not.toBe(perTurn!.after);
  });

  test("turnsOff 에 구성 이름과 30일 사용", async () => {
    const job = await preview({ findingId: (await findingOf("unused-plugin")).id });
    const names = job.preview!.turnsOff.map((t) => t.name);
    expect(names).toContain("idle");
    expect(names).toContain("idle-agent");
    expect(job.preview!.turnsOff.every((t) => t.uses30 === 0 && t.detail.length > 0)).toBe(true);
  });

  test("경로를 body 로 보내도 무시된다(itemIds 는 그 진단의 items 안의 것만)", async () => {
    const f = await findingOf("unread-md");
    const keep = f.items.find((id) => id.includes("named-only"))!;
    const job = await preview({ findingId: f.id, itemIds: [keep, "C:/Windows/win.ini", "../../etc/passwd", "memory:user::claude.md"], path: join(fx.home, "x") });
    expect(job.status).toBe("ready");
    expect(job.preview!.changes.map((c) => c.rel)).toEqual(["projects/C--fx-alpha/memory/named-only.md"]);
    // 고를 수 있는 것이 하나도 없으면 거절
    const bad = await post("/api/fix/preview", { findingId: f.id, itemIds: ["/etc/passwd"] });
    expect(bad.status).toBe(400);
    // 없는 진단, 직접 하는 진단
    expect((await post("/api/fix/preview", { findingId: "nope:1" })).status).toBe(404);
    expect((await post("/api/fix/preview", { findingId: (await findingOf("duplicate-name")).id })).status).toBe(400);
  });

  test("같은 settings.json 을 바꾸는 적용 두 개를 동시에 보내면 하나만 되고 하나는 409", async () => {
    process.env.CHECKUP_FAKE_PLUGIN_SLEEP_MS = "800"; // 해시 검사와 쓰기 사이가 길다
    try {
      const a = await preview({ findingId: (await findingOf("unused-plugin")).id });
      const b = await preview({ findingId: (await findingOf("unused-items", (f) => f.items.some((id) => id.startsWith("skill:plugin:"))) ).id });
      const rs = await Promise.all([post("/api/fix/apply", { jobId: a.id }), post("/api/fix/apply", { jobId: b.id })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      const bad = rs.find((r) => r.status === 409)!;
      expect(((await bad.json()) as { error: string }).error).toContain("그사이 바뀌었어요");
    } finally {
      delete process.env.CHECKUP_FAKE_PLUGIN_SLEEP_MS;
    }
  });

  test("같은 진단의 claude 미리 보기를 두 번 보내면 같은 작업을 돌려준다", async () => {
    await agree();
    setPlan({ edits: [], sleepMs: 800 });
    const f = await findingOf("memory-index-near-limit");
    const j1 = (await (await post("/api/fix/preview", { findingId: f.id })).json()) as FixJob;
    const j2 = (await (await post("/api/fix/preview", { findingId: f.id })).json()) as FixJob;
    expect(j2.id).toBe(j1.id);
    await waitJob(j1.id);
  });

  test("백업 id 에 .. 는 받지 않는다", async () => {
    const ur = (await (await post("/api/fix/undo", { backupId: ".." })).json()) as { ok: boolean };
    expect(ur.ok).toBe(false);
  });

  test("미리 보기 뒤 원본이 바뀌면 적용은 409 와 다시 만들라는 말", async () => {
    const job = await preview({ findingId: (await findingOf("unused-plugin")).id });
    writeFileSync(settingsPath(), readFileSync(settingsPath(), "utf8") + "\n");
    const r = await post("/api/fix/apply", { jobId: job.id });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("그사이 바뀌었어요");
  });

  test("적용 뒤 다시 고친 파일은 되돌리지 않고, 말에는 홈 절대경로 대신 ~", async () => {
    const job = await preview({ findingId: (await findingOf("unused-plugin")).id });
    const done = (await (await post("/api/fix/apply", { jobId: job.id })).json()) as FixJob;
    writeFileSync(settingsPath(), "{}\n");
    const ur = (await (await post("/api/fix/undo", { backupId: done.backupId })).json()) as { ok: boolean; message: string };
    expect(ur.ok).toBe(false);
    expect(ur.message).toContain("~/.claude-checkup/backups");
    expect(ur.message.toLowerCase()).not.toContain(fx.home.toLowerCase());
    expect(ur.message.toLowerCase()).not.toContain(fx.home.replace(/\\/g, "/").toLowerCase());
    expect((await post("/api/fix/undo", {})).status).toBe(400);
  });
});

describe("Claude 고치기", () => {
  const nearRel = "projects/C--fx-near/memory/MEMORY.md";
  const near = () => findingOf("memory-index-near-limit");

  test("claude 규칙은 동의 전 409", async () => {
    const r = await post("/api/fix/preview", { findingId: (await near()).id });
    expect(r.status).toBe(409);
    const b = (await r.json()) as { error: string; needConsent: boolean };
    expect(b.needConsent).toBe(true);
    expect(b.error.length).toBeGreaterThan(0);
  });

  test("동의 후 job 이 ready, preview.changes 에 diff, 사용량과 예상 사용량", async () => {
    await agree();
    expect(((await (await get("/api/settings")).json()) as Settings).claudeFix).toBe("agreed");
    setPlan({ edits: [{ rel: nearRel, content: "# near\n- 줄인 목차\n" }] });
    const r = await post("/api/fix/preview", { findingId: (await near()).id });
    const started = (await r.json()) as FixJob;
    expect(started.kind).toBe("claude");
    expect(started.message).toContain("예상");
    const job = await waitJob(started.id);
    expect(job.status).toBe("ready");
    const ch = job.preview!.changes.find((c) => c.rel === nearRel)!;
    expect(ch.kind).toBe("modified");
    expect(ch.diff.some((l) => l.op === "-")).toBe(true);
    expect(ch.diff.some((l) => l.op === "+" && l.text === "- 줄인 목차")).toBe(true);
    expect(job.preview!.usage).toBeTruthy();
    expect(job.preview!.effects.some((e) => e.tone === "good")).toBe(true);
    // 요청문은 임시 폴더 기준 경로. 실제 홈 경로나 ~/.claude 는 싣지 않는다
    const sent = JSON.parse(readFileSync(argvLog, "utf8")) as { stdin: string };
    expect(sent.stdin).toContain("projects/C--fx-near/memory/MEMORY.md");
    expect(sent.stdin).not.toContain("~/.claude");
    expect(sent.stdin.toLowerCase()).not.toContain(fx.home.replace(/\\/g, "/").toLowerCase());
    expect(sent.stdin).toContain("180줄");
    // 적용하면 바뀐다
    const done = (await (await post("/api/fix/apply", { jobId: job.id })).json()) as FixJob;
    expect(done.status).toBe("applied");
    expect(readFileSync(join(claudeDir(), ...nearRel.split("/")), "utf8")).toBe("# near\n- 줄인 목차\n");
  });

  test("새 고장이 생기는 변경안은 blocked", async () => {
    await agree();
    const before = readFileSync(join(claudeDir(), ...nearRel.split("/")), "utf8");
    const big = "# near\n" + Array.from({ length: 200 }, (_, i) => `- line ${i}`).join("\n") + "\n"; // 201줄
    setPlan({ edits: [{ rel: nearRel, content: big }] });
    const job = await preview({ findingId: (await near()).id });
    expect(job.status).toBe("ready");
    expect(job.preview!.blocked).toBeTruthy();
    const r = await post("/api/fix/apply", { jobId: job.id });
    expect(r.status).toBe(409);
    expect(readFileSync(join(claudeDir(), ...nearRel.split("/")), "utf8")).toBe(before);
  });

  test("claude 없음 → /api/fix/env available false 이고 claude 규칙 preview 는 400 fallback copy", async () => {
    process.env.CLAUDE_CHECKUP_CLAUDE = join(dir, "no-such-claude");
    const env = (await (await get("/api/fix/env")).json()) as { available: boolean; reason?: string };
    expect(env.available).toBe(false);
    expect(env.reason).toBeTruthy();
    await agree();
    const r = await post("/api/fix/preview", { findingId: (await near()).id });
    expect(r.status).toBe(400);
    const b = (await r.json()) as { error: string; fallback: string };
    expect(b.fallback).toBe("copy");
    // 동의 전에도 같은 대체 (동의를 받아도 쓸 수 없으므로)
    // 기계적 고치기는 그대로 된다. 플러그인 끄기는 설정 파일로 대신한다
    const job = await preview({ findingId: (await findingOf("unused-plugin")).id });
    const done = (await (await post("/api/fix/apply", { jobId: job.id })).json()) as FixJob;
    expect(done.status).toBe("applied");
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).enabledPlugins["plugin-unused@mkt"]).toBe(false);
  });

  test("로그인 안 됨(is_error) → job failed, 쉬운 말", async () => {
    await agree();
    setPlan({ isError: true, edits: [] });
    const job = await preview({ findingId: (await near()).id });
    expect(job.status).toBe("failed");
    expect(job.message).toContain("맡길 말");
  });

  test("unreachable-md 보관 후보: 결과 json 을 읽고, 적용 때 체크한 것만 보관 폴더로", async () => {
    await agree();
    const f = await findingOf("unreachable-md", (x) => x.fixKind === "claude");
    const orphanId = f.items.find((id) => id.includes("orphan"))!;
    setPlan({ edits: [], result: '정리했어요.\n```json\n{"archive":[{"file":"projects/C--fx-alpha/memory/orphan.md","reason":"오래된 메모"},{"file":"../../outside.md","reason":"x"}]}\n```' });
    const job = await preview({ findingId: f.id, itemIds: [orphanId] });
    expect(job.status).toBe("ready");
    expect(job.preview!.candidates).toEqual([{ itemId: orphanId, rel: "projects/C--fx-alpha/memory/orphan.md", reason: "오래된 메모" }]);
    const sent = JSON.parse(readFileSync(argvLog, "utf8")) as { stdin: string };
    expect(sent.stdin).toContain('"archive"');
    const done = (await (await post("/api/fix/apply", { jobId: job.id, archive: [orphanId, "memory:user::claude.md", "C:/x"] })).json()) as FixJob;
    expect(done.status).toBe("applied");
    const orphan = join(claudeDir(), "projects", "C--fx-alpha", "memory", "orphan.md");
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(fx.home, ".claude-checkup", "off", "projects", "C--fx-alpha", "memory", "orphan.md"))).toBe(true);
    expect(existsSync(join(claudeDir(), "CLAUDE.md"))).toBe(true);
  });

  test("결과에 보관 블록이 없거나 깨지면 후보는 빈 목록", async () => {
    await agree();
    const f = await findingOf("unreachable-md", (x) => x.fixKind === "claude");
    setPlan({ edits: [], result: "```json\n{ broken" });
    const job = await preview({ findingId: f.id });
    expect(job.preview!.candidates).toEqual([]);
  });
});

describe("설정과 통계", () => {
  test("claudeFix 동의는 통계 설정과 따로 남는다", () => {
    const h = join(dir, "h2");
    setClaudeFix(h);
    expect(loadSettings(h).claudeFix).toBe("agreed");
    setTelemetry(h, "on");
    expect(loadSettings(h).claudeFix).toBe("agreed");
    setTelemetry(h, "off");
    expect(loadSettings(h)).toEqual({ telemetry: "off", claudeFix: "agreed" });
  });

  test("fix 이벤트는 종류만 담는다", () => {
    const s: Settings = { telemetry: "on", installId: "00000000-0000-4000-8000-000000000000" };
    for (const event of ["fix_preview", "fix_apply", "fix_undo"] as const) {
      const ev = buildEvent(s, null, { event, view: "home" })!;
      expect(Object.keys(ev).sort()).toEqual(["appVersion", "event", "installId", "os"]);
      expect(ev.event).toBe(event);
    }
  });
});
