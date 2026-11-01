import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Finding, FixJob, FixPreview, HistorySummary } from "../../shared/types";
import { agreeClaudeFix, applyFix, errorText, FixApiError, getFixJob, startFixPreview, undoFix } from "../api";
import { CopyButton } from "../components/CopyButton";
import { DiffView } from "../components/DiffView";
import { CloseButton, Modal } from "../components/Modal";
import { StepList } from "../components/TodoCard";
import { useUi } from "../context";
import { KIND_LABEL, a4, num, pages } from "../format";
import { itemsByIds } from "../model";

const POLL_MS = 700;
const TURNS_OFF_SHOWN = 3;
// 여러 항목이 묶인 진단은 먼저 어떤 항목을 고칠지 고른다 (design.md 8-2절)
const MULTI_RULES = new Set(["unused-items", "unreachable-md", "unread-md"]);

type Stage =
  | { k: "pick" }
  | { k: "consent" }
  | { k: "running"; jobId?: string; message?: string }
  | { k: "preview"; job: FixJob }
  | { k: "applied"; job: FixJob }
  | { k: "undone"; message: string }
  | { k: "failed"; message: string }
  | { k: "fallback"; message: string };

/** "약 1만 2천 토큰" */
export function tokenText(n: number): string {
  const r = Math.round(n / 1000) * 1000;
  if (r <= 0) return "1천 토큰 미만";
  const man = Math.floor(r / 10000);
  const cheon = (r % 10000) / 1000;
  return `약 ${[man > 0 ? `${man}만` : "", cheon > 0 ? `${cheon}천` : ""].filter(Boolean).join(" ")} 토큰`;
}

const sumCats = (s: HistorySummary) => Object.values(s.byCategory).reduce((a, b) => a + b, 0);

function toggled(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (!n.delete(id)) n.add(id);
  return n;
}

interface Props {
  finding: Finding;
  onClose: () => void;
  /** 적용이나 되돌리기로 점검 결과가 바뀌었을 때 (화면 데이터를 새로 읽는다) */
  onChanged: () => void;
  /** 결과의 "다음 할 일 보기" */
  onNext: () => void;
}

