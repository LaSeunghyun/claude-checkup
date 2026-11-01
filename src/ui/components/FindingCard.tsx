import { useId, useState } from "react";
import type { Finding } from "../../shared/types";
import { revealItem } from "../api";
import { useUi } from "../context";
import { KIND_LABEL, SEVERITY_BADGE, SEVERITY_LABEL, SEVERITY_ORDER, num } from "../format";
import { itemsByIds } from "../model";
import { CopyButton } from "./CopyButton";
import { FixAction, StepList } from "./TodoCard";

const CHIP_LIMIT = 8;
const ROW_LIMIT = 5; // 묶음 카드는 앞의 몇 건만 펼쳐 둔다

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

/** 진단 한 건의 행동 줄: 고치기(또는 복사), manual 이면 맡길 말·명령 복사와 파일 위치 열기, 직접 하는 순서 */
export function FindingActions({ finding }: { finding: Finding }) {
  const { openFix } = useUi();
  const [open, setOpen] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const panelId = useId();
  const manual = finding.fixKind === "manual";
  const target = finding.items[0];
  return (
    <div className="finding-actions">
      <div className="acts">
        <FixAction finding={finding} onFix={openFix} />
        {manual && finding.prompt && <CopyButton text={finding.prompt} label="맡길 말 복사" />}
        {manual && finding.command && <CopyButton text={finding.command} label="명령 복사" />}
        {manual && target && (
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={async () => setRevealFailed(!(await revealItem(target)))}
          >
            파일 위치 열기
          </button>
        )}
        <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          {open ? "순서 접기" : "직접 하는 순서"}
        </button>
      </div>
      {revealFailed && <p className="help">파일 위치를 열지 못했어요. 위 근거에 적힌 파일을 직접 열어 주세요.</p>}
      <div id={panelId} hidden={!open}>
        {open && <StepList finding={finding} />}
      </div>
    </div>
  );
}

// 진단 결과 화면은 같은 규칙을 카드 하나로 묶는다. 왜·어떻게는 규칙마다 같은 문구라 한 번만 보여 준다
const RULE_TEXT: Record<string, { title: string; list: string }> = {
  "failing-hook": { title: "자동 실행 규칙이 실패했어요", list: "실패한 규칙" },
  "slow-hook": { title: "자동 실행 규칙이 느려요", list: "느린 규칙" },
  "memory-index-truncated": { title: "MEMORY.md가 길어서 뒷부분이 안 읽혀요", list: "해당 목차" },
  "memory-index-near-limit": { title: "MEMORY.md가 읽히는 한도에 거의 찼어요", list: "해당 목차" },
  "broken-link": { title: "없는 파일을 가리키는 링크가 있어요", list: "링크가 끊긴 파일" },
  "unreachable-md": { title: "AI가 찾아갈 길이 없는 메모리 파일이 있어요", list: "메모리 폴더별" },
  "unread-md": { title: "이어져 있지만 한 달 동안 안 읽힌 메모리 파일이 있어요", list: "메모리 폴더별" },
  "secret-in-file": { title: "파일 안에 토큰이나 키로 보이는 값이 있어요", list: "해당 파일" },
  "duplicate-rule": { title: "같은 규칙이 여러 지시문에 적혀 있어요", list: "겹치는 곳" },
  "duplicate-name": { title: "같은 이름이 여러 곳에 켜져 있어요", list: "겹치는 이름" },
  "similar-description": { title: "설명이 거의 같은 작업 설명서가 있어요", list: "비슷한 짝" },
  "missing-description": { title: "설명이 없는 항목이 있어요", list: "설명 없는 항목" },
  "unused-plugin": { title: "한 달 동안 안 쓴 플러그인이 있어요", list: "안 쓴 플러그인" },
  "unused-items": { title: "한 달 동안 안 쓴 작업 설명서와 에이전트가 있어요", list: "묶음별" },
  "long-skill": { title: "너무 긴 작업 설명서가 있어요", list: "긴 작업 설명서" },
};

/** 항목 하나짜리 진단은 칩이 이름을 대신하고, 여러 항목짜리는 진단 제목의 ':' 뒤를 줄 제목으로 쓴다 */
function rowTitle(f: Finding): string | null {
  if (f.items.length <= 1) return null;
  const i = f.title.indexOf(": ");
  return i >= 0 ? f.title.slice(i + 2) : f.title;
}

export function FindingGroupCard({ findings, headingLevel = 2 }: { findings: Finding[]; headingLevel?: 2 | 3 }) {
  const H = `h${headingLevel}` as "h2" | "h3";
  const f0 = findings[0];
  const text = RULE_TEXT[f0.rule];
  const severity = findings.reduce((s, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[s] ? f.severity : s), f0.severity);
  const title = text?.title ?? f0.title;
  const [all, setAll] = useState(false);
  const rows = all ? findings : findings.slice(0, ROW_LIMIT);
  return (
    <article className="card finding" aria-label={title}>
      <div className="finding-head">
        <span className={`badge ${SEVERITY_BADGE[severity]}`}>{SEVERITY_LABEL[severity]}</span>
        <H className="finding-title">{title}</H>
        <span className="finding-count">{num(findings.length)}건</span>
      </div>
      <div className="finding-block">
        <p className="finding-label">{text?.list ?? "해당 항목"}</p>
        <ul className="finding-rows">
          {rows.map((f) => {
            const rt = rowTitle(f);
            return (
              <li key={f.id} className="finding-row">
                {rt && <p className="finding-row-title">{rt}</p>}
                <ItemChips ids={f.items} />
                <p className="finding-evidence">{f.evidence}</p>
                <FindingActions finding={f} />
              </li>
            );
          })}
        </ul>
        {findings.length > ROW_LIMIT && (
          <button className="btn btn-ghost btn-sm finding-more" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? "접기" : `${num(findings.length - ROW_LIMIT)}건 더 보기`}
          </button>
        )}
      </div>
      <div className="finding-block">
        <p className="finding-label">왜 중요한가요?</p>
        <p>{f0.why}</p>
      </div>
      <div className="finding-block">
        <p className="finding-label">이렇게 고쳐요</p>
        <p>{f0.fix}</p>
      </div>
    </article>
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
      <FindingActions finding={finding} />
    </article>
  );
}
