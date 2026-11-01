// 로컬 서버: 127.0.0.1 임의 포트. 시작할 때 만든 키는 주소로 한 번만 쓰고, 이후에는 별도 세션 쿠키로 접근을 막는다.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import index from "../ui/index.html";
import { expandHome, isSecretName, readText, redactSecrets } from "../scan/fsutil";
import { scanWithCore, type ScanCore } from "../scan";
import { appendHistory, previousOf } from "../scan/history";
import { ChangedSinceError, applyPlanned, listBackups, undo } from "../fix/backup";
import { claudeEnv, resolveClaude, runClaudeCli } from "../fix/claude";
import { ClaudeUnavailableError, FixRequestError, buildPreview, claudeJobOf, estimateUsage, resolveTarget, tokenWords, withArchive, type Built } from "../fix/preview";
import type { ClaudeEnv, FixJob, FixRequest, Item, Progress, Settings, Snapshot } from "../shared/types";
import { buildEvent, loadSettings, sendTelemetry, setClaudeFix, setTelemetry } from "./telemetry";

const BODY_MAX = 400_000;

// 모든 응답에 붙는 보안 헤더: 다른 사이트가 화면을 iframe 으로 덮어씌우거나(클릭 가로채기) 파일 종류를 추측하지 못하게 한다
const SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "frame-ancestors 'none'",
};

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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers },
  });

const noContent = (): Response => new Response(null, { status: 204, headers: SECURITY_HEADERS });

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

type Body = { status: number; body?: string; error?: string };

// 항목 종류별 본문. 어떤 글이든 화면에 나가기 전에 비밀값 모양을 가린다
function bodyOf(item: Item, home: string): Body {
  const r = rawBodyOf(item, home);
  return r.body != null ? { ...r, body: redactSecrets(r.body) } : r;
}

