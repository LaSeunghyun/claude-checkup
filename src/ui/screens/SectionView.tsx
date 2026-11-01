import { useState } from "react";
import type { Item } from "../../shared/types";
import { Header } from "../components/Header";
import { ItemNode, nodeTag } from "../components/ItemNode";
import { useUi } from "../context";
import { KIND_LABEL, a4, itemSourceName, num, sourceNote } from "../format";
import { Check, ChevronLeft, ChevronRight, Inbox } from "../icons";
import type { Theme } from "../hooks";
import {
  SECTIONS,
  groupCards,
  idleList,
  sectionStats,
  usageList,
  usageOf,
  type GroupCard,
  type SectionKey,
  type ViewMode,
} from "../model";

interface Props {
  sectionKey: SectionKey;
  mode: ViewMode;
  theme: Theme;
  onToggleTheme: () => void;
  onSettings: () => void;
  onRescan: () => void;
}

const GROUP_LIMIT = 6; // 묶음 카드에 처음 보여 주는 항목 수
const ROW_PAGE = 40; // 목록 보기에서 한 번에 보여 주는 줄 수

function lead(key: SectionKey, s: ReturnType<typeof sectionStats>): string {
  const { noun } = SECTIONS[key];
  const mem = s.tokens > 0 ? a4(s.tokens) : "";
  switch (key) {
    case "instruction":
      return `지시문 ${num(s.total)}개는 대화마다 항상 읽혀요. 합치면 컨텍스트에 ${mem}을 차지해요.`;
    case "memory-index":
      return `메모리 목차는 대화마다 앞 200줄까지 읽혀요. 지금 컨텍스트에 ${mem}을 차지해요.`;
    case "memory":
      return `메모리 파일 ${num(s.total)}개 중 한 달 동안 읽은 것은 ${num(s.used)}개예요. 필요할 때만 읽어서 대화마다 미리 채워지지는 않아요.`;
    case "skill":
      return `작업 설명서와 직접 부르는 명령 ${num(s.total)}개 중 한 달 동안 쓴 것은 ${num(s.used)}개예요. 목록은 대화마다 컨텍스트에 ${mem}을 차지해요.`;
    case "agent":
      return `에이전트 ${num(s.total)}개 중 한 달 동안 쓴 것은 ${num(s.used)}개예요. 목록은 대화마다 컨텍스트에 ${mem}을 차지해요.`;
    case "hook":
      return `자동 실행 규칙 ${num(s.total)}개 중 한 달 동안 실행된 것은 ${num(s.used)}개예요.${s.tokens > 0 ? ` 대화마다 이 규칙들이 넣는 글은 ${mem}이에요.` : ""}`;
    case "mcp":
      return `연결된 서비스 ${num(s.total)}개 중 한 달 동안 쓴 것은 ${num(s.used)}개예요.`;
    default:
      return `${noun} ${num(s.total)}개`;
  }
}

export function SectionView({ sectionKey, mode, theme, onToggleTheme, onSettings, onRescan }: Props) {
  const { model, go } = useUi();
  const def = SECTIONS[sectionKey];
  const stats = sectionStats(model, sectionKey);
  const all = model.snap.items.filter((i) => def.kinds.includes(i.kind)).length;
  const effective: ViewMode = def.hasUsage ? mode : "groups";
  const setMode = (m: ViewMode) => go({ name: "section", key: sectionKey, mode: m }, true);

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
            <h1 className="here">
              {def.noun} {num(all)}개
            </h1>
          </div>
        }
      />

      <section className="card summary" aria-label="요약">
        <p className="summary-lead">{lead(sectionKey, stats)}</p>
        {def.hasUsage && (
          <div className="bar">
            <div className="segmented" role="group" aria-label="보는 방식">
              <button type="button" aria-pressed={effective === "groups"} onClick={() => setMode("groups")}>
                묶음별
              </button>
              <button type="button" aria-pressed={effective === "usage"} onClick={() => setMode("usage")}>
                많이 쓴 순
              </button>
              <button type="button" aria-pressed={effective === "idle"} onClick={() => setMode("idle")}>
                안 쓴 것만 {num(stats.idle)}
              </button>
            </div>
          </div>
        )}
      </section>

      {all === 0 ? (
        <div className="card">
          <div className="state">
            <span className="state-icon" aria-hidden="true">
              <Inbox size={24} />
            </span>
            <h2 className="state-title">{def.noun}이 하나도 없어요</h2>
            <p className="state-desc">이 PC의 .claude 폴더에서 찾지 못했어요.</p>
          </div>
        </div>
      ) : effective === "groups" ? (
        <Groups sectionKey={sectionKey} />
      ) : (
        <FlatList
          key={`${sectionKey}-${effective}`}
          items={effective === "usage" ? usageList(model, sectionKey) : idleList(model, sectionKey)}
          mode={effective}
        />
      )}
    </>
  );
}

