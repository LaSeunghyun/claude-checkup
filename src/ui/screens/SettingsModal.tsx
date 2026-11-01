import { useId, useState } from "react";
import type { Settings } from "../../shared/types";
import { setTelemetry } from "../api";
import { CloseButton, Modal } from "../components/Modal";
import { TelemetryPreview } from "../components/TelemetryPreview";

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, onChange, onClose }: Props) {
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
    </Modal>
  );
}
