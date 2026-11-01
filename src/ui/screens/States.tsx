import type { Progress } from "../../shared/types";
import { num, percent } from "../format";
import { Alert, Inbox } from "../icons";

const PHASE_TEXT: Record<Progress["phase"], string> = {
  idle: "점검을 준비하고 있어요",
  inventory: "설정 파일을 모으는 중이에요",
  transcripts: "대화 기록을 읽는 중이에요",
  diagnose: "문제를 찾는 중이에요",
  done: "거의 다 됐어요",
  error: "점검 중에 문제가 생겼어요",
};

/** 첫 점검 중: 진행률 */
export function ScanningState({ progress }: { progress: Progress }) {
  const known = progress.filesTotal > 0;
  const pct = known ? Math.min(100, percent(progress.filesDone, progress.filesTotal)) : 0;
  return (
    <section className="card" aria-label="점검 중">
      <div className="state" role="status" aria-live="polite">
        <h2 className="state-title">설정을 점검하는 중이에요</h2>
        <p className="state-desc">{PHASE_TEXT[progress.phase]}</p>
        <div
          className={`progress${known ? "" : " is-indeterminate"}`}
          role="progressbar"
          aria-label="점검 진행률"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={known ? pct : undefined}
        >
          <i style={known ? { width: `${pct}%` } : undefined} />
        </div>
        <p className="loading-text">
          {known ? `${num(progress.filesDone)}개 / ${num(progress.filesTotal)}개 읽었어요 (${pct}퍼센트)` : "읽을 파일을 세는 중이에요"}
        </p>
        {progress.message && <p className="meta">{progress.message}</p>}
        <p className="state-desc">
          모두 이 PC 안에서만 읽어요. 밖으로 보내지 않아요. 처음에는 대화 기록이 많으면 몇 분 걸릴 수 있고, 다음부터는 바뀐 것만 읽어서 빨라요.
        </p>
      </div>
    </section>
  );
}

/** 점검 실패: 원인과 다시 점검 */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="card" aria-label="점검 실패">
      <div className="state state--error" role="alert">
        <span className="state-icon" aria-hidden="true">
          <Alert size={24} />
        </span>
        <h2 className="state-title">점검하지 못했어요</h2>
        <p className="state-desc">{message}</p>
        <div className="state-actions">
          <button className="btn btn-primary" type="button" onClick={onRetry}>
            다시 점검하기
          </button>
        </div>
      </div>
    </section>
  );
}

/** .claude 폴더가 없을 때 */
export function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="card" aria-label="점검할 내용 없음">
      <div className="state">
        <span className="state-icon" aria-hidden="true">
          <Inbox size={24} />
        </span>
        <h2 className="state-title">점검할 .claude 폴더가 없어요</h2>
        <p className="state-desc">
          Claude Code를 한 번이라도 쓰면 내 홈 폴더에 .claude 폴더가 생겨요. Claude Code를 쓴 뒤에 다시 점검해 주세요.
        </p>
        <div className="state-actions">
          <button className="btn btn-primary" type="button" onClick={onRetry}>
            다시 점검하기
          </button>
        </div>
      </div>
    </section>
  );
}

/** 처음 설정을 불러오는 짧은 순간 */
export function BootState() {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <div className="skeleton-row">
        <span className="skeleton-lines">
          <span className="skeleton-line" />
          <span className="skeleton-line is-short" />
        </span>
      </div>
      <p className="loading-text">불러오는 중이에요</p>
    </div>
  );
}
