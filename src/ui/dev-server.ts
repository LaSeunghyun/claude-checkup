// 화면만 따로 띄우는 개발용 서버: bun run dev:ui
// src/shared/types.ts 의 API 규격을 가짜 데이터로 흉내 낸다. 실제 ~/.claude 는 읽지 않는다.
//
// 상태를 바꿔 보려면 주소 뒤에 ?mock= 을 붙인다 (화면이 이 쿼리를 모든 API 요청에 그대로 붙인다)
//   ?mock=scanning   점검이 끝나지 않고 진행률 60퍼센트에 머문다
//   ?mock=error      점검 실패 화면
//   ?mock=empty      .claude 폴더가 없는 화면
//   ?mock=consent    첫 실행 동의 화면
//   ?mock=first      첫 검진 (지난 점검 요약 없음)
//   ?mock=norisk     위험 진단 없음
//   ?mock=clean      진단이 하나도 없는 깨끗한 설정 (손볼 곳 0)
//   ?mock=risk-only  위험만 있고 할 일은 없음
// 고치기 시트 상태 (기본은 1.5초 뒤 미리 보기, 적용 성공, 되돌리기 성공)
//   ?mock=fix-blocked    미리 보기는 나오지만 적용이 막힌 사례
//   ?mock=fix-consent    claude 고치기 동의가 먼저 필요한 사례 (동의하면 기본 흐름)
//   ?mock=fix-nocli      claude 를 쓸 수 없는 환경 (고치기 대신 맡길 말 복사)
//   ?mock=fix-failed     미리 보기 만들기 실패
//   ?mock=fix-stale      적용이 거절되는 사례 (미리 보기 뒤 파일이 바뀜)
//   ?mock=fix-undo-fail  되돌리기가 거절되는 사례 (그사이 파일이 바뀜)
// 화면의 "다시 점검" 을 누르면 약 5초 동안 진행률 화면이 나온다.
import { join } from "node:path";
import type { Item, Progress, Settings, Snapshot, TelemetryEvent } from "../shared/types";
import { createFixRoutes } from "./dev-fix";
import index from "./index.html";

const fixture = (await Bun.file(join(import.meta.dir, "dev", "fixture-snapshot.json")).json()) as Snapshot;

const SCAN_MS = 5000;
let scanStartedAt: number | null = null;
let settings: Settings = { telemetry: "on", installId: crypto.randomUUID() };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const mockOf = (req: Request) => new URL(req.url).searchParams.get("mock");

function progressNow(req: Request): Progress {
  if (mockOf(req) === "scanning") return { phase: "transcripts", filesDone: 144, filesTotal: 240, message: "개발용 가짜 진행률이에요" };
  if (scanStartedAt === null) return { phase: "done", filesDone: 240, filesTotal: 240 };
  const e = Date.now() - scanStartedAt;
  if (e < 800) return { phase: "inventory", filesDone: 0, filesTotal: 0 };
  if (e < 4200) return { phase: "transcripts", filesDone: Math.floor(((e - 800) / 3400) * 240), filesTotal: 240 };
  if (e < SCAN_MS) return { phase: "diagnose", filesDone: 240, filesTotal: 240 };
  scanStartedAt = null;
  return { phase: "done", filesDone: 240, filesTotal: 240 };
}

function emptySnapshot(): Snapshot {
  return {
    ...fixture,
    context: { budgetTokens: 200000, totalTokens: 0, unusedTokens: 0, parts: [] },
    items: [],
    groups: [],
    findings: [],
    warnings: ["~/.claude 폴더를 찾지 못했어요."],
  };
}

// 첫 화면 상태 확인용: 같은 가짜 데이터에서 일부만 걷어 낸다
function variant(mock: string | null): Snapshot {
  const strip = (findings: Snapshot["findings"]): Snapshot => ({
    ...fixture,
    findings,
    items: fixture.items.map((i) => ({ ...i, findings: i.findings.filter((id) => findings.some((f) => f.id === id)) })),
  });
  if (mock === "first") return { ...fixture, previous: undefined };
  if (mock === "norisk") return strip(fixture.findings.filter((f) => f.category !== "risk"));
  if (mock === "risk-only") return strip(fixture.findings.filter((f) => f.category === "risk"));
  if (mock === "clean") return { ...strip([]), previous: undefined };
  return fixture;
}