function Groups({ sectionKey }: { sectionKey: SectionKey }) {
  const { model } = useUi();
  const cards = groupCards(model, sectionKey);
  return (
    <div className="groups">
      {cards.map((c) => (
        <GroupBox key={c.id + c.title} card={c} hasUsage={SECTIONS[sectionKey].hasUsage} />
      ))}
    </div>
  );
}

function GroupBox({ card, hasUsage }: { card: GroupCard; hasUsage: boolean }) {
  const [all, setAll] = useState(false);
  const idleGroup = hasUsage && card.used === 0;
  const shown = all ? card.items : card.items.slice(0, GROUP_LIMIT);
  const rest = card.items.length - GROUP_LIMIT;
  return (
    <section className={`card grp${idleGroup ? " is-idle" : ""}`} aria-label={card.title}>
      <div className="grp-h">
        <h2 className="grp-title">{card.title}</h2>
        {hasUsage && (
          <span className={`badge${card.used > 0 ? " badge-success" : ""}`}>
            {num(card.items.length)}개 중 {num(card.used)}개 씀
          </span>
        )}
      </div>
      <p className="meta">{sourceNote(card.source)}</p>
      {shown.map((it) => (
        <ItemNode key={it.id} item={it} />
      ))}
      {rest > 0 && (
        <button className="btn btn-secondary btn-sm" type="button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "접기" : `나머지 ${num(rest)}개 보기`}
        </button>
      )}
    </section>
  );
}

function rowEnd(item: Item, mode: ViewMode): { main: string; sub?: string } {
  if (mode === "idle") return { main: item.alwaysLoaded ? `${num(item.alwaysLoaded.chars)}자` : "0자", sub: "대화마다 읽어요" };
  const t = nodeTag(item);
  return { main: usageOf(item) > 0 || !item.enabled ? t.text : "0번" };
}

function FlatList({ items, mode }: { items: Item[]; mode: ViewMode }) {
  const { openItem } = useUi();
  const [limit, setLimit] = useState(ROW_PAGE);
  if (items.length === 0) {
    return (
      <div className="card">
        <div className="state state--success">
          <span className="state-icon" aria-hidden="true">
            <Check size={24} />
          </span>
          <h2 className="state-title">{mode === "idle" ? "안 쓴 것이 없어요" : "보여 줄 항목이 없어요"}</h2>
          <p className="state-desc">{mode === "idle" ? "켜 둔 항목을 모두 한 달 안에 썼어요." : "이 PC의 .claude 폴더에서 찾지 못했어요."}</p>
        </div>
      </div>
    );
  }
  return (
    <section className="group" aria-label={mode === "idle" ? "안 쓴 것" : "많이 쓴 순"}>
      {mode === "idle" && (
        <div className="group-head">
          <h2 className="group-title">대화마다 차지하는 글자가 많은 순</h2>
          <span className="group-note">{num(items.length)}개</span>
        </div>
      )}
      <ul className="list">
        {items.slice(0, limit).map((it) => {
          const end = rowEnd(it, mode);
          return (
            <li key={it.id}>
              <button className="list-row" type="button" onClick={() => openItem(it.id)}>
                <span className="list-row-main">
                  <span className="list-row-title">{it.name}</span>
                  <span className="list-row-meta">
                    {KIND_LABEL[it.kind]} · {itemSourceName(it)}
                  </span>
                </span>
                <span className="list-row-end">
                  {end.main}
                  {end.sub && <span className="list-row-meta">{end.sub}</span>}
                </span>
                <span className="list-row-chevron">
                  <ChevronRight size={24} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <button className="btn btn-secondary" type="button" onClick={() => setLimit(limit + ROW_PAGE)}>
          {num(Math.min(ROW_PAGE, items.length - limit))}개 더 보기
        </button>
      )}
    </section>
  );
}
