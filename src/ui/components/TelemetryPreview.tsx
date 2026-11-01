import { useEffect, useState } from "react";
import { getTelemetryPreview } from "../api";

type Preview = { kind: "loading" } | { kind: "ok"; json: string } | { kind: "error" };

/** "보내는 내용 보기": 서버가 실제로 보낼 JSON 을 그대로 보여 준다 */
export function TelemetryPreview({ refreshKey, ghost }: { refreshKey?: string; ghost?: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Preview>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setData({ kind: "loading" });
    getTelemetryPreview()
      .then((e) => live && setData({ kind: "ok", json: JSON.stringify(e, null, 2) }))
      .catch(() => live && setData({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [open, refreshKey]);

  return (
    <div className="preview">
      <button className={`btn btn-sm ${ghost ? "btn-ghost" : "btn-secondary"}`} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "보내는 내용 닫기" : "보내는 내용 보기"}
      </button>
      {open &&
        (data.kind === "loading" ? (
          <p className="loading-text" role="status">
            불러오는 중이에요
          </p>
        ) : data.kind === "error" ? (
          <p className="field-error" role="alert">
            보낼 내용을 가져오지 못했어요. 잠시 뒤에 다시 눌러 주세요.
          </p>
        ) : (
          <>
            <pre className="code-block" tabIndex={0} aria-label="보내는 내용">
              {data.json}
            </pre>
            <p className="help">이 내용이 그대로 전송돼요. 파일 이름, 경로, 설정 내용, 대화 기록은 들어 있지 않아요.</p>
          </>
        ))}
    </div>
  );
}