function bodyFor(it: Item): string {
  const fm = ["skill", "agent", "command"].includes(it.kind) ? `---\nname: ${it.name}\ndescription: ${it.summary}\n---\n\n` : "";
  const heads = it.outline.length ? it.outline : ["개요"];
  const reps = Math.max(1, Math.min(30, Math.round(it.size.lines / (heads.length * 5))));
  const para = "이 문단은 개발용 가짜 본문이에요. 실제 파일 내용은 서버가 파일에서 읽어서 보내 줘요.\n- 첫째 규칙은 짧게 쓰는 거예요.\n- 둘째 규칙은 근거를 같이 적는 거예요.\n";
  const sections = heads.map((h) => `## ${h}\n\n${Array.from({ length: reps }, () => para).join("\n")}`).join("\n");
  return `${fm}# ${it.name}\n\n${it.summary}\n\n${sections}`;
}

function previewEvent(): TelemetryEvent {
  return {
    installId: settings.installId ?? "(동의하면 무작위 번호가 만들어져요)",
    appVersion: "0.1.0",
    os: "windows",
    event: "view_open",
    view: "home",
  };
}

const routes = {
  "/": index,

  "/api/snapshot": (req: Request) => {
    const mock = mockOf(req);
    if (mock === "error") return json({ error: "~/.claude 폴더를 읽는 중에 권한 문제가 생겼어요. 폴더 권한을 확인한 뒤 다시 점검해 주세요." }, 500);
    const p = progressNow(req);
    if (p.phase !== "done") return json(p, 404);
    return json(mock === "empty" ? emptySnapshot() : variant(mock));
  },

  "/api/progress": (req: Request) => json(progressNow(req)),

  "/api/rescan": (req: Request) => {
    scanStartedAt = Date.now();
    return json(progressNow(req));
  },

  "/api/item-body": (req: Request) => {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const it = fixture.items.find((i) => i.id === id);
    if (!it) return json({ error: "없는 항목이에요" }, 404);
    // 실제 서버는 이름에 token, secret 등이 든 파일을 막는다
    if (/token|secret|credential/i.test(`${it.name} ${it.path ?? ""}`)) return json({ error: "forbidden" }, 403);
    return json({ id, body: bodyFor(it) });
  },

  "/api/settings": async (req: Request) => {
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { telemetry?: string; claudeFix?: string };
      if (body.claudeFix === "agreed") {
        settings = { ...settings, claudeFix: "agreed" };
        return json(settings);
      }
      if (body.telemetry !== "on" && body.telemetry !== "off") return json({ error: "telemetry 는 on 또는 off 여야 해요" }, 400);
      settings = body.telemetry === "on" ? { telemetry: "on", installId: settings.installId ?? crypto.randomUUID() } : { telemetry: "off" };
      return json(settings);
    }
    // 동의 화면 확인용: 저장된 값과 상관없이 아직 안 물어본 상태로 보여 준다
    return json(mockOf(req) === "consent" ? { telemetry: null } : settings);
  },

  "/api/telemetry-preview": () => json(previewEvent()),

  "/api/telemetry": async (req: Request) => {
    const body = (await req.json().catch(() => ({}))) as { event?: string; view?: string };
    console.log(`[telemetry] ${body.event ?? "?"} ${body.view ?? ""}${settings.telemetry === "on" ? "" : " (끔: 서버가 보내지 않아요)"}`);
    return new Response(null, { status: 204 });
  },
};

const fixRoutes = createFixRoutes({ fixture, getSettings: () => settings });

function start(port: number) {
  return Bun.serve({ port, hostname: "127.0.0.1", development: true, routes: { ...routes, ...fixRoutes } });
}

let server: ReturnType<typeof start>;
try {
  server = start(Number(process.env.PORT ?? 4173));
} catch {
  server = start(0); // 기본 포트가 쓰이고 있으면 아무 포트나 쓴다
}
console.log(`화면 개발 서버: ${server.url}`);
console.log("  상태 확인: ?mock=scanning | error | empty | consent | first | norisk | clean | risk-only | fix-blocked | fix-consent | fix-nocli | fix-failed | fix-stale | fix-undo-fail");
