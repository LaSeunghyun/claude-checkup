import { useMemo } from "react";
import type { Finding } from "../../shared/types";
import { topTodos } from "../../shared/rank";
import { CompareStrip } from "../components/CompareStrip";
import { Header } from "../components/Header";
import { RiskPanel } from "../components/RiskPanel";
import { withTerms } from "../components/Terms";
import { TodoCard } from "../components/TodoCard";
import { useUi } from "../context";
import { a4, dateTimeText, num, pages } from "../format";
import type { Theme } from "../hooks";
import { Warnings } from "./Usage";

interface CheckupProps {
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan: () => void;
  onFix: (finding: Finding) => void;
}

export function Checkup({ theme, onToggleTheme, onSettings, onRescan, onFix }: CheckupProps) {
  const { model, go } = useUi();
  const { snap } = model;
  const risks = useMemo(() => snap.findings.filter((f) => f.category === "risk"), [snap.findings]);
  const todos = useMemo(() => topTodos(snap.findings, 3), [snap.findings]);

  // 용어 설명은 화면에서 처음 나오는 곳에만 붙인다. 위에서 아래 순서대로 만든다
  const seen = new Set<string>();
  const riskHeading = risks.length === 1 ? withTerms(risks[0]!.title, seen) : undefined;
  const riskWhy = risks.length > 0 ? withTerms(risks[0]!.why, seen) : undefined;
  const cards = todos.map((f) => ({ f, title: withTerms(f.title, seen), evidence: withTerms(f.evidence, seen) }));

  const { totalTokens, unusedTokens } = snap.summary;

  return (
    <>
      <Header
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSettings={onSettings}
        onRescan={onRescan}
        left={
          <>
            <h1 className="top-title">내 Claude 설정 검진 결과</h1>
            <p className="meta">
              {dateTimeText(snap.generatedAt)} 점검 · 최근 30일 대화 기록 {num(snap.stats.transcriptsScanned)}개 파일 기준 · AI를 쓰지 않아 토큰 0
            </p>
          </>
        }
      />

      <section className="card verdict" aria-label="판정">
        <p className="big">
          {todos.length > 0 ? (
            <>
              손볼 곳이 <em>{todos.length}가지</em> 있어요.
            </>
          ) : risks.length > 0 ? (
            <>위험한 곳부터 살펴봐 주세요.</>
          ) : snap.findings.length > 0 ? (
            <>앱이 바로 고쳐 줄 곳은 없어요.</>
          ) : (
            <>손볼 곳이 없어요.</>
          )}
        </p>
        {totalTokens > 0 ? (
          <p>
            지금은 대화를 시작할 때마다 {a4(totalTokens)}이 미리 채워져요.
            <br />
            {unusedTokens > 0 ? `그중 ${pages(unusedTokens)}은 한 달 동안 한 번도 안 쓴 내용이에요.` : "그중 한 달 동안 안 쓴 내용은 없어요."}
          </p>
        ) : (
          <p>대화를 시작할 때 미리 채워지는 내용이 아직 없어요.</p>
        )}
      </section>

      <RiskPanel findings={risks} heading={riskHeading} why={riskWhy} />

      {cards.length > 0 && (
        <section aria-label="할 일">
          <h2 className="section-title">효과가 큰 순서로 이렇게 해 보세요</h2>
          <div className="todo-list">
            {cards.map((c, i) => (
              <TodoCard key={c.f.id} finding={c.f} onFix={onFix} rank={i + 1} title={c.title} evidence={c.evidence} />
            ))}
          </div>
        </section>
      )}

      <CompareStrip current={snap.summary} previous={snap.previous} />

      {snap.warnings.length > 0 && <Warnings lines={snap.warnings} />}

      <div className="more">
        <button className="btn btn-primary" type="button" onClick={() => go({ name: "links" })}>
          연결 지도 보기
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => go({ name: "findings", severity: "all" })}>
          전체 진단 {num(snap.findings.length)}건
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => go({ name: "usage" })}>
          사용 현황
        </button>
      </div>
    </>
  );
}
