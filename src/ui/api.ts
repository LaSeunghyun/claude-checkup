// 서버 API 호출은 이 파일 한 곳에서만 한다. 규격은 src/shared/types.ts 아래쪽 주석.
import type { Progress, Settings, Snapshot, TelemetryEvent } from "../shared/types";

// 서버는 시작할 때 만든 키를 URL 쿼리로 요구한다.
// 이름을 몰라도 되도록 화면 주소의 쿼리를 그대로 API 요청에 붙인다.
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

const NO_SERVER = "점검 서버에 연결하지 못했어요. 앱이 꺼져 있지 않은지 확인해 주세요.";

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
  const res = await fetch(withQuery("/api/progress"));
  return (await res.json()) as Progress;
}

export async function rescan(): Promise<Progress> {
  const res = await fetch(withQuery("/api/rescan"), { method: "POST" });
  return (await res.json()) as Progress;
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

/** 화면을 열었다는 사실만 알린다. 보낼지 말지는 서버가 정하고, 실패는 조용히 버린다 */
export function postViewOpen(view: NonNullable<TelemetryEvent["view"]>): void {
  fetch(withQuery("/api/telemetry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "view_open", view }),
    keepalive: true,
  }).catch(() => {});
}
