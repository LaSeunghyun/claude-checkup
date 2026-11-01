import { useState } from "react";
import type { FileChange } from "../../shared/types";
import { num } from "../format";

const KIND_LABEL: Record<FileChange["kind"], string> = {
  modified: "고쳐요",
  added: "새로 만들어요",
  moved: "옮겨요",
  "plugin-off": "꺼요",
};
const SHOW = 12; // 줄이 많은 변경은 앞부분만 펼친다

function OneChange({ change }: { change: FileChange }) {
  const [all, setAll] = useState(false);
  const added = change.diff.filter((l) => l.op === "+").length;
  const removed = change.diff.filter((l) => l.op === "-").length;
  const lines = all ? change.diff : change.diff.slice(0, SHOW);
  const hidden = change.diff.length - lines.length;
  return (
    <div className="diff-file">
      <p className="diff-head">
        <span className="diff-path">{change.rel}</span>
        <span className="meta">
          {KIND_LABEL[change.kind]}
          {change.diff.length > 0 && ` · +${num(added)}줄${removed > 0 ? `, -${num(removed)}줄` : ", 지우는 줄 없음"}`}
        </span>
      </p>
      {change.note && <p className="help">{change.note}</p>}
      {lines.length > 0 && (
        <div className="diff" role="group" aria-label={`${change.rel} 바뀌는 줄`}>
          {lines.map((l, i) => (
            <div key={i} className={`diff-line ${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}`}>
              <span className="diff-op" aria-label={l.op === "+" ? "추가" : l.op === "-" ? "삭제" : "그대로"}>
                {l.op === " " ? "\u00a0" : l.op}
              </span>
              <span className="diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {change.diff.length > SHOW && (
        <button className="btn btn-ghost btn-sm" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "접기" : `${num(hidden)}줄 더 보기`}
        </button>
      )}
    </div>
  );
}

/** 바뀌는 파일마다 경로, 줄 수 요약, 바뀌는 줄을 보여 준다 */
export function DiffView({ changes }: { changes: FileChange[] }) {
  return (
    <div className="diff-list">
      {changes.map((c) => (
        <OneChange key={c.rel} change={c} />
      ))}
    </div>
  );
}
