import { useState } from "react";
import type { Finding } from "../../shared/types";
import { useUi } from "../context";
import { KIND_LABEL, SEVERITY_BADGE, SEVERITY_LABEL } from "../format";
import { itemsByIds } from "../model";

const CHIP_LIMIT = 8;

/** 항목 이름 칩 목록. 누르면 항목 모달이 열린다 */
export function ItemChips({ ids, label }: { ids: string[]; label?: string }) {
  const { model, openItem } = useUi();
  const [all, setAll] = useState(false);
  const items = itemsByIds(model, ids);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, CHIP_LIMIT);
  return (
    <div className="chips" role="group" aria-label={label ?? "관련 항목"}>
      {shown.map((it) => (
        <button key={it.id} className="btn btn-secondary btn-sm" type="button" onClick={() => openItem(it.id)}>
          <span className="chip-kind">{KIND_LABEL[it.kind]}</span>
          {it.name}
        </button>
      ))}
      {items.length > CHIP_LIMIT && (
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAll(!all)}>
          {all ? "접기" : `외 ${items.length - CHIP_LIMIT}개 더 보기`}
        </button>
      )}
    </div>
  );
}

export function FindingCard({ finding, headingLevel = 3 }: { finding: Finding; headingLevel?: 2 | 3 | 4 }) {
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <article className="card finding" aria-label={finding.title}>
      <div className="finding-head">
        <span className={`badge ${SEVERITY_BADGE[finding.severity]}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <H className="finding-title">{finding.title}</H>
      </div>
      <div className="finding-block">
        <p className="finding-label">왜 중요한가요?</p>
        <p>{finding.why}</p>
      </div>
      <div className="finding-block">
        <p className="finding-label">이렇게 고쳐요</p>
        <p>{finding.fix}</p>
      </div>
      <p className="finding-evidence">
        <span className="finding-label">근거</span> {finding.evidence}
      </p>
      <ItemChips ids={finding.items} />
    </article>
  );
}
