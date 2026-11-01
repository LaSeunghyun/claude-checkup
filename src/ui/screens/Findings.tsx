import { useMemo } from "react";
import type { Severity } from "../../shared/types";
import { FindingCard } from "../components/FindingCard";
import { Header } from "../components/Header";
import { useUi } from "../context";
import { SEVERITY_LABEL, SEVERITY_ORDER, num } from "../format";
import { Check, ChevronLeft } from "../icons";
import type { SeverityFilter, Theme } from "../hooks";

interface Props {
  severity: SeverityFilter;
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan: () => void;
}

const FILTERS: SeverityFilter[] = ["all", "high", "medium", "low"];

export function Findings({ severity, theme, onToggleTheme, onSettings, onRescan }: Props) {
  const { model, go } = useUi();
  const all = model.snap.findings;

  const sorted = useMemo(
    () => [...all].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
    [all],
  );
  const counts: Record<SeverityFilter, number> = useMemo(() => {
    const c = { all: all.length, high: 0, medium: 0, low: 0 };
    for (const f of all) c[f.severity as Severity]++;
    return c;
  }, [all]);
  const shown = severity === "all" ? sorted : sorted.filter((f) => f.severity === severity);

  return (
    <>
      <Header
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSettings={onSettings}
        onRescan={onRescan}
        withSearch
        left={
          <div className="crumb">
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => go({ name: "home" })}>
              <ChevronLeft size={20} />
              전체 지도
            </button>
            <h1 className="here">진단 결과 {num(all.length)}가지</h1>
          </div>
        }
      />

      <section className="card summary" aria-label="진단 요약">
        <p className="summary-lead">
          {all.length === 0
            ? "고칠 것이 없어요. 지금 설정은 깔끔해요."
            : "심각한 순서로 모았어요. 고치지 않아도 바로 문제가 생기지는 않지만, 읽어 보고 정리하면 좋아요."}
        </p>
        <div className="bar">
          <div className="segmented" role="group" aria-label="심각도 거르기">
            {FILTERS.map((f) => (
              <button key={f} type="button" aria-pressed={severity === f} onClick={() => go({ name: "findings", severity: f }, true)}>
                {f === "all" ? "전체" : SEVERITY_LABEL[f]} {counts[f]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {all.length === 0 ? null : shown.length === 0 ? (
        <div className="card">
          <div className="state state--success">
            <span className="state-icon" aria-hidden="true">
              <Check size={24} />
            </span>
            <h2 className="state-title">이 단계에는 고칠 것이 없어요</h2>
            <p className="state-desc">다른 단계를 눌러 보세요.</p>
          </div>
        </div>
      ) : (
        <div className="findings">
          {shown.map((f) => (
            <FindingCard key={f.id} finding={f} headingLevel={2} />
          ))}
        </div>
      )}
    </>
  );
}
