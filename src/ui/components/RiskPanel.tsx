import { useId, useState, type ReactNode } from "react";
import type { Finding } from "../../shared/types";
import { revealItem } from "../api";
import { StepList } from "./TodoCard";

interface RiskPanelProps {
  /** category 가 risk 인 진단 */
  findings: Finding[];
  /** 용어 설명이 붙은 제목 (위험이 1가지일 때). 없으면 진단 문구 그대로 */
  heading?: ReactNode;
  /** 용어 설명이 붙은 설명글. 없으면 진단 문구 그대로 */
  why?: ReactNode;
}

function RiskRow({ finding, showTitle }: { finding: Finding; showTitle: boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const panelId = useId();
  const target = finding.items[0];
  const reveal = async () => {
    if (!target) return;
    setFailed(!(await revealItem(target)));
  };
  return (
    <div className="risk-row">
      {showTitle && <p className="risk-title">{finding.title}</p>}
      <p className="sub">{finding.evidence}</p>
      <div className="acts">
        {target && (
          <button className="btn btn-secondary btn-sm" type="button" onClick={reveal}>
            파일 위치 열기
          </button>
        )}
        <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          {open ? "순서 접기" : "직접 지우는 순서"}
        </button>
      </div>
      {failed && <p className="sub">파일 위치를 열지 못했어요. 위 근거에 적힌 파일을 직접 열어 주세요.</p>}
      <div id={panelId} hidden={!open}>
        {open && <StepList finding={finding} />}
      </div>
    </div>
  );
}

/** 비밀값이 든 파일처럼 순위 없이 먼저 알려야 하는 위험. 값은 화면에 나오지 않는다 */
export function RiskPanel({ findings, heading, why }: RiskPanelProps) {
  if (findings.length === 0) return null;
  const n = findings.length;
  return (
    <section className="risk" aria-label="위험">
      <h2>{n === 1 ? <>위험 1가지: {heading ?? findings[0]!.title}</> : `위험 ${n}가지가 있어요`}</h2>
      <p>{why ?? findings[0]!.why}</p>
      {findings.map((f) => (
        <RiskRow key={f.id} finding={f} showTitle={n > 1} />
      ))}
    </section>
  );
}
