import { useMemo } from "react";
import type { Severity } from "../../shared/types";
import { Header } from "../components/Header";
import { useUi } from "../context";
import { SEVERITY_BADGE, SEVERITY_LABEL, a4, dateTimeText, num, percent, periodText } from "../format";
import type { Theme } from "../hooks";
import { buildMap, type MapAction, type MapNode } from "../map";
import { idleTotal } from "../model";

interface HomeProps {
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan: () => void;
}

export function Home({ theme, onToggleTheme, onSettings, onRescan }: HomeProps) {
  const { model } = useUi();
  const { snap } = model;
  return (
    <>
      <Header
        theme={theme}
        onToggleTheme={onToggleTheme}
        onSettings={onSettings}
        onRescan={onRescan}
        withSearch
        left={
          <>
            <h1 className="top-title">내 Claude 설정 한눈에 보기</h1>
            <p className="top-desc">.claude 폴더에 넣어 둔 지시문, 메모리, 작업 설명서, 에이전트가 실제로 얼마나 쓰이는지 보여 줘요.</p>
            <p className="meta">
              최근 30일 기록 기준 · {periodText(snap.window)} · 점검 {dateTimeText(snap.generatedAt)}
            </p>
          </>
        }
      />
      <Summary />
      {snap.warnings.length > 0 && <Warnings lines={snap.warnings} />}
      <MapView />
    </>
  );
}

function Warnings({ lines }: { lines: string[] }) {
  return (
    <section className="notice" aria-label="읽지 못한 곳">
      <span className="badge badge-warning notice-badge">알아 두면 좋아요</span>
      <ul className="notice-list">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

function Summary() {
  const { model, go } = useUi();
  const { snap } = model;
  const { totalTokens, unusedTokens, budgetTokens } = snap.context;
  const usedTokens = Math.max(0, totalTokens - unusedTokens);
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
    for (const f of snap.findings) c[f.severity]++;
    return c;
  }, [snap.findings]);
  const idle = idleTotal(model);
  const usedPct = percent(usedTokens, totalTokens);

  return (
    <section className="card summary" aria-label="요약">
      {totalTokens > 0 ? (
        <p className="summary-lead">
          대화를 시작할 때마다 컨텍스트에 <em>{a4(totalTokens)}</em>이 미리 채워져요.
          {unusedTokens > 0 ? ` 그중 ${a4(unusedTokens)}은 한 달 동안 안 썼어요.` : " 한 달 동안 안 쓴 것은 없어요."}
        </p>
      ) : (
        <p className="summary-lead">대화를 시작할 때 미리 채워지는 내용이 아직 없어요.</p>
      )}
      {totalTokens > 0 && (
        <>
          <div className="fill" role="img" aria-label={`미리 채워지는 분량 중 쓴 것 ${usedPct}퍼센트, 안 쓴 것 ${100 - usedPct}퍼센트`}>
            <i className="used" style={{ flex: usedTokens }} />
            <i className="idle" style={{ flex: unusedTokens }} />
          </div>
          <div className="legend">
            <span>
              <i className="dot used" />한 달 안에 쓴 것 {a4(usedTokens)}
            </span>
            <span>
              <i className="dot idle" />한 번도 안 쓴 것 {a4(unusedTokens)}
            </span>
            <span className="meta">컨텍스트 전체의 {percent(totalTokens, budgetTokens)}퍼센트 (추정)</span>
          </div>
        </>
      )}
      <div className="checks">
        {(["high", "medium", "low"] as const).map(
          (s) =>
            counts[s] > 0 && (
              <span key={s} className={`badge ${SEVERITY_BADGE[s]}`}>
                {SEVERITY_LABEL[s]} {counts[s]}
              </span>
            ),
        )}
        {snap.findings.length === 0 && <span className="badge badge-success">고칠 것이 없어요</span>}
        {idle > 0 && <span className="badge">한 달 동안 안 쓴 것 {num(idle)}</span>}
        <span className="grow" />
        <button className="btn btn-primary" type="button" onClick={() => go({ name: "findings", severity: "all" })}>
          진단 결과 보기
        </button>
      </div>
    </section>
  );
}

function MapView() {
  const { model, go, openTools } = useUi();
  const spec = useMemo(() => buildMap(model), [model]);

  const act = (a: MapAction | undefined) => {
    if (!a) return;
    if (a.type === "tools") openTools();
    else go({ name: "section", key: a.key, mode: a.mode });
  };

  return (
    <>
      <div className="map-wrap" role="region" aria-label="설정 지도" tabIndex={0}>
        <div className="map" style={{ width: spec.width, height: spec.height }}>
          <svg width={spec.width} height={spec.height} viewBox={`0 0 ${spec.width} ${spec.height}`} aria-hidden="true">
            {spec.edges.map((e) => (
              <path key={e.id} className={`ln ${e.style}`} d={e.d} strokeWidth={e.width} />
            ))}
          </svg>
          {spec.labels.map((l) => (
            <span key={l.text} className="col-label" style={{ left: l.x, top: l.y }}>
              {l.text}
            </span>
          ))}
          {spec.nodes.map((n) => (
            <NodeBox key={n.id} node={n} onAct={act} />
          ))}
        </div>
      </div>
      <p className="meta">
        굵은 선은 자주 지나간 길, 점선은 &quot;목록이나 목차를 보고 찾아간다&quot;는 뜻이에요. 상자를 누르면 자세히 볼 수 있어요.
        <span className="scroll-hint"> 좁은 화면에서는 지도를 옆으로 밀어서 볼 수 있어요.</span>
      </p>
    </>
  );
}

function NodeBox({ node, onAct }: { node: MapNode; onAct: (a: MapAction | undefined) => void }) {
  const style = { left: node.x, top: node.y, width: node.w, minHeight: node.h };
  const cls = `node map-node${node.ghost ? " ghost" : ""}${node.pill ? " start" : ""}`;
  const body = (
    <>
      {(node.kind || node.tag) && (
        <span className="node-kind">
          {node.kind}
          {node.tag && <span className={`tag ${node.tag.tone}`}>{node.tag.text}</span>}
        </span>
      )}
      <span className="node-title">{node.title}</span>
      {node.meta && <span className="node-meta">{node.meta}</span>}
    </>
  );
  // 누를 곳이 없는 상자(대화 시작, 내 요청)는 버튼이 아니다
  if (!node.action) {
    return (
      <div className={`${cls} is-static`} style={style}>
        {body}
      </div>
    );
  }
  return (
    <button className={cls} style={style} type="button" onClick={() => onAct(node.action)}>
      {body}
    </button>
  );
}
