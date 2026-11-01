// 로컬 서버: 127.0.0.1 임의 포트, 시작할 때 만든 키로 접근을 막는다.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import index from "../ui/index.html";
import { expandHome, isSecretName, readText, redactSecrets } from "../scan/fsutil";
import { scan } from "../scan";
import type { Item, Progress, Settings, Snapshot } from "../shared/types";
import { buildEvent, loadSettings, sendTelemetry, setTelemetry } from "./telemetry";

const COOKIE = "cc_key";
const BODY_MAX = 400_000;

export interface ServerOpts {
  home: string;
  port?: number;
  key?: string;
  open?: boolean;
  quiet?: boolean;
}

export interface Running {
  url: string;
  key: string;
  port: number;
  stop(): void;
  firstScan: Promise<void>;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// 항목 종류별 본문. 파일이 있는 종류만 파일을 읽는다 (경로는 항상 스냅샷의 항목에서 얻는다)
function bodyOf(item: Item, home: string): { status: number; body?: string; error?: string } {
  if (item.hook) {
    const h = item.hook;
    return { status: 200, body: `실행 시점: ${h.event}\n${h.matcher ? `대상: ${h.matcher}\n` : ""}실행 명령: ${h.command}\n` };
  }
  if (item.kind === "mcp") return { status: 200, body: `연결된 서비스 이름: ${item.name}\n보안을 위해 주소나 키 같은 설정 값은 읽지 않아요.\n` };
  if (item.kind === "plugin" || !item.path) return { status: 200, body: `${item.summary}\n` };
  const abs = resolve(expandHome(item.path, home));
  if (isSecretName(abs)) return { status: 403, error: "민감한 이름의 파일은 보여 드리지 않아요." };
  try {
    const size = statSync(abs).size;
    const text = readText(abs, BODY_MAX);
    if (text == null) return { status: 404, error: "파일을 읽지 못했어요." };
    return { status: 200, body: size > BODY_MAX ? `${text}\n\n(파일이 커서 앞부분만 보여 드려요)` : text };
  } catch {
    return { status: 404, error: "파일을 찾지 못했어요." };
  }
}

export function startServer(opts: ServerOpts): Running {
  const home = resolve(opts.home);
  const key = opts.key ?? randomBytes(24).toString("hex");
  let port = 0;

  let progress: Progress = { phase: "idle", filesDone: 0, filesTotal: 0 };
  let snapshot: Snapshot | null = null;
  let byId = new Map<string, Item>();
  let running: Promise<void> | null = null;
  let scanSeq = 0;
  const sent = { launch: false, scanDone: -1 };

  const settings = (): Settings => loadSettings(home);

  // 동의한 경우에만 보낸다. launch 와 scan_done 은 한 번씩만
  function track(event: "launch" | "scan_done") {
    const s = settings();
    if (s.telemetry !== "on") return;
    if (event === "launch") {
      if (sent.launch) return;
      sent.launch = true;
    } else {
      if (!snapshot || sent.scanDone === scanSeq) return;
      sent.scanDone = scanSeq;
    }
    const ev = buildEvent(s, snapshot, { event });
    if (ev) sendTelemetry(ev);
  }

  function startScan(): Promise<void> {
    if (running) return running;
    progress = { phase: "inventory", filesDone: 0, filesTotal: 0, message: "설정을 읽는 중이에요" };
    running = (async () => {
      try {
        const snap = await scan(home, { onProgress: (p) => (progress = p) });
        snapshot = snap;
        byId = new Map(snap.items.map((i) => [i.id, i] as const));
        scanSeq++;
        progress = { phase: "done", filesDone: snap.stats.transcriptsScanned, filesTotal: snap.stats.transcriptsScanned };
        track("scan_done");
      } catch (e) {
        progress = { phase: "error", filesDone: 0, filesTotal: 0, message: `점검에 실패했어요: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const hostOk = (req: Request): boolean => {
    const h = (req.headers.get("host") ?? "").toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };
  const originOk = (req: Request): boolean => {
    const o = req.headers.get("origin");
    return !o || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  };

  // /api/* 공통 검사: Host, 쿠키, (쓰기 요청이면) Origin
  const api = (fn: (req: Request) => Response | Promise<Response>) => async (req: Request): Promise<Response> => {
    if (!hostOk(req)) return json({ error: "허용되지 않은 주소예요." }, 403);
    const c = cookieOf(req, COOKIE);
    if (!c || !safeEq(c, key)) return json({ error: "접근 키가 없어요. 터미널에 출력된 주소로 다시 열어 주세요." }, 403);
    if (req.method !== "GET" && !originOk(req)) return json({ error: "허용되지 않은 요청이에요." }, 403);
    try {
      return await fn(req);
    } catch {
      return json({ error: "요청을 처리하지 못했어요." }, 500);
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    routes: {
      // 첫 접속: ?key= 를 확인하고 쿠키로 바꾼 뒤 주소에서 키를 지운다
      "/": (req) => {
        if (!hostOk(req)) return json({ error: "허용되지 않은 주소예요." }, 403);
        const q = new URL(req.url).searchParams.get("key");
        const c = cookieOf(req, COOKIE);
        const ok = (q != null && safeEq(q, key)) || (c != null && safeEq(c, key));
        if (!ok) return json({ error: "접근 키가 없어요. 터미널에 출력된 주소로 다시 열어 주세요." }, 403);
        return new Response(null, {
          status: 302,
          headers: {
            location: "/app",
            "set-cookie": `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
            "cache-control": "no-store",
          },
        });
      },
      "/app": index,
      "/api/snapshot": {
        GET: api(() => {
          if (snapshot) return json(snapshot);
          if (progress.phase === "error") return json({ error: progress.message ?? "점검에 실패했어요." }, 500);
          return json(progress, 404);
        }),
      },
      "/api/progress": { GET: api(() => json(progress)) },
      "/api/rescan": {
        POST: api(() => {
          void startScan();
          return json(progress);
        }),
      },
      "/api/item-body": {
        GET: api((req) => {
          const id = new URL(req.url).searchParams.get("id") ?? "";
          const item = byId.get(id);
          if (!item) return json({ error: "항목을 찾지 못했어요." }, 404);
          const r = bodyOf(item, home);
          return r.body != null ? json({ id, body: r.body }) : json({ error: r.error }, r.status);
        }),
      },
      "/api/settings": {
        GET: api(() => json(settings())),
        POST: api(async (req) => {
          let body: { telemetry?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            /* 아래에서 걸러진다 */
          }
          if (body.telemetry !== "on" && body.telemetry !== "off") return json({ error: 'telemetry 는 "on" 또는 "off" 여야 해요.' }, 400);
          const s = setTelemetry(home, body.telemetry);
          if (s.telemetry === "on") {
            track("launch");
            track("scan_done");
          }
          return json(s);
        }),
      },
      "/api/telemetry-preview": {
        GET: api(() => json(buildEvent(settings(), snapshot, { event: snapshot ? "scan_done" : "launch" }))),
      },
      "/api/telemetry": {
        POST: api(async (req) => {
          let body: { event?: unknown; view?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            return json({ error: "JSON 이 아니에요." }, 400);
          }
          if (body.event === "launch" || body.event === "scan_done") track(body.event);
          else {
            const s = settings();
            const ev = s.telemetry === "on" ? buildEvent(s, snapshot, body) : null;
            if (ev) sendTelemetry(ev);
          }
          return new Response(null, { status: 204 });
        }),
      },
    },
    fetch: () => json({ error: "찾을 수 없어요." }, 404),
  });
  port = server.port ?? 0;

  const url = `http://127.0.0.1:${port}/?key=${key}`;
  const firstScan = startScan();
  track("launch");
  if (opts.open) openBrowser(url);
  return { url, key, port, stop: () => server.stop(true), firstScan };
}

function openBrowser(url: string) {
  try {
    const cmd =
      process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    /* 브라우저를 못 열어도 주소는 출력된다 */
  }
}

function parseArgs(argv: string[]) {
  const o = { open: true, home: homedir(), port: undefined as number | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") o.open = false;
    else if (a === "--home") o.home = argv[++i] ?? o.home;
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("claude-checkup [--no-open] [--home <dir>] [--port <n>]");
      process.exit(0);
    }
  }
  if (o.port !== undefined && !(o.port >= 0 && o.port < 65536)) {
    console.error("--port 는 0 에서 65535 사이 숫자여야 해요.");
    process.exit(1);
  }
  return o;
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  const r = startServer({ home: o.home, port: o.port, open: o.open });
  console.log(`Claude 설정 점검: ${r.url}`);
  console.log("끝내려면 Ctrl+C 를 누르세요.");
  const bye = () => {
    r.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