// 파일이 있는 종류만 파일을 읽는다 (경로는 항상 스냅샷의 항목에서 얻는다)
function rawBodyOf(item: Item, home: string): Body {
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
  const key = opts.key ?? randomBytes(24).toString("hex"); // 주소에 한 번만 쓰는 키
  const session = randomBytes(24).toString("hex"); // 쿠키에 담기는 값. 주소의 키와 따로 만든다
  let keyUsed = false;
  let port = 0;
  // 같은 호스트의 쿠키는 포트와 상관없이 모이므로, 서버를 두 번 띄워도 서로 덮어쓰지 않게 이름에 포트를 넣는다
  const cookieName = () => `cc_key_${port}`;

  let progress: Progress = { phase: "idle", filesDone: 0, filesTotal: 0 };
  let snapshot: Snapshot | null = null;
  let core: ScanCore | null = null; // 마지막 점검의 대화 기록 집계. 미리 보기가 다시 쓴다
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
        const r = await scanWithCore(home, { onProgress: (p) => (progress = p) });
        const snap = r.snap;
        // 기록은 실패해도 점검 결과를 막지 않는다
        try {
          const prev = previousOf(home, snap.summary);
          if (prev) snap.previous = prev;
          appendHistory(home, snap.summary);
        } catch {
          /* 기록을 못 남겨도 화면은 그대로 */
        }
        snapshot = snap;
        core = r.core;
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

  // 적용·되돌리기 뒤 다시 점검한다. 돌던 점검은 바뀌기 전 파일을 읽었을 수 있어서 끝난 뒤 한 번 더 돌린다
  async function rescanAfterChange(): Promise<void> {
    if (running) await running;
    await startScan();
  }

  // ---- 고치기 (design.md 8절) ----
  interface JobState {
    job: FixJob;
    built?: Built;
    applying?: boolean;
  }
  const jobs = new Map<string, JobState>();
  const MAX_JOBS = 30;
  let envCache: { at: number; env: ClaudeEnv } | null = null;
  const fixEnv = async (): Promise<ClaudeEnv> => {
    if (envCache && Date.now() - envCache.at < 30_000) return envCache.env;
    const env = await claudeEnv();
    envCache = { at: Date.now(), env };
    return env;
  };
  // 못 찾으면 127 이 돌아오고, 플러그인 끄기는 설정 파일로 대신한다
  const runClaude = (args: string[]) => runClaudeCli(resolveClaude(), args);

  // 화면에 나가는 말: 비밀값을 가리고 홈 절대경로는 ~ 로 줄인다
  const homeForms = [...new Set([home, home.replace(/\\/g, "/")])].sort((a, b) => b.length - a.length);
  const say = (m: string): string => {
    let out = redactSecrets(m);
    for (const h of homeForms) {
      for (let i = out.toLowerCase().indexOf(h.toLowerCase()); i >= 0; i = out.toLowerCase().indexOf(h.toLowerCase())) out = out.slice(0, i) + "~" + out.slice(i + h.length);
    }
    return out.replace(/~[\\/][^\s,)]*/g, (p) => p.replace(/\\/g, "/"));
  };

  // 무엇을 고쳤는지는 보내지 않고 종류만 (design.md 12절)
  function trackFix(event: "fix_preview" | "fix_apply" | "fix_undo") {
    const s = settings();
    if (s.telemetry !== "on") return;
    const ev = buildEvent(s, null, { event });
    if (ev) sendTelemetry(ev);
  }

  function remember(st: JobState) {
    jobs.set(st.job.id, st);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  }

  // 화면(HTML 번들)은 Bun 이 직접 내보내는 응답이라 헤더를 못 붙인다. 안쪽 서버에 두고 여기서 받아 보안 헤더를 붙여 내보낸다
  let uiServer: ReturnType<typeof Bun.serve> | null = null;
  const uiOrigin = () => {
    uiServer ??= Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: { "/": index }, fetch: () => new Response(null, { status: 404 }) });
    return `http://127.0.0.1:${uiServer.port}`;
  };
  const serveUi = async (req: Request): Promise<Response> => {
    if (!hostOk(req)) return json({ error: "허용되지 않은 주소예요." }, 403);
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "찾을 수 없어요." }, 404);
    const u = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const h of ["if-none-match", "if-modified-since"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const r = await fetch(`${uiOrigin()}${u.pathname === "/app" ? "/" : u.pathname}${u.search}`, { method: req.method, headers });
    if (r.status === 404) return json({ error: "찾을 수 없어요." }, 404);
    return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...SECURITY_HEADERS } });
  };

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
    const c = cookieOf(req, cookieName());
    if (!c || !safeEq(c, session)) return json({ error: "접근 키가 없어요. 터미널에 출력된 주소로 다시 열어 주세요." }, 403);
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
      // 첫 접속: ?key= 를 한 번만 받아 세션 쿠키로 바꾸고, 주소에서 키를 지운다. 쓴 키는 다시 못 쓴다
      "/": (req) => {
        if (!hostOk(req)) return json({ error: "허용되지 않은 주소예요." }, 403);
        const q = new URL(req.url).searchParams.get("key");
        const c = cookieOf(req, cookieName());
        const viaCookie = c != null && safeEq(c, session);
        const viaKey = !viaCookie && q != null && !keyUsed && safeEq(q, key);
        if (!viaCookie && !viaKey) {
          const used = q != null && keyUsed && safeEq(q, key);
          return json({ error: used ? "이 주소는 이미 한 번 썼어요. 열려 있는 탭을 쓰거나, 앱을 다시 실행해서 새 주소로 열어 주세요." : "접근 키가 없어요. 터미널에 출력된 주소로 다시 열어 주세요." }, 403);
        }
        if (viaKey) keyUsed = true;
        return new Response(null, {
          status: 302,
          headers: {
            location: "/app",
            ...(viaKey ? { "set-cookie": `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/` } : {}),
            "cache-control": "no-store",
            ...SECURITY_HEADERS,
          },
        });
      },
      "/app": serveUi,
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
      // 항목 파일을 탐색기(Finder)에서 선택된 채로 연다. 경로는 받지 않고 알려진 항목 id 로만 찾는다
      "/api/reveal": {
        POST: api(async (req) => {
          let body: { id?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            /* 아래에서 걸러진다 */
          }
          const item = typeof body.id === "string" ? byId.get(body.id) : undefined;
          if (!item?.path || item.kind === "mcp") return json({ error: "열 수 있는 파일이 없어요." }, 404);
          const abs = resolve(expandHome(item.path, home));
          if (isSecretName(abs) || !existsSync(abs)) return json({ error: "파일을 찾지 못했어요." }, 404);
          reveal(abs);
          return noContent();
        }),
      },
      "/api/settings": {
        GET: api(() => json(settings())),
        POST: api(async (req) => {
          let body: { telemetry?: unknown; claudeFix?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            /* 아래에서 걸러진다 */
          }
          if (body.claudeFix === "agreed") return json(setClaudeFix(home));
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
          else if (body.event === "view_open") {
            // fix_* 는 서버가 고치기 때 직접 보낸다. 화면이 보내는 것은 받지 않는다
            const s = settings();
            const ev = s.telemetry === "on" ? buildEvent(s, snapshot, body) : null;
            if (ev) sendTelemetry(ev);
          }
          return noContent();
        }),
      },
      "/api/fix/env": { GET: api(async () => json(await fixEnv())) },
      "/api/fix/preview": {
        POST: api(async (req) => {
          let body: { findingId?: unknown; itemIds?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            return json({ error: "JSON 이 아니에요." }, 400);
          }
          const snap = snapshot;
          const c = core;
          if (!snap || !c) return json({ error: "점검이 끝난 뒤에 고칠 수 있어요." }, 409);
          let target;
          try {
            target = resolveTarget(snap, body);
          } catch (e) {
            if (e instanceof FixRequestError) return json({ error: e.message }, e.status);
            throw e;
          }
          // 경로는 받지 않는다. 진단 id 와 그 진단 안의 항목 id 만 남긴다
          const request: FixRequest = { findingId: target.finding.id, ...(Array.isArray(body.itemIds) ? { itemIds: target.entries.map((e) => e.item.id) } : {}) };
          let env: ClaudeEnv = { available: false };
          let estimate: FixJob["estimate"];
          if (target.kind === "claude") {
            // 못 쓰면 동의를 받아도 소용이 없으므로 먼저 본다
            env = await fixEnv();
            if (!env.available) return json({ error: say(new ClaudeUnavailableError(env.reason).message), fallback: "copy" }, 400);
            if (settings().claudeFix !== "agreed") return json({ error: "Claude로 고치기 전에 안내를 확인하고 동의해 주세요.", needConsent: true }, 409);
            try {
              estimate = estimateUsage(claudeJobOf(home, target));
            } catch (e) {
              if (e instanceof FixRequestError) return json({ error: say(e.message), fallback: "copy" }, 400);
              throw e;
            }
          }
          const job: FixJob = {
            id: randomBytes(12).toString("hex"),
            request,
            kind: target.kind,
            status: "running",
            message: estimate
              ? `Claude가 변경안을 만들고 있어요. 예상 사용량은 ${tokenWords(estimate.inputTokens + estimate.outputTokens)}이에요.`
              : "변경안을 계산하고 있어요.",
            ...(estimate ? { estimate } : {}),
          };
          const st: JobState = { job };
          remember(st);
          trackFix("fix_preview");
          void (async () => {
            try {
              const built = await buildPreview(home, c, snap, request, env);
              st.built = built;
              st.job = { ...st.job, status: "ready", message: undefined, preview: built.preview };
            } catch (e) {
              st.job = { ...st.job, status: "failed", message: say(e instanceof Error ? e.message : "변경안을 만들지 못했어요.") };
            }
          })();
          return json(job);
        }),
      },
      "/api/fix/job": {
        GET: api((req) => {
          const st = jobs.get(new URL(req.url).searchParams.get("id") ?? "");
          return st ? json(st.job) : json({ error: "그 작업을 찾지 못했어요. 미리 보기를 다시 만들어 주세요." }, 404);
        }),
      },
      "/api/fix/apply": {
        POST: api(async (req) => {
          let body: { jobId?: unknown; archive?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            return json({ error: "JSON 이 아니에요." }, 400);
          }
          const st = typeof body.jobId === "string" ? jobs.get(body.jobId) : undefined;
          if (!st) return json({ error: "그 작업을 찾지 못했어요. 미리 보기를 다시 만들어 주세요." }, 404);
          if (st.job.status !== "ready" || !st.built) return json({ error: "미리 보기가 준비된 것만 적용할 수 있어요." }, 409);
          if (st.built.preview.blocked) return json({ error: st.built.preview.blocked }, 409);
          if (st.applying) return json({ error: "이미 적용하고 있어요." }, 409); // 두 번 눌러도 한 번만
          st.applying = true;
          const before = snapshot?.summary;
          let manifest;
          try {
            manifest = await applyPlanned(home, withArchive(home, st.built, body.archive), st.job.request.findingId, runClaude);
          } catch (e) {
            if (e instanceof ChangedSinceError) return json({ error: e.message }, 409);
            return json({ error: say(`적용하지 못했어요. 파일은 원래대로예요. ${e instanceof Error ? e.message : ""}`.trim()) }, 400);
          } finally {
            st.applying = false;
          }
          st.job = { ...st.job, status: "applied", backupId: manifest.id };
          trackFix("fix_apply");
          await rescanAfterChange();
          if (before && snapshot) st.job = { ...st.job, result: { before, after: snapshot.summary } };
          return json(st.job);
        }),
      },
      "/api/fix/undo": {
        POST: api(async (req) => {
          let body: { backupId?: unknown } = {};
          try {
            body = await req.json();
          } catch {
            return json({ error: "JSON 이 아니에요." }, 400);
          }
          if (typeof body.backupId !== "string" || !body.backupId) return json({ error: "되돌릴 백업을 알려 주세요." }, 400);
          const r = await undo(home, body.backupId, runClaude);
          if (r.ok) {
            for (const st of jobs.values()) if (st.job.backupId === body.backupId) st.job = { ...st.job, status: "undone", message: say(r.message) };
            trackFix("fix_undo");
            await rescanAfterChange();
          }
          return json({ ok: r.ok, message: say(r.message) });
        }),
      },
      // 백업 요약 목록 (최근 것부터). 경로는 .claude 기준 상대 경로만
      "/api/fix/backups": {
        GET: api(() =>
          json(
            listBackups(home).map((m) => ({
              id: m.id,
              at: m.at,
              findingId: m.findingId,
              status: m.status ?? "applied",
              files: m.files.map((f) => say(f.rel)),
              moves: m.moves.map((x) => say(x.fromRel)),
              plugins: m.pluginKeys.map(say),
            })),
          ),
        ),
      },
    },
    fetch: (req) => (new URL(req.url).pathname.startsWith("/api/") ? json({ error: "찾을 수 없어요." }, 404) : serveUi(req)),
  });
  port = server.port ?? 0;

  const url = `http://127.0.0.1:${port}/?key=${key}`;
  const firstScan = startScan();
  track("launch");
  if (opts.open) openBrowser(url);
  return {
    url,
    key,
    port,
    stop: () => {
      server.stop(true);
      uiServer?.stop(true);
    },
    firstScan,
  };
}

function reveal(abs: string) {
  try {
    const cmd =
      process.platform === "win32"
        ? ["explorer.exe", `/select,${abs}`]
        : process.platform === "darwin"
          ? ["open", "-R", abs]
          : ["xdg-open", dirname(abs)];
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    /* 못 열어도 화면에 경로가 있다 */
  }
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
