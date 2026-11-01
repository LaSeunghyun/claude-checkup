// 서버 API 호출은 이 파일 한 곳에서만 한다. 규격은 src/shared/types.ts 아래쪽 주석.
import type { ClaudeEnv, FixJob, FixRequest, Progress, Settings, Snapshot, TelemetryEvent } from "../shared/types";

// 접근 확인은 서버가 준 쿠키로 하므로 화면은 키를 다루지 않는다.
// 개발용 서버의 ?mock= 같은 화면 주소의 쿼리는 그대로 API 요청에 붙인다.
function withQuery(path: string, extra?: Record<string, string>): string {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export type SnapshotResult =
  | { kind: "ok"; snapshot: Snapshot }
  | { kind: "scanning"; progress: Progress }
  | { kind: "error"; message: string };

export const NO_SERVER = "점검 서버에 연결하지 못했어요. 앱이 꺼져 있지 않은지 확인해 주세요.";

/** 서버가 거절하거나 실패로 답한 경우. message 는 화면에 그대로 보여 줘도 되는 말이다 */
export class ApiError extends Error {}

/** 실패한 이유를 화면에 보여 줄 말로 바꾼다. 서버가 말해 준 이유가 있으면 그것을, 연결 자체가 안 되면 안내를 쓴다 */
export function errorText(e: unknown, fallback = NO_SERVER): string {
  return e instanceof ApiError ? e.message : fallback;
}

async function okJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(typeof body?.error === "string" ? body.error : fallback);
  }
  return (await res.json()) as T;
}

export async function getSnapshot(): Promise<SnapshotResult> {
  try {
    const res = await fetch(withQuery("/api/snapshot"));
    if (res.status === 404) {
      const progress = (await res.json().catch(() => null)) as Progress | null;
      return { kind: "scanning", progress: progress ?? { phase: "idle", filesDone: 0, filesTotal: 0 } };
    }
    const body = (await res.json().catch(() => null)) as (Snapshot & { error?: string }) | null;
    if (!res.ok || !body || typeof body.error === "string") {
      return { kind: "error", message: body?.error ?? "점검 결과를 가져오지 못했어요." };
    }
    return { kind: "ok", snapshot: body };
  } catch {
    return { kind: "error", message: NO_SERVER };
  }
}

export async function getProgress(): Promise<Progress> {
  return okJson<Progress>(await fetch(withQuery("/api/progress")), "점검 진행 상황을 가져오지 못했어요.");
}

export async function rescan(): Promise<Progress> {
  return okJson<Progress>(await fetch(withQuery("/api/rescan"), { method: "POST" }), "다시 점검을 시작하지 못했어요.");
}

export type BodyResult =
  | { kind: "ok"; body: string }
  | { kind: "forbidden" }
  | { kind: "error" };

export async function getItemBody(id: string): Promise<BodyResult> {
  try {
    const res = await fetch(withQuery("/api/item-body", { id }));
    if (res.status === 403) return { kind: "forbidden" };
    if (!res.ok) return { kind: "error" };
    const data = (await res.json()) as { body: string };
    return { kind: "ok", body: data.body };
  } catch {
    return { kind: "error" };
  }
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(withQuery("/api/settings"));
  if (!res.ok) throw new Error("settings");
  return (await res.json()) as Settings;
}

export async function setTelemetry(telemetry: "on" | "off"): Promise<Settings> {
  const res = await fetch(withQuery("/api/settings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ telemetry }),
  });
  if (!res.ok) throw new Error("settings");
  return (await res.json()) as Settings;
}

export async function getTelemetryPreview(): Promise<TelemetryEvent> {
  const res = await fetch(withQuery("/api/telemetry-preview"));
  if (!res.ok) throw new Error("preview");
  return (await res.json()) as TelemetryEvent;
}

/** 항목 파일을 탐색기(Finder)에서 연다. 성공 여부만 돌려준다 */
export async function revealItem(id: string): Promise<boolean> {
  try {
    const res = await fetch(withQuery("/api/reveal"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 화면을 열었다는 사실만 알린다. 보낼지 말지는 서버가 정하고, 실패는 조용히 버린다 */
export function postViewOpen(view: NonNullable<TelemetryEvent["view"]>): void {
  fetch(withQuery("/api/telemetry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "view_open", view }),
    keepalive: true,
  }).catch(() => {});
}

// ---- 고치기 ----

/** 고치기 요청이 거절된 경우. needConsent 는 안내 동의가 먼저, fallback 은 claude 를 못 써서 복사로 대신해야 한다는 뜻 */
export class FixApiError extends ApiError {
  needConsent: boolean;
  fallback: boolean;
  constructor(message: string, needConsent = false, fallback = false) {
    super(message);
    this.needConsent = needConsent;
    this.fallback = fallback;
  }
}

async function fixJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown; needConsent?: unknown; fallback?: unknown } | null;
    throw new FixApiError(
      typeof body?.error === "string" ? body.error : fallback,
      body?.needConsent === true,
      body?.fallback === "copy",
    );
  }
  return (await res.json()) as T;
}

const postJson = (path: string, body: unknown) =>
  fetch(withQuery(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** claude 를 쓸 수 있는지. 확인 자체가 실패하면 못 쓰는 것으로 본다 */
export async function getFixEnv(): Promise<ClaudeEnv> {
  try {
    const res = await fetch(withQuery("/api/fix/env"));
    if (!res.ok) return { available: false };
    return (await res.json()) as ClaudeEnv;
  } catch {
    return { available: false };
  }
}

export async function startFixPreview(req: FixRequest): Promise<FixJob> {
  return fixJson<FixJob>(await postJson("/api/fix/preview", req), "미리 보기를 만들지 못했어요.");
}

export async function getFixJob(id: string): Promise<FixJob> {
  return fixJson<FixJob>(await fetch(withQuery("/api/fix/job", { id })), "진행 상황을 가져오지 못했어요.");
}

export async function applyFix(jobId: string, archive?: string[]): Promise<FixJob> {
  return fixJson<FixJob>(await postJson("/api/fix/apply", archive ? { jobId, archive } : { jobId }), "적용하지 못했어요.");
}

export async function undoFix(backupId: string): Promise<{ ok: boolean; message: string }> {
  return fixJson(await postJson("/api/fix/undo", { backupId }), "되돌리지 못했어요.");
}

/** Claude 고치기 안내에 동의했다고 저장한다 */
export async function agreeClaudeFix(): Promise<Settings> {
  return fixJson<Settings>(await postJson("/api/settings", { claudeFix: "agreed" }), "동의를 저장하지 못했어요.");
}