export function FixSheet({ finding, onClose, onChanged, onNext }: Props) {
  const { model } = useUi();
  const titleId = useId();
  const multi = finding.items.length > 1 && MULTI_RULES.has(finding.rule);
  const [stage, setStage] = useState<Stage>({ k: multi ? "pick" : "running" });
  const [picked, setPicked] = useState<Set<string>>(() => new Set(finding.items));
  const [archive, setArchive] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const itemIds = multi ? finding.items.filter((id) => picked.has(id)) : undefined;

  const handleJob = useCallback((job: FixJob) => {
    if (job.status === "running") setStage({ k: "running", jobId: job.id, message: job.message });
    else if (job.status === "ready") {
      setArchive(new Set());
      setStage({ k: "preview", job });
    } else if (job.status === "applied") setStage({ k: "applied", job });
    else if (job.status === "undone") setStage({ k: "undone", message: job.message ?? "원래대로 되돌렸어요." });
    else setStage({ k: "failed", message: job.message ?? "변경안을 만들지 못했어요." });
  }, []);

  const start = useCallback(
    async (ids: string[] | undefined) => {
      setError(undefined);
      setStage({ k: "running" });
      try {
        handleJob(await startFixPreview({ findingId: finding.id, ...(ids ? { itemIds: ids } : {}) }));
      } catch (e) {
        if (e instanceof FixApiError && e.needConsent) setStage({ k: "consent" });
        else if (e instanceof FixApiError && e.fallback) setStage({ k: "fallback", message: e.message });
        else setStage({ k: "failed", message: errorText(e) });
      }
    },
    [finding.id, handleJob],
  );

  // 항목을 고를 필요가 없는 진단은 열자마자 미리 보기를 만든다
  const started = useRef(false);
  useEffect(() => {
    if (started.current || multi) return;
    started.current = true;
    void start(undefined);
  }, [multi, start]);

  // 실행 중이면 0.7초마다 작업 상태를 묻는다. 시트를 닫으면(언마운트) 멈춘다
  const jobId = stage.k === "running" ? stage.jobId : undefined;
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const job = await getFixJob(jobId);
        if (!alive) return;
        if (job.status === "running") {
          setStage((s) => (s.k === "running" ? { ...s, message: job.message } : s));
          timer = setTimeout(tick, POLL_MS);
        } else handleJob(job);
      } catch (e) {
        if (alive) setStage({ k: "failed", message: errorText(e) });
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId, handleJob]);

  const agree = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await agreeClaudeFix();
      setBusy(false);
      void start(itemIds);
    } catch (e) {
      setBusy(false);
      setError(errorText(e, "동의를 저장하지 못했어요. 다시 눌러 주세요."));
    }
  };

  const apply = async (job: FixJob) => {
    setBusy(true);
    setError(undefined);
    try {
      const hasCandidates = (job.preview?.candidates.length ?? 0) > 0;
      const done = await applyFix(job.id, hasCandidates ? [...archive] : undefined);
      setBusy(false);
      if (done.status === "applied") {
        setStage({ k: "applied", job: { ...done, preview: done.preview ?? job.preview } });
        changed.current();
      } else handleJob(done);
    } catch (e) {
      setBusy(false);
      setError(errorText(e, "적용하지 못했어요. 파일은 바뀌지 않았어요."));
    }
  };

  const undo = async (job: FixJob) => {
    if (!job.backupId) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await undoFix(job.backupId);
      setBusy(false);
      if (r.ok) {
        setStage({ k: "undone", message: r.message });
        changed.current();
      } else setError(r.message);
    } catch (e) {
      setBusy(false);
      setError(errorText(e, "되돌리지 못했어요."));
    }
  };

  const head = (label: string, title: string) => (
    <div className="dlg-head">
      <div className="dlg-head-text">
        <span className="term">{label}</span>
        <h2 id={titleId}>{title}</h2>
      </div>
      <CloseButton onClick={onClose} />
    </div>
  );
  const errorBox = error && (
    <p className="field-error" role="alert">
      {error}
    </p>
  );
  const fallbackBody = (
    <>
      <p className="dlg-sum">아래 방법으로 직접 고칠 수 있어요. 앱은 아무것도 바꾸지 않았어요.</p>
      <div className="acts">
        {finding.prompt && <CopyButton text={finding.prompt} label="Claude에게 맡길 말 복사" />}
        {finding.command && <CopyButton text={finding.command} label="명령 복사" />}
      </div>
      <StepList finding={finding} />
    </>
  );

  let body: ReactNode = null;
  switch (stage.k) {
    case "pick": {
      const items = itemsByIds(model, finding.items);
      body = (
        <>
          {head("고치기", finding.title)}
          <p className="dlg-sum">고칠 항목을 골라 주세요. 기본은 모두 선택이에요.</p>
          <ItemChecklist
            legend="고칠 항목"
            rows={items.map((it) => ({ id: it.id, title: it.name, sub: KIND_LABEL[it.kind] }))}
            checked={picked}
            onToggle={(id) => setPicked((s) => toggled(s, id))}
            onAll={(on) => setPicked(on ? new Set(finding.items) : new Set())}
          />
          <div className="foot">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              취소
            </button>
            <button className="btn btn-primary" type="button" disabled={picked.size === 0} onClick={() => void start(itemIds)}>
              미리 보기 만들기
            </button>
          </div>
        </>
      );
      break;
    }
    case "consent":
      body = (
        <>
          {head("처음 한 번만 알려 드려요", "Claude로 고치기 전에 확인해 주세요")}
          <div className="card-inner">
            <h3 className="sec-title">Claude에게 보내는 것</h3>
            <ul className="bullets">
              <li>고칠 파일의 내용이에요. 메모리를 정리할 때는 그 메모리 폴더의 파일이에요.</li>
              <li>이름이나 내용에 토큰, 키 같은 비밀값이 있는 파일은 보내지 않아요.</li>
              <li>평소 Claude Code를 쓸 때 파일을 읽어 주는 것과 같아요.</li>
            </ul>
          </div>
          <div className="card-inner">
            <h3 className="sec-title">알아 두세요</h3>
            <ul className="bullets">
              <li>변경안을 만들 때만 Claude 사용량이 들어요. 적용할 때는 추가로 들지 않아요.</li>
              <li>미리 보기를 만드는 동안에는 내 파일이 하나도 바뀌지 않아요.</li>
              <li>동의하지 않아도 직접 하는 방법과 맡길 말 복사는 그대로 쓸 수 있어요.</li>
            </ul>
          </div>
          {errorBox}
          <div className="sheet-foot" role="group" aria-label="Claude 고치기 동의 선택">
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={agree}>
              동의하고 계속
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => setStage({ k: "fallback", message: "동의하지 않아서 Claude로 고치지 않았어요." })}
            >
              동의하지 않기
            </button>
          </div>
        </>
      );
      break;
    case "running":
      body = (
        <>
          {head("미리 보기", finding.title)}
          <div className="running" role="status">
            <span className="running-dot" aria-hidden="true" />
            <div>
              <p className="running-title">
                {stage.message ?? (finding.fixKind === "claude" ? "Claude가 변경안을 만들고 있어요." : "변경안을 계산하고 있어요.")}
              </p>
              <p className="help">
                {finding.fixKind === "claude" ? "파일 크기에 따라 몇십 초 걸릴 수 있어요. " : ""}
                취소해도 내 파일은 바뀌지 않아요.
              </p>
            </div>
          </div>
          <div className="foot">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              취소
            </button>
          </div>
        </>
      );
      break;
    case "preview": {
      const job = stage.job;
      const p = job.preview;
      if (!p) break;
      body = (
        <>
          {head(
            job.kind === "claude"
              ? "미리 보기 · Claude가 만든 변경안이에요. 아직 아무것도 바뀌지 않았어요"
              : "미리 보기 · AI 없이 바로 할 수 있는 일이라 사용량이 들지 않아요",
            finding.title,
          )}
          <PreviewBody
            job={job}
            preview={p}
            archive={archive}
            onToggleArchive={(id) => setArchive((s) => toggled(s, id))}
            picks={multi ? picked.size : undefined}
            onRepick={multi ? () => setStage({ k: "pick" }) : undefined}
          />
          {errorBox}
          <div className="foot">
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>
              취소
            </button>
            {job.kind === "claude" && (
              <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void start(itemIds)}>
                {error ? "미리 보기 다시 만들기" : "다른 안 만들기"}
              </button>
            )}
            <button className="btn btn-primary" type="button" disabled={busy || !!p.blocked} onClick={() => void apply(job)}>
              {busy ? "적용하는 중..." : "적용하기"}
            </button>
          </div>
        </>
      );
      break;
    }
    case "applied": {
      const { job } = stage;
      const r = job.result;
      const good = job.preview?.effects.filter((e) => e.tone === "good") ?? [];
      body = (
        <>
          {head("적용 결과", "적용했어요")}
          <section className="done" aria-label="적용 결과">
            <h3 className="done-title">다시 점검했더니 이렇게 바뀌었어요</h3>
            {r && (
              <div className="vs">
                <Vs label="대화마다 미리 채워지는 양" before={a4(r.before.totalTokens)} after={pages(r.after.totalTokens)} was={r.before.totalTokens} now={r.after.totalTokens} />
                <Vs label="한 달 동안 안 쓴 양" before={pages(r.before.unusedTokens)} after={pages(r.after.unusedTokens)} was={r.before.unusedTokens} now={r.after.unusedTokens} />
                <Vs label="남은 진단" before={`${num(sumCats(r.before))}건`} after={`${num(sumCats(r.after))}건`} was={sumCats(r.before)} now={sumCats(r.after)} />
              </div>
            )}
            {good.length > 0 && (
              <div>
                <h4 className="sec-title">미리 보기에서 기대했던 값</h4>
                <ul className="bullets">
                  {good.map((e) => (
                    <li key={e.label}>
                      {e.label} {e.before} → {e.after}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="sub">Claude Code를 다시 시작하면 새 대화부터 적용돼요.</p>
            {errorBox}
            <div className="foot foot--start">
              {job.backupId && (
                <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void undo(job)}>
                  {busy ? "되돌리는 중..." : "되돌리기"}
                </button>
              )}
              <button className="btn btn-secondary" type="button" disabled={busy} onClick={onNext}>
                다음 할 일 보기
              </button>
            </div>
          </section>
        </>
      );
      break;
    }
    case "undone":
      body = (
        <>
          {head("되돌리기", "원래대로 되돌렸어요")}
          <p className="dlg-sum">{stage.message}</p>
          <p className="sub">Claude Code를 다시 시작하면 되돌린 내용이 새 대화부터 적용돼요.</p>
          <div className="foot">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              닫기
            </button>
          </div>
        </>
      );
      break;
    case "failed":
      body = (
        <>
          {head("고치지 못했어요", finding.title)}
          <p className="field-error" role="alert">
            {stage.message}
          </p>
          {fallbackBody}
          <div className="foot">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              닫기
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void start(itemIds)}>
              다시 시도
            </button>
          </div>
        </>
      );
      break;
    case "fallback":
      body = (
        <>
          {head("지금은 Claude로 고칠 수 없어요", finding.title)}
          <p className="dlg-sum">{stage.message}</p>
          {fallbackBody}
          <div className="foot">
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              닫기
            </button>
          </div>
        </>
      );
      break;
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} focusKey={stage.k}>
      {body}
    </Modal>
  );
}

