import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type Running } from "../src/server/main";
import { TELEMETRY_URL, buildEvent } from "../src/server/telemetry";
import type { Progress, Settings, Snapshot, TelemetryEvent } from "../src/shared/types";
import { buildFixtureHome, type Fixture } from "./fixtures/build";

let dir: string;
let fx: Fixture;
let srv: Running;
let base: string;
const cookie = () => ({ cookie: `cc_key=${srv.key}` });
const get = (path: string, headers: Record<string, string> = cookie()) => fetch(base + path, { headers });
const post = (path: string, body?: unknown, headers: Record<string, string> = cookie()) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-server-"));
  fx = buildFixtureHome(dir);
  srv = startServer({ home: fx.home, port: 0, open: false });
  base = `http://127.0.0.1:${srv.port}`;
  await srv.firstScan;
});

afterAll(() => {
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("접근 제어", () => {
  test("127.0.0.1 임의 포트, 주소에 키가 있다", () => {
    expect(srv.port).toBeGreaterThan(0);
    expect(srv.url).toBe(`${base}/?key=${srv.key}`);
    expect(srv.key.length).toBeGreaterThanOrEqual(32);
  });
  test("쿠키 없이 /api 를 부르면 403", async () => {
    for (const p of ["/api/snapshot", "/api/progress", "/api/settings", "/api/telemetry-preview", "/api/item-body?id=x"]) {
      expect((await get(p, {})).status).toBe(403);
    }
    expect((await post("/api/rescan", undefined, {})).status).toBe(403);
    expect((await post("/api/telemetry", { event: "launch" }, {})).status).toBe(403);
  });
  test("틀린 키·쿠키는 403", async () => {
    expect((await get("/api/progress", { cookie: "cc_key=wrong" })).status).toBe(403);
    expect((await fetch(`${base}/?key=wrong`, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(403);
  });
  test("첫 접속 ?key= 는 HttpOnly SameSite=Strict 쿠키로 바뀌고 주소에서 키가 사라진다", async () => {
    const r = await fetch(`${base}/?key=${srv.key}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
    const c = r.headers.get("set-cookie") ?? "";
    expect(c).toContain(`cc_key=${srv.key}`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
  });
  test("/app 은 화면(HTML 번들)을 준다", async () => {
    const page = await fetch(`${base}/app`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
  test("Host 가 127.0.0.1:포트 나 localhost:포트 가 아니면 403", async () => {
    const bad = await get("/api/progress", { ...cookie(), host: "evil.example.com" });
    expect(bad.status).toBe(403);
    const local = await fetch(`http://localhost:${srv.port}/api/progress`, { headers: cookie() });
    expect(local.status).toBe(200);
  });
  test("쓰기 요청은 다른 Origin 이면 403", async () => {
    expect((await post("/api/telemetry", { event: "launch" }, { ...cookie(), origin: "http://evil.example.com" })).status).toBe(403);
  });
});

describe("API", () => {
  test("snapshot 은 점검이 끝난 뒤 Snapshot 을 준다", async () => {
    const r = await get("/api/snapshot");
    expect(r.status).toBe(200);
    const s = (await r.json()) as Snapshot;
    expect(s.version).toBe(1);
    expect(s.items.length).toBeGreaterThan(30);
    expect(s.home).toBe("~");
  });
  test("progress 는 done", async () => {
    const p = (await (await get("/api/progress")).json()) as Progress;
    expect(p.phase).toBe("done");
    expect(p.filesTotal).toBe(4);
  });
  test("rescan 은 Progress 를 주고 끝나면 스냅샷이 새로 생긴다", async () => {
    const before = ((await (await get("/api/snapshot")).json()) as Snapshot).generatedAt;
    const r = await post("/api/rescan");
    expect(r.status).toBe(200);
    expect(["inventory", "transcripts", "diagnose", "done"]).toContain(((await r.json()) as Progress).phase);
    for (let i = 0; i < 100; i++) {
      const p = (await (await get("/api/progress")).json()) as Progress;
      if (p.phase === "done") break;
      await Bun.sleep(30);
    }
    const after = ((await (await get("/api/snapshot")).json()) as Snapshot).generatedAt;
    expect(after >= before).toBe(true);
  });
  test("item-body: 알려진 항목의 파일 본문", async () => {
    const r = await get(`/api/item-body?id=${encodeURIComponent("skill:user::good-skill")}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { id: string; body: string };
    expect(j.id).toBe("skill:user::good-skill");
    expect(j.body).toContain("# Good skill");
  });
  test("item-body: 알 수 없는 id 는 404, 클라이언트 경로는 받지 않는다", async () => {
    expect((await get("/api/item-body?id=nope")).status).toBe(404);
    expect((await get("/api/item-body")).status).toBe(404);
    expect((await get(`/api/item-body?id=nope&path=${encodeURIComponent(join(fx.home, ".claude", "settings.json"))}`)).status).toBe(404);
    expect((await get(`/api/item-body?id=${encodeURIComponent(join(fx.home, ".claude", ".credentials.json"))}`)).status).toBe(404);
  });
  test("item-body: 비밀 이름 파일은 403 이고 내용이 안 나온다", async () => {
    const r = await get(`/api/item-body?id=${encodeURIComponent("memory:project:fx-alpha:secret-token-notes.md")}`);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain("FAKESECRET");
  });
  test("item-body: 훅과 연결된 서비스는 값 없이 이름과 명령만", async () => {
    const h = await get(`/api/item-body?id=${encodeURIComponent("hook:user::stop · slow-hook.mjs")}`);
    expect(((await h.json()) as { body: string }).body).toContain("slow-hook.mjs");
    const m = await get(`/api/item-body?id=${encodeURIComponent("mcp:user::svc-env")}`);
    const body = ((await m.json()) as { body: string }).body;
    expect(body).toContain("svc-env");
    expect(body).not.toContain("FAKESECRET");
  });
});

describe("익명 사용 통계", () => {
  test("받는 주소는 기본으로 비어 있다 (아무것도 안 보낸다)", () => {
    expect(TELEMETRY_URL).toBe("");
  });
  test("처음엔 묻지 않은 상태이고 installId 가 없다", async () => {
    expect(await (await get("/api/settings")).json()).toEqual({ telemetry: null });
    expect(existsSync(join(fx.home, ".claude-checkup", "settings.json"))).toBe(false);
  });
  test("미리보기는 보낼 JSON 모양 그대로", async () => {
    const ev = (await (await get("/api/telemetry-preview")).json()) as TelemetryEvent;
    expect(Object.keys(ev).sort()).toEqual(["appVersion", "event", "installId", "itemCount", "os", "scanSeconds"]);
    expect(["windows", "macos", "linux", "other"]).toContain(ev.os);
    expect(ev.scanSeconds).toBe("0-9");
    expect(ev.itemCount).toMatch(/^(50-99|100-199)$/);
  });
  test("동의하면 installId 가 생기고, 끄면 지워진다", async () => {
    const on = (await (await post("/api/settings", { telemetry: "on" })).json()) as Settings;
    expect(on.telemetry).toBe("on");
    expect(on.installId).toMatch(/^[0-9a-f-]{36}$/);
    const file = JSON.parse(readFileSync(join(fx.home, ".claude-checkup", "settings.json"), "utf8"));
    expect(file).toEqual({ telemetry: "on", installId: on.installId });
    const again = (await (await post("/api/settings", { telemetry: "on" })).json()) as Settings;
    expect(again.installId).toBe(on.installId as string);
    const prev = (await (await get("/api/telemetry-preview")).json()) as TelemetryEvent;
    expect(prev.installId).toBe(on.installId as string);
    const off = (await (await post("/api/settings", { telemetry: "off" })).json()) as Settings;
    expect(off).toEqual({ telemetry: "off" });
    expect(JSON.parse(readFileSync(join(fx.home, ".claude-checkup", "settings.json"), "utf8"))).toEqual({ telemetry: "off" });
  });
  test("잘못된 설정 값은 400", async () => {
    expect((await post("/api/settings", { telemetry: "maybe" })).status).toBe(400);
    expect((await post("/api/settings", {})).status).toBe(400);
  });
  test("POST /api/telemetry 는 204, 잘못된 본문은 400", async () => {
    expect((await post("/api/telemetry", { event: "view_open", view: "home" })).status).toBe(204);
    expect((await post("/api/telemetry", { event: "bogus" })).status).toBe(204);
    const bad = await fetch(`${base}/api/telemetry`, { method: "POST", headers: { ...cookie(), "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });
  test("이벤트 만들기: 허용된 필드만, 구간 값만", () => {
    const s: Settings = { telemetry: "on", installId: "00000000-0000-4000-8000-000000000000" };
    const snap = { stats: { durationMs: 75_000 }, items: new Array(250) } as unknown as Snapshot;
    const done = buildEvent(s, snap, { event: "scan_done" })!;
    expect(done).toMatchObject({ event: "scan_done", scanSeconds: "60-299", itemCount: "200-499" });
    expect(Object.keys(done).sort()).toEqual(["appVersion", "event", "installId", "itemCount", "os", "scanSeconds"]);
    expect(buildEvent(s, snap, { event: "view_open", view: "findings" })).toMatchObject({ view: "findings" });
    expect(buildEvent(s, snap, { event: "view_open", view: "C:/secret/path" })).toBeNull();
    expect(buildEvent(s, snap, { event: "other" })).toBeNull();
    const launch = buildEvent(s, null, { event: "launch" })!;
    expect(Object.keys(launch).sort()).toEqual(["appVersion", "event", "installId", "os"]);
  });
});
