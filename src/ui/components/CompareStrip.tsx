import type { HistorySummary } from "../../shared/types";
import { a4, num } from "../format";

interface Metric {
  label: string;
  before: number;
  after: number;
  show: (n: number) => string;
}

const sumOf = (s: HistorySummary) => Object.values(s.byCategory).reduce((a, b) => a + b, 0);

function metrics(prev: HistorySummary, now: HistorySummary): Metric[] {
  const cnt = (n: number) => `${num(n)}개`;
  return [
    { label: "대화마다 미리 채워지는 양", before: prev.totalTokens, after: now.totalTokens, show: a4 },
    { label: "한 달 동안 안 쓴 양", before: prev.unusedTokens, after: now.unusedTokens, show: a4 },
    { label: "길 없는 파일", before: prev.leaks.unreachable, after: now.leaks.unreachable, show: cnt },
    { label: "끊긴 링크", before: prev.leaks.brokenLinks, after: now.leaks.brokenLinks, show: (n) => `${num(n)}곳` },
    { label: "길은 있는데 안 읽힌 파일", before: prev.leaks.unread, after: now.leaks.unread, show: cnt },
    { label: "진단 결과", before: sumOf(prev), after: sumOf(now), show: (n) => `${num(n)}건` },
  ];
}

const change = (m: Metric) => Math.abs(m.after - m.before) / Math.max(m.before, m.after, 1);

/** 첫 점검이면 안내 문구, 아니면 지난 점검과 달라진 지표를 크기 순으로 3개까지 보여 준다 */
export function CompareStrip({ current, previous }: { current: HistorySummary; previous?: HistorySummary }) {
  if (!previous) {
    return <div className="compare">첫 검진이에요. 고친 뒤 다시 열면, 무엇이 얼마나 줄었는지 여기에 보여 드려요.</div>;
  }
  const changed = metrics(previous, current)
    .filter((m) => m.before !== m.after)
    .sort((a, b) => change(b) - change(a))
    .slice(0, 3);
  if (changed.length === 0) {
    return <div className="compare">지난 점검 때와 달라진 곳이 없어요.</div>;
  }
  return (
    <section className="compare has-prev" aria-label="지난 점검과 비교">
      <h2 className="compare-title">지난 점검과 달라진 곳</h2>
      <dl className="compare-list">
        {changed.map((m) => {
          const better = m.after < m.before;
          return (
            <div key={m.label} className="compare-item">
              <dt>{m.label}</dt>
              <dd className={better ? "good" : "cost"}>
                <b>{m.show(m.after)}</b>
                <span>
                  지난번 {m.show(m.before)}, {better ? "줄었어요" : "늘었어요"}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
