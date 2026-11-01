import { useState } from "react";
import type { Settings } from "../../shared/types";
import { setTelemetry } from "../api";
import { TelemetryPreview } from "../components/TelemetryPreview";

const SENT = [
  "무작위로 만든 설치 번호",
  "앱 버전과 운영체제",
  "열어 본 화면 이름",
  "점검에 걸린 시간 구간 (예: 10~59초)",
  "항목 수 구간 (예: 100~199개)",
];
const NOT_SENT = ["파일 이름과 경로", "설정 내용", "진단 결과 세부", "대화 기록", "홈 폴더 이름"];

/** 첫 실행 동의. 두 버튼은 같은 크기·같은 모양이고 미리 선택된 것이 없다 (Hearth R1-7) */
export function Consent({ onDone }: { onDone: (s: Settings) => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const choose = async (v: "on" | "off") => {
    setBusy(true);
    setFailed(false);
    try {
      onDone(await setTelemetry(v));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <main className="page page-narrow">
      <section className="card consent" aria-labelledby="consent-title">
        <div className="consent-head">
          <h1 id="consent-title" className="top-title">
            사용 통계를 보내도 될까요?
          </h1>
          <p className="top-desc">앱을 더 좋게 만들려고 익명 통계를 받고 싶어요. 보내지 않아도 모든 기능을 똑같이 쓸 수 있어요.</p>
        </div>

        <div className="consent-lists">
          <div className="card-inner">
            <h2 className="sec-title">보내는 것</h2>
            <ul className="bullets">
              {SENT.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="card-inner">
            <h2 className="sec-title">보내지 않는 것</h2>
            <ul className="bullets">
              {NOT_SENT.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>

        <TelemetryPreview ghost />

        <div className="sheet-foot" role="group" aria-label="통계 보내기 선택">
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => choose("on")}>
            통계 보내기
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => choose("off")}>
            보내지 않기
          </button>
        </div>
        {failed && (
          <p className="field-error" role="alert">
            선택을 저장하지 못했어요. 다시 한 번 눌러 주세요.
          </p>
        )}
        <p className="help">나중에 설정에서 언제든 바꿀 수 있어요.</p>
      </section>
    </main>
  );
}