function Vs({ label, before, after, was, now }: { label: string; before: string; after: string; was: number; now: number }) {
  const tone = was === now ? "" : now < was ? "good" : "cost";
  return (
    <div className="vs-cell">
      <b className={tone}>{was === now ? `${after} 그대로` : `${before} → ${after}`}</b>
      <span>{label}</span>
    </div>
  );
}

function ItemChecklist({
  legend,
  rows,
  checked,
  onToggle,
  onAll,
}: {
  legend: string;
  rows: { id: string; title: string; sub: string }[];
  checked: Set<string>;
  onToggle: (id: string) => void;
  onAll?: (on: boolean) => void;
}) {
  const all = rows.length > 0 && rows.every((r) => checked.has(r.id));
  return (
    <fieldset className="checklist">
      <legend className="sec-title">
        {legend}{" "}
        <span className="meta">
          {num(checked.size)}/{num(rows.length)}개 선택
        </span>
      </legend>
      {onAll && (
        <button className="btn btn-ghost btn-sm checklist-all" type="button" onClick={() => onAll(!all)}>
          {all ? "모두 해제" : "모두 선택"}
        </button>
      )}
      <ul className="checklist-rows">
        {rows.map((r) => (
          <li key={r.id}>
            <label className="check-row">
              <input type="checkbox" checked={checked.has(r.id)} onChange={() => onToggle(r.id)} />
              <span className="check-text">
                <span className="check-title">{r.title}</span>
                <span className="meta">{r.sub}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function PreviewBody({
  job,
  preview: p,
  archive,
  onToggleArchive,
  picks,
  onRepick,
}: {
  job: FixJob;
  preview: FixPreview;
  archive: Set<string>;
  onToggleArchive: (id: string) => void;
  picks?: number;
  onRepick?: () => void;
}) {
  const [allOff, setAllOff] = useState(false);
  const off = allOff ? p.turnsOff : p.turnsOff.slice(0, TURNS_OFF_SHOWN);
  const restart = p.changes.some((c) => c.kind === "plugin-off");
  const usage = p.usage ? p.usage.inputTokens + p.usage.outputTokens : 0;
  const archiveRows = useMemo(() => p.candidates.map((c) => ({ id: c.itemId, title: c.rel, sub: c.reason })), [p.candidates]);
  return (
    <>
      {p.blocked && (
        <div className="note note--danger" role="alert">
          <p className="note-title">지금은 적용할 수 없어요</p>
          <p>{p.blocked}</p>
        </div>
      )}
      {p.warnings.length > 0 && (
        <div className="note note--warn" role="status">
          <p className="note-title">확인해 주세요</p>
          {p.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      {picks != null && onRepick && (
        <p className="sub">
          고른 항목 {num(picks)}개로 만든 미리 보기예요.{" "}
          <button className="btn btn-ghost btn-sm" type="button" onClick={onRepick}>
            항목 다시 고르기
          </button>
        </p>
      )}

      {p.effects.length > 0 && (
        <div>
          <h3 className="sec-title">이렇게 하면 어떻게 되나요?</h3>
          <div className="effects">
            {p.effects.map((e) => (
              <div key={e.label} className={`eff ${e.tone}`}>
                <p>{e.label}</p>
                <b>
                  {e.before} → {e.after}
                </b>
              </div>
            ))}
          </div>
          <p className="meta effects-note">숫자는 아래 변경안을 그대로 다시 재서 계산했어요. 추측이 아니에요.</p>
        </div>
      )}

      {p.turnsOff.length > 0 && (
        <div>
          <h3 className="sec-title">꺼지는 것</h3>
          <ul className="lose">
            {off.map((t) => (
              <li key={t.name}>
                <b>{t.name}</b> {t.detail} <span className="meta">(최근 30일 {num(t.uses30)}번 썼어요)</span>
              </li>
            ))}
          </ul>
          {p.turnsOff.length > TURNS_OFF_SHOWN && (
            <button className="btn btn-ghost btn-sm" type="button" aria-expanded={allOff} onClick={() => setAllOff(!allOff)}>
              {allOff ? "접기" : `모두 보기 (${num(p.turnsOff.length)}개)`}
            </button>
          )}
        </div>
      )}

      {p.candidates.length > 0 && (
        <div className="stack">
          <p className="help">Claude가 오래됐거나 다른 파일과 겹친다고 본 파일이에요. 체크한 파일만 적용할 때 보관 폴더로 옮겨요. 지우지는 않아요.</p>
          <ItemChecklist legend="보관 후보" rows={archiveRows} checked={archive} onToggle={onToggleArchive} />
        </div>
      )}

      <div>
        <h3 className="sec-title">{p.changes.length > 0 ? `바뀌는 파일 ${num(p.changes.length)}개` : "바뀌는 파일"}</h3>
        {p.changes.length > 0 ? <DiffView changes={p.changes} /> : <p className="sub">바뀌는 파일이 없어요.</p>}
      </div>

      <div className="note">
        <p>적용하면 원본을 먼저 ~/.claude-checkup/backups/ 에 저장해요. 마음에 안 들면 이 화면이나 설정의 "최근 고친 것"에서 "되돌리기" 한 번으로 원래대로 돌아가요.</p>
        {restart && <p>끄는 것이지 지우는 것이 아니에요. Claude Code를 다시 시작하면 적용돼요.</p>}
        {job.kind === "claude" && p.usage ? (
          <p>
            이 변경안을 만드는 데 Claude 사용량 {tokenText(usage)}을 썼어요
            {p.usage.costUsd != null ? ` (약 $${p.usage.costUsd.toFixed(2)})` : ""}. 적용할 때는 추가로 쓰지 않아요.
          </p>
        ) : (
          <p>AI를 쓰지 않아서 사용량이 들지 않아요.</p>
        )}
      </div>
    </>
  );
}
