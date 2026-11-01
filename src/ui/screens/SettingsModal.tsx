import { useEffect, useId, useState } from "react";
import type { FixBackup, Settings } from "../../shared/types";
import { errorText, getFixBackups, setTelemetry, undoFix } from "../api";
import { CloseButton, Modal } from "../components/Modal";
import { TelemetryPreview } from "../components/TelemetryPreview";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onChanged?: () => void; // 되돌린 뒤 점검 결과를 다시 불러온다
}

function whatOf(b: FixBackup): string {
  const parts: string[] = [];
  if (b.plugins.length) parts.push(`플러그인 끄기: ${b.plugins.join(", ")}`);
  if (b.moves.length) parts.push(`보관함으로 옮김: ${b.moves.join(", ")}`);
  if (b.files.length && !b.plugins.length) parts.push(`파일 고침: ${b.files.join(", ")}`);
  return parts.join(" / ") || "고친 내용";
}

function whenOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function RecentFixes({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<FixBackup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      setList(await getFixBackups());
      setError(null);
    } catch (e) {
      setError(errorText(e, "최근 고친 것을 가져오지 못했어요."));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const undo = async (id: string) => {
    setBusyId(id);
    try {
      const r = await undoFix(id);
      setNotes((n) => ({ ...n, [id]: r.message }));
      if (r.ok) onChanged?.();
      await load();
    } catch (e) {
      setNotes((n) => ({ ...n, [id]: errorText(e, "되돌리지 못했어요.") }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="group">
      <div className="group-head">
        <h3 className="group-title">최근 고친 것</h3>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {list && list.length === 0 && <p className="help">아직 고친 것이 없어요.</p>}
      <div className="list">
        {(list ?? []).map((b) => (
          <div key={b.id} className="list-row">
            <span className="list-row-main">
              <span className="list-row-title">{whatOf(b)}</span>
              <span className="list-row-meta">
                {whenOf(b.at)} · {b.status === "undone" ? "되돌림" : b.status === "applying" ? "적용 도중 멈춤" : "적용됨"}
              </span>
              {notes[b.id] && <span className="help">{notes[b.id]}</span>}
            </span>
            {b.status !== "undone" && (
              <span className="list-row-end">
                <button className="btn btn-secondary btn-sm" type="button" disabled={busyId !== null} onClick={() => undo(b.id)}>
                  되돌리기
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function SettingsModal({ settings, onChange, onClose, onChanged }: Props) {
  const titleId = useId();
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const on = settings.telemetry === "on";

  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try {
      onChange(await setTelemetry(on ? "off" : "on"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className="dlg-head">
        <div className="dlg-head-text">
          <h2 id={titleId}>설정</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className="toggle-row">
        <span className="toggle-row-text">
          <span className="label" id={labelId}>
            익명 사용 통계 보내기
          </span>
          <span className="help">
            {on ? "지금은 보내고 있어요." : settings.telemetry === "off" ? "지금은 보내지 않고 있어요." : "아직 고르지 않았어요. 켜기 전에는 보내지 않아요."}
          </span>
        </span>
        <button className="toggle" type="button" role="switch" aria-checked={on} aria-labelledby={labelId} disabled={busy} onClick={toggle} />
      </div>
      {failed && (
        <p className="field-error" role="alert">
          설정을 저장하지 못했어요. 다시 눌러 주세요.
        </p>
      )}

      <p className="help">
        설치 번호, 앱 버전, 운영체제, 열어 본 화면 이름, 점검 시간과 항목 수 구간만 보내요. 파일 이름, 경로, 설정 내용, 진단 결과 세부, 대화 기록은 보내지 않아요.
      </p>

      <TelemetryPreview refreshKey={settings.telemetry ?? "none"} />

      <RecentFixes onChanged={onChanged} />
    </Modal>
  );
}
