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
let session: string; // 키를 한 번 바꿔서 받은 `이름=값` 쿠키
const cookie = () => ({ cookie: session });
const get = (path: string, headers: Record<string, string> = cookie()) => fetch(base + path, { headers });
const post = (path: string, body?: unknown, headers: Record<string, string> = cookie()) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

// 브라우저가 처음 주소(?key=)를 여는 것과 같다. 쿠키 `이름=값` 만 돌려준다
const exchange = (s: Running) => fetch(`http://127.0.0.1:${s.port}/?key=${s.key}`, { redirect: "manual" });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

// 점검할 것이 없는 빈 홈으로 서버를 하나 더 띄운다
async function extraServer() {
  const d = mkdtempSync(join(tmpdir(), "cc-server-extra-"));
  const s = startServer({ home: d, port: 0, open: false });
  await s.firstScan;
  return { s, stop: () => (s.stop(), rmSync(d, { recursive: true, force: true })) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-server-"));
  fx = buildFixtureHome(dir);
  srv = startServer({ home: fx.home, port: 0, open: false });
  base = `http://127.0.0.1:${srv.port}`;
  await srv.firstScan;
  session = cookieOf(await exchange(srv));
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
    const name = `cc_key_${srv.port}`;
    expect((await get("/api/progress", { cookie: `${name}=wrong` })).status).toBe(403);
    expect((await get("/api/progress", { cookie: `${name}=${srv.key}` })).status).toBe(403); // 주소의 키는 쿠키 값으로 못 쓴다
    expect((await get("/api/progress", { cookie: `cc_key=${session.split("=")[1]}` })).status).toBe(403); // 이름이 다르면 모른다
    expect((await fetch(`${base}/?key=wrong`, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(403);
  });
  test("첫 접속 ?key= 는 별도 세션 값의 HttpOnly SameSite=Strict 쿠키로 바뀌고 주소에서 키가 사라진다", async () => {
    const { s, stop } = await extraServer();
    try {
      const r = await exchange(s);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/app");
      const c = r.headers.get("set-cookie") ?? "";
      expect(c).toStartWith(`cc_key_${s.port}=`);
      expect(c).not.toContain(s.key); // 쿠키 값은 주소의 키와 다른 무작위 값
      expect(c.split(";")[0].split("=")[1].length).toBeGreaterThanOrEqual(32);
      expect(c).toContain("HttpOnly");
      expect(c).toContain("SameSite=Strict");
      expect((await fetch(`http://127.0.0.1:${s.port}/api/progress`, { headers: { cookie: cookieOf(r) } })).status).toBe(200);
    } finally {
      stop();
    }
  });
  test("키는 한 번만 쓴다", async () => {
    const { s, stop } = await extraServer();
    try {
      expect((await exchange(s)).status).toBe(302);
      const again = await exchange(s);
      expect(again.status).toBe(403);
      expect(again.headers.get("set-cookie")).toBeNull();
    } finally {
      stop();
    }
  });
  test("두 번 실행해도 첫 탭 쿠키가 산다", async () => {
    const a = await extraServer();
    const b = await extraServer();
    try {
      const ca = cookieOf(await exchange(a.s));
      const cb = cookieOf(await exchange(b.s));
      expect(ca.split("=")[0]).toBe(`cc_key_${a.s.port}`);
      expect(cb.split("=")[0]).toBe(`cc_key_${b.s.port}`);
      expect(ca.split("=")[0]).not.toBe(cb.split("=")[0]);
      // 쿠키는 포트와 상관없이 같은 호스트에 모인다. 둘 다 들어 있어도 각 서버는 제 것만 본다
      const jar = { cookie: `${ca}; ${cb}` };
      expect((await fetch(`http://127.0.0.1:${a.s.port}/api/progress`, { headers: jar })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${b.s.port}/api/progress`, { headers: jar })).status).toBe(200);
      // 대조: 다른 서버의 쿠키만으로는 못 들어간다
      expect((await fetch(`http://127.0.0.1:${a.s.port}/api/progress`, { headers: { cookie: cb } })).status).toBe(403);
    } finally {
      a.stop();
      b.stop();
    }
  });
  test("보안 헤더: 화면, API, 거절 응답 모두", async () => {
    const check = (r: Response) => {
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    };
    check(await fetch(`${base}/app`));
    check(await get("/api/progress"));
    check(await get("/api/progress", {})); // 403
    check(await fetch(`${base}/nope`)); // 404
    const html = await (await fetch(`${base}/app`)).text();
    const asset = /(?:src|href)="(\/[^"]+\.(?:js|css))"/.exec(html)?.[1];
    expect(asset).toBeDefined(); // 화면이 쓰는 파일도 같은 서버에서 받아진다
    const a = await fetch(base + asset!);
    expect(a.status).toBe(200);
    check(a);
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
  test("원문 응답에 비밀값이 없다", async () => {
    const r = await get(`/api/item-body?id=${encodeURIComponent("skill:user::good-skill")}`);
    const body = ((await r.json()) as { body: string }).body;
    expect(body).toContain("# Good skill"); // 대조: 본문은 그대로 온다
    expect(body).not.toContain("ghp_");
    expect(body).toContain("***");
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
