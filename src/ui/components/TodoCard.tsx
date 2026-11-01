import { useId, useState, type ReactNode } from "react";
import type { Finding } from "../../shared/types";
import { useClaudeEnv } from "../hooks";
import { CopyButton } from "./CopyButton";

interface TodoCardProps {
  finding: Finding;
  onFix: (finding: Finding) => void;
  /** 카드 왼쪽 번호 (1부터) */
  rank?: number;
  /** 용어 설명이 붙은 제목과 근거. 없으면 진단 문구 그대로 */
  title?: ReactNode;
  evidence?: ReactNode;
}

/** 직접 하는 순서 목록. 순서가 없는 진단은 규칙 공통 문장을 보여 준다 */
export function StepList({ finding }: { finding: Finding }) {
  const steps = finding.steps.length > 0 ? finding.steps : [finding.fix];
  return (
    <div className="steps">
      <ol>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {finding.command && <pre className="code-block">{finding.command}</pre>}
    </div>
  );
}

/** 고치기 버튼. claude 를 못 쓰는 환경이면 같은 자리에 "맡길 말 복사"가 온다. manual 진단에는 없다 */
export function FixAction({ finding, onFix }: { finding: Finding; onFix: (f: Finding) => void }) {
  const env = useClaudeEnv();
  if (finding.fixKind === "manual") return null;
  if (finding.fixKind === "claude" && env && !env.available) {
    return <CopyButton text={finding.prompt} label="Claude에게 맡길 말 복사" />;
  }
  return (
    <button className="btn btn-secondary btn-sm" type="button" onClick={() => onFix(finding)}>
      고치기
    </button>
  );
}

/** 얻는 것 한 줄. 상한값이면 "최대"를 붙인다 */
export function GainLine({ finding }: { finding: Finding }) {
  const g = finding.gain;
  if (!g) return null;
  return (
    <p className="gain">
      <span>얻는 것</span>
      <span className="gain-text">{g.text}</span>
    </p>
  );
}

export function TodoCard({ finding, onFix, rank, title, evidence }: TodoCardProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <article className="card todo" aria-label={finding.title}>
      {rank != null && (
        <span className="num" aria-hidden="true">
          {rank}
        </span>
      )}
      <div className="todo-body">
        <h3 className="todo-title">{title ?? finding.title}</h3>
        <GainLine finding={finding} />
        <p className="sub">{evidence ?? finding.evidence}</p>
        <div className="acts">
          <FixAction finding={finding} onFix={onFix} />
          <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            {open ? "순서 접기" : "직접 하는 순서"}
          </button>
        </div>
        <div id={panelId} hidden={!open}>
          {open && <StepList finding={finding} />}
        </div>
      </div>
    </article>
  );
}
