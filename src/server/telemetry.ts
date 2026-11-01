// 익명 사용 통계 (design.md 8-1절). 동의했고 TELEMETRY_URL 이 있을 때만 보낸다.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings, Snapshot, TelemetryEvent } from "../shared/types";
import { readJson } from "../scan/fsutil";

// 받는 주소. 비어 있으면 동의와 상관없이 아무것도 보내지 않는다. 받는 서버는 별도 작업이다.
export const TELEMETRY_URL: string = "";
export const APP_VERSION = "0.1.0";

export const NOT_YET_ID = "(동의하면 무작위 번호가 만들어져요)";

// fix_* 는 서버가 고치기 때 직접 보낸다. 무엇을 고쳤는지는 담지 않고 종류만 보낸다
const EVENTS = ["launch", "scan_done", "view_open", "fix_preview", "fix_apply", "fix_undo"] as const;
const VIEWS = ["home", "group", "item", "findings", "settings"] as const;

export const settingsFile = (home: string): string => join(home, ".claude-checkup", "settings.json");

export function loadSettings(home: string): Settings {
  const j = readJson(settingsFile(home));
  const telemetry = j?.telemetry === "on" || j?.telemetry === "off" ? j.telemetry : null;
  const s: Settings = { telemetry };
  if (telemetry === "on" && typeof j?.installId === "string" && /^[0-9a-f-]{36}$/i.test(j.installId)) s.installId = j.installId;
  if (j?.claudeFix === "agreed") s.claudeFix = "agreed";
  return s;
}

function save(home: string, s: Settings) {
  mkdirSync(join(home, ".claude-checkup"), { recursive: true });
  writeFileSync(settingsFile(home), JSON.stringify(s, null, 2));
}

// 동의하면 installId 를 만들고, 끄면 지운다. Claude 고치기 동의는 그대로 둔다
export function setTelemetry(home: string, value: "on" | "off"): Settings {
  const cur = loadSettings(home);
  const next: Settings = value === "on" ? { telemetry: "on", installId: cur.installId ?? randomUUID() } : { telemetry: "off" };
  if (cur.claudeFix) next.claudeFix = cur.claudeFix;
  save(home, next);
  return next;
}

// Claude 고치기 안내에 동의함 (design.md 8-3절). 통계 설정은 그대로 둔다
export function setClaudeFix(home: string): Settings {
  const next: Settings = { ...loadSettings(home), claudeFix: "agreed" };
  save(home, next);
  return next;
}

const bucketSeconds = (ms: number): NonNullable<TelemetryEvent["scanSeconds"]> => {
  const s = ms / 1000;
  return s < 10 ? "0-9" : s < 60 ? "10-59" : s < 300 ? "60-299" : "300+";
};
const bucketItems = (n: number): NonNullable<TelemetryEvent["itemCount"]> =>
  n < 50 ? "0-49" : n < 100 ? "50-99" : n < 200 ? "100-199" : n < 500 ? "200-499" : "500+";

const osName = (): TelemetryEvent["os"] =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other";

export interface EventReq {
  event?: unknown;
  view?: unknown;
}

// 보낼 내용을 만든다. 미리보기와 실제 전송이 같은 함수를 쓴다
export function buildEvent(settings: Settings, snap: Snapshot | null, req: EventReq): TelemetryEvent | null {
  const event = EVENTS.find((e) => e === req.event);
  if (!event) return null;
  const ev: TelemetryEvent = { installId: settings.installId ?? NOT_YET_ID, appVersion: APP_VERSION, os: osName(), event };
  if (event === "view_open") {
    const view = VIEWS.find((v) => v === req.view);
    if (!view) return null;
    ev.view = view;
  }
  if (event === "scan_done" && snap) {
    ev.scanSeconds = bucketSeconds(snap.stats.durationMs);
    ev.itemCount = bucketItems(snap.items.length);
  }
  return ev;
}

// 실패는 조용히 버린다. 재시도와 큐는 없다
export function sendTelemetry(ev: TelemetryEvent): void {
  if (!TELEMETRY_URL) return;
  try {
    fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  } catch {
    /* 무시 */
  }
}
