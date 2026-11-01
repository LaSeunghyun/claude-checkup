import { useId, useMemo, useState } from "react";
import type { Finding, Item } from "../../shared/types";
import { CopyButton } from "../components/CopyButton";
import { ItemChips } from "../components/FindingCard";
import { Header } from "../components/Header";
import { FixAction } from "../components/TodoCard";
import { useUi } from "../context";
import { a4, clip, num, percent } from "../format";
import type { Theme } from "../hooks";
import { ChevronLeft, ChevronRight } from "../icons";
import { flowsOf, layoutLinks, type LinkBox, type LinkColumn } from "../linkmap";

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan: () => void;
}

// 도식 좌표(px). 상자 하나의 크기와 칸 사이 간격
const X0 = 24;
const BOX_W = 216;
const COL_STRIDE = 280;
const TOP = 56;
const BOX_H = 124;
const ROW_STRIDE = 140;
const FILE_LIMIT = 20;

const COL_HEAD = ["출발점 · 매번 실려요", "1단계", "2단계 이상", "길 없음"];

/** 상자 이름: 프로젝트 메모리는 프로젝트 이름, 그 밖은 개인 */
function boxLabel(box: LinkBox, byId: Map<string, Item>): string {
  const s = byId.get(box.ids[0]!)?.source;
  return s?.type === "project" && s.project ? s.project : "개인";
}

function boxHint(box: LinkBox, colIndex: number, byId: Map<string, Item>, indexFolders: Set<string>): string {
  if (colIndex === 0) return clip(box.ids.map((id) => byId.get(id)?.name ?? "").join(", "), 36);
  if (box.lost) return indexFolders.has(box.folder) ? "목차에도, 링크에도 없어요" : "목차 파일이 없는 폴더";
  return box.read30 > 0 ? `한 달 동안 ${num(box.read30)}개 읽힘` : "한 달 동안 한 개도 안 읽혔어요";
}

export function Links({ theme, onToggleTheme, onSettings, onRescan }: Props) {
  const { model, go } = useUi();
  const { snap } = model;
  const layout = useMemo(() => layoutLinks(snap.graph, model.byId), [snap.graph, model.byId]);
  const flows = useMemo(() => flowsOf(snap.graph, layout), [snap.graph, layout]);
  const indexFolders = useMemo(() => {
    const s = new Set<string>();
    for (const n of snap.graph.nodes) if (model.byId.get(n.id)?.kind === "memory-index") s.add(n.folder);
    return s;
  }, [snap.graph, model.byId]);
  const [sel, setSel] = useState<string | null>(null); // `${칸}:${폴더}`

  const total = layout.columns.reduce((n, c) => n + c.boxes.reduce((m, b) => m + b.count, 0), 0);
  const lost = layout.columns[3]!.boxes.reduce((n, b) => n + b.count, 0);
  const lostRead = layout.columns[3]!.boxes.reduce((n, b) => n + b.read30, 0);
  const { leaks } = snap;

  const selected = useMemo(() => {
    if (!sel) return null;
    for (let c = 0; c < layout.columns.length; c++) {
      const b = layout.columns[c]!.boxes.find((x) => `${c}:${x.folder}` === sel);
      if (b) return { col: c, box: b };
    }
    return null;
  }, [sel, layout]);

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
              검진 결과
            </button>
            <h1 className="here">연결 지도</h1>
          </div>
        }
      />

      <section className="card verdict" aria-label="판정">
        {total === 0 ? (
          <p className="big">연결을 볼 md 파일이 아직 없어요.</p>
        ) : lost === 0 ? (
          <p className="big">
            md 파일 {num(total)}개는 <em>모두 길이 있어요.</em>
          </p>
        ) : (
          <p className="big">
            md 파일 {num(total)}개 중 <em>{num(lost)}개</em>는 길이 없어요.
          </p>
        )}
        {total > 0 && (
          <p>
            {num(total - lost)}개는 출발점에서 이어져 있어요.
            {lost > 0 &&
              (lostRead === 0
                ? ` 길이 없는 ${num(lost)}개는 한 달 동안 한 번도 읽히지 않았어요.`
                : ` 길이 없는 ${num(lost)}개 중 ${num(lostRead)}개만 한 달 동안 읽혔어요.`)}
            {leaks.unread > 0 && ` 길은 있지만 한 달 동안 안 읽힌 파일도 ${num(leaks.unread)}개 있어요.`}
          </p>
        )}
        <p className="sub">AI는 매번 실리는 CLAUDE.md 와 MEMORY.md 를 출발점으로, 목차와 링크를 따라 다른 파일을 찾아가요.</p>
      </section>

      {total > 0 && (
        <>
          <div className="legend" aria-label="범례">
            <span>
              <i className="ln-sample" aria-hidden="true" />
              목차나 링크로 이어짐
            </span>
            <span>
              <i className="ln-sample is-dashed" aria-hidden="true" />
              이름만 언급됨
            </span>
            <span>막대 = 한 달 동안 읽힌 파일의 비율</span>
          </div>
          <Diagram layout={layout} flows={flows} sel={sel} onSel={(k) => setSel(sel === k ? null : k)} indexFolders={indexFolders} />
          {selected && <FileList key={sel} col={selected.col} box={selected.box} onClose={() => setSel(null)} />}
        </>
      )}

      <section className="card leak-card" aria-label="연결 누수">
        <h2 className="section-title">연결 누수</h2>
        <div className="leaks">
          <LeakRow
            title={`길 없음 ${num(leaks.unreachable)}개`}
            desc="어디서도 이어지지 않아 AI가 찾을 수 없어요."
            count={leaks.unreachable}
            rule="unreachable-md"
          />
          <LeakRow
            title={`끊긴 링크 ${num(leaks.brokenLinks)}곳`}
            desc="지워진 파일을 가리키고 있어요."
            count={leaks.brokenLinks}
            rule="broken-link"
          />
          <LeakRow
            title={`길은 있는데 한 달 동안 안 읽힘 ${num(leaks.unread)}개`}
            desc="목차에는 있지만 쓰이지 않아요. 오래된 내용이면 정리 대상이에요."
            count={leaks.unread}
            rule="unread-md"
          />
          <LeakRow
            title={`매번 실리는데 안 쓰임 ${a4(leaks.unusedTokens)}`}
            desc="작업 설명서와 에이전트 목록 중 한 달 동안 한 번도 안 부른 것이에요."
            count={leaks.unusedTokens}
            onList={() => go({ name: "usage" })}
          />
        </div>
      </section>

      <div className="more">
        <button className="btn btn-primary" type="button" onClick={() => go({ name: "home" })}>
          검진 결과로 돌아가기
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => go({ name: "findings", severity: "all" })}>
          전체 진단 {num(snap.findings.length)}건
        </button>
      </div>
    </>
  );
}

// ---- 칸 도식 ----

function Diagram({
  layout,
  flows,
  sel,
  onSel,
  indexFolders,
}: {
  layout: { columns: LinkColumn[] };
  flows: ReturnType<typeof flowsOf>;
  sel: string | null;
  onSel: (key: string) => void;
  indexFolders: Set<string>;
}) {
  const { model } = useUi();
  const rows = Math.max(1, ...layout.columns.map((c) => c.boxes.length));
  const width = X0 * 2 + 3 * COL_STRIDE + BOX_W;
  const height = TOP + rows * ROW_STRIDE;
  const x = (c: number) => X0 + c * COL_STRIDE;
  const y = (r: number) => TOP + r * ROW_STRIDE;
  const maxCount = Math.max(1, ...flows.map((f) => f.count));
  return (
    <div className="map-wrap" role="region" aria-label="연결 지도 도식" tabIndex={0}>
      <div className="map" style={{ width, height }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {flows.map((f, i) => {
            const x1 = x(f.fromCol) + BOX_W;
            const y1 = y(f.fromBox) + BOX_H / 2;
            const x2 = x(f.toCol);
            const y2 = y(f.toBox) + BOX_H / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={i}
                className={`ln${f.mentionOnly ? " ref" : ""}`}
                d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                strokeWidth={1.5 + (f.count / maxCount) * 4.5}
              />
            );
          })}
        </svg>
        {layout.columns.map((col, c) => {
          const n = col.boxes.reduce((m, b) => m + b.count, 0);
          return (
            <div key={col.title}>
              <span className={`col-h${c === 3 ? " lost" : ""}`} style={{ left: x(c), top: X0 / 2 }}>
                {COL_HEAD[c]} · {num(n)}개
              </span>
              {col.boxes.length === 0 && (
                <span className="col-empty" style={{ left: x(c), top: TOP }}>
                  해당하는 파일이 없어요
                </span>
              )}
              {col.boxes.map((b, r) => {
                const key = `${c}:${b.folder}`;
                const label = boxLabel(b, model.byId);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`box${b.lost ? " lost" : ""}${sel === key ? " sel" : ""}`}
                    style={{ left: x(c), top: y(r), width: BOX_W, height: BOX_H }}
                    aria-pressed={sel === key}
                    onClick={() => onSel(key)}
                  >
                    <b>
                      {c === 0 ? `${label} 지시문·목차` : `${label} 메모리`} {num(b.count)}개
                    </b>
                    {c > 0 && !b.lost && (
                      <span className="meter" aria-hidden="true">
                        <i style={{ width: `${percent(b.read30, b.count)}%` }} />
                      </span>
                    )}
                    <span>{boxHint(b, c, model.byId, indexFolders)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- 묶음의 파일 목록 ----

function FileList({ col, box, onClose }: { col: number; box: LinkBox; onClose: () => void }) {
  const { model, openItem } = useUi();
  const [all, setAll] = useState(false);
  const items = useMemo(
    () =>
      box.ids
        .map((id) => model.byId.get(id))
        .filter((i): i is Item => !!i)
        .sort((a, b) => b.usage.count30 - a.usage.count30 || a.name.localeCompare(b.name)),
    [box.ids, model.byId],
  );
  const shown = all ? items : items.slice(0, FILE_LIMIT);
  const label = boxLabel(box, model.byId);
  return (
    <section className="card file-list" aria-label={`${label} 파일 목록`}>
      <div className="grp-h">
        <div>
          <h2 className="section-title file-list-title">
            {label} · {col === 3 ? "길 없는 " : ""}파일 {num(items.length)}개
          </h2>
          <p className="meta path">{box.folder || "폴더를 알 수 없어요"}</p>
        </div>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
          목록 접기
        </button>
      </div>
      <div className="list">
        {shown.map((it) => (
          <button key={it.id} className="list-row" type="button" onClick={() => openItem(it.id)}>
            <span className="list-row-main">
              <span className="list-row-title">{it.name}</span>
              <span className="list-row-meta">
                {it.usage.count30 > 0 ? `한 달 동안 ${num(it.usage.count30)}번 읽힘` : "한 달 동안 안 읽혔어요"}
              </span>
            </span>
            <span className="list-row-chevron" aria-hidden="true">
              <ChevronRight size={20} />
            </span>
          </button>
        ))}
      </div>
      {items.length > FILE_LIMIT && (
        <button className="btn btn-ghost btn-sm" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "접기" : `${num(items.length - FILE_LIMIT)}개 더 보기`}
        </button>
      )}
    </section>
  );
}

// ---- 누수 목록 ----

function FindingFix({ finding }: { finding: Finding }) {
  const { openFix } = useUi();
  return (
    <>
      <FixAction finding={finding} onFix={openFix} />
      {finding.fixKind === "manual" && finding.prompt && <CopyButton text={finding.prompt} label="맡길 말 복사" />}
    </>
  );
}

function LeakRow({ title, desc, count, rule, onList }: { title: string; desc: string; count: number; rule?: string; onList?: () => void }) {
  const { model } = useUi();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const list = useMemo(() => (rule ? model.snap.findings.filter((f) => f.rule === rule) : []), [rule, model.snap.findings]);
  const single = list.length === 1 ? list[0]! : null;
  return (
    <div className="leak">
      <div className="leak-text">
        <b>{title}</b>
        <p>{count > 0 ? desc : "없어요. 지금은 이 누수가 없어요."}</p>
      </div>
      {count > 0 && (
        <div className="acts">
          {single && <FindingFix finding={single} />}
          {list.length > 0 && (
            <button className="btn btn-ghost btn-sm" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
              {open ? "목록 접기" : "목록 보기"}
            </button>
          )}
          {onList && (
            <button className="btn btn-ghost btn-sm" type="button" onClick={onList}>
              목록 보기
            </button>
          )}
        </div>
      )}
      {list.length > 0 && (
        <div id={panelId} className="leak-list" hidden={!open}>
          {open &&
            list.map((f) => (
              <div key={f.id} className="leak-item">
                <p className="leak-item-title">{f.title}</p>
                <p className="sub">{f.evidence}</p>
                <ItemChips ids={f.items} label={f.title} />
                {list.length > 1 && (
                  <div className="acts">
                    <FindingFix finding={f} />
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
