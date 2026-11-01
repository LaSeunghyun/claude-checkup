import { useEffect, useId, useRef, useState } from "react";
import type { Finding, Item } from "../../shared/types";
import { getItemBody, type BodyResult } from "../api";
import { FindingCard, ItemChips } from "../components/FindingCard";
import { CloseButton, Modal } from "../components/Modal";
import { useUi } from "../context";
import { HOOK_EVENT, KIND_LABEL, KIND_ORIGIN, a4, dateText, num, seconds, sourceText } from "../format";
import { ChevronLeft } from "../icons";
import { usageOf } from "../model";

type Tab = "summary" | "links" | "body" | "usage";

interface Props {
  id: string;
  canBack: boolean;
  onBack: () => void;
  onClose: () => void;
}

// 원문을 못 받는 종류: 파일이 아니라 설정 한 줄이다
const NO_BODY: Item["kind"][] = ["hook", "mcp", "plugin"];

export function ItemModal({ id, canBack, onBack, onClose }: Props) {
  const { model } = useUi();
  const item = model.byId.get(id);
  const [tab, setTab] = useState<Tab>("summary");
  const titleId = useId();

  // 다른 항목으로 넘어가면 요약 탭에서 다시 시작한다
  useEffect(() => setTab("summary"), [id]);

  if (!item) return null;

  const outLinks = item.links.out.filter((x) => model.byId.has(x));
  const inLinks = item.links.in.filter((x) => model.byId.has(x));
  const linkCount = outLinks.length + inLinks.length;
  const tabs: { key: Tab; label: string }[] = [
    { key: "summary", label: "요약" },
    { key: "links", label: linkCount > 0 ? `연결 ${linkCount}` : "연결" },
    { key: "body", label: "원문" },
    { key: "usage", label: "사용" },
  ];

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length]!;
    setTab(t.key);
    document.getElementById(`${titleId}-tab-${t.key}`)?.focus();
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose} focusKey={id}>
      <div className="dlg-head">
        <div className="dlg-head-text">
          <span className="badge badge-brand">{KIND_LABEL[item.kind]}</span>
          {!item.enabled && <span className="badge dlg-off">꺼져 있어요</span>}
          <h2 id={titleId}>{item.name}</h2>
          <div className="term">
            원래 이름: {KIND_ORIGIN[item.kind]} · {sourceText(item.source)}
          </div>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className="tabs" role="tablist" aria-label="항목 정보" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t.key}
            id={`${titleId}-tab-${t.key}`}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            aria-controls={`${titleId}-panel`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`${titleId}-panel`} role="tabpanel" aria-labelledby={`${titleId}-tab-${tab}`} className="dlg-panel">
        {tab === "summary" && <SummaryPanel item={item} />}
        {tab === "links" && <LinksPanel outIds={outLinks} inIds={inLinks} />}
        {tab === "body" && <BodyPanel item={item} />}
        {tab === "usage" && <UsagePanel item={item} />}
      </div>

      {canBack && (
        <div className="dlg-foot">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onBack}>
            <ChevronLeft size={20} />
            이전 항목
          </button>
        </div>
      )}
    </Modal>
  );
}

// ---- 요약 ----

function usageLabel(item: Item): string {
  if (item.kind === "hook") return "한 달 동안 실행";
  if (item.kind === "memory") return "한 달 동안 읽음";
  return "한 달 동안 사용";
}

function SummaryPanel({ item }: { item: Item }) {
  const { model } = useUi();
  const always = item.kind === "instruction" || item.kind === "memory-index";
  const picks = item.kind === "skill" || item.kind === "command" || item.kind === "agent";
  const findings = item.findings.map((f) => model.findingsById.get(f)).filter((f): f is Finding => !!f);
  const noDesc = !item.summary.trim();

  return (
    <>
      <p className="dlg-sum">
        {noDesc
          ? picks
            ? "설명이 적혀 있지 않아요. 설명이 없으면 AI가 이 항목을 언제 쓸지 고를 근거가 없어요."
            : "설명이 적혀 있지 않아요."
          : item.summary}
      </p>

      <div className="stats">
        {always ? (
          <div className="stat">
            <b>매번</b>
            <span>대화를 시작할 때 읽어요</span>
          </div>
        ) : (
          <div className="stat">
            <b>{num(usageOf(item))}번</b>
            <span>{usageLabel(item)}</span>
          </div>
        )}
        <div className="stat">
          <b>{always ? "-" : dateText(item.usage.lastUsed)}</b>
          <span>{always ? "사용 기록은 따로 없어요" : "마지막 사용"}</span>
        </div>
        <div className="stat">
          <b>{item.alwaysLoaded ? `${num(item.alwaysLoaded.chars)}자` : "없음"}</b>
          <span>{item.alwaysLoaded ? "대화마다 미리 읽는 양" : "필요할 때만 읽어요"}</span>
        </div>
        <div className="stat">
          <b>{a4(item.size.tokens)}</b>
          <span>{always ? "전체 크기(추정)" : "쓸 때마다 읽는 본문(추정)"}</span>
        </div>
      </div>

      {item.alwaysLoaded && <p className="help">대화마다 미리 읽는 부분: {item.alwaysLoaded.what}</p>}

      {item.outline.length > 0 && (
        <div>
          <div className="sec-title">이 안에 든 내용</div>
          <ul className="outline">
            {item.outline.slice(0, 10).map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
          {item.outline.length > 10 && <p className="meta">그 밖에 {item.outline.length - 10}개 제목이 더 있어요.</p>}
        </div>
      )}

      {findings.length > 0 && (
        <div>
          <div className="sec-title">이 항목의 진단 {findings.length}</div>
          <div className="findings">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} headingLevel={3} />
            ))}
          </div>
        </div>
      )}

      {picks && (
        <div>
          <div className="sec-title">
            AI가 제때 골라 쓰나요? <span className="badge">준비 중</span>
          </div>
          <p className="node-meta">&quot;이런 요청에 이 항목을 고르는지&quot; 시험해 보는 기능은 다음 버전에서 만들 예정이에요. 지금은 실제로 쓴 기록만 보여 줘요.</p>
        </div>
      )}
    </>
  );
}

// ---- 연결 ----

const READ_KINDS: Item["kind"][] = ["memory", "memory-index", "instruction"];

function LinksPanel({ outIds, inIds }: { outIds: string[]; inIds: string[] }) {
  const { model } = useUi();
  const reads = outIds.filter((x) => READ_KINDS.includes(model.byId.get(x)!.kind));
  const calls = outIds.filter((x) => !READ_KINDS.includes(model.byId.get(x)!.kind));
  if (outIds.length + inIds.length === 0) {
    return <p className="node-meta">연결된 항목이 없어요. 다른 항목과 이어지지 않고 혼자 쓰이는 항목이에요.</p>;
  }
  return (
    <>
      <LinkSection title="이 항목이 부르는 것" ids={calls} />
      <LinkSection title="이 항목이 읽는 것" ids={reads} />
      <LinkSection title="이 항목을 부르는 곳" ids={inIds} />
    </>
  );
}

function LinkSection({ title, ids }: { title: string; ids: string[] }) {
  if (ids.length === 0) return null; // 비어 있는 갈래는 숨긴다
  return (
    <div>
      <div className="sec-title">
        {title} {ids.length}
      </div>
      <ItemChips ids={ids} label={title} />
    </div>
  );
}

// ---- 원문 ----

function BodyPanel({ item }: { item: Item }) {
  const [result, setResult] = useState<BodyResult | "loading">("loading");
  const [tries, setTries] = useState(0);
  const skip = NO_BODY.includes(item.kind) || ((item.source.type === "builtin" || item.source.type === "history") && !item.path);
  const live = useRef(0);

  useEffect(() => {
    if (skip) return;
    const my = ++live.current;
    setResult("loading");
    getItemBody(item.id).then((r) => {
      if (my === live.current) setResult(r);
    });
    return () => {
      live.current++;
    };
  }, [item.id, skip, tries]);

  if (skip) {
    return (
      <p className="node-meta">
        {item.kind === "hook"
          ? "자동 실행 규칙은 파일이 아니라 설정 한 줄이에요. 실행 내용은 사용 탭에서 볼 수 있어요."
          : item.kind === "mcp"
            ? "연결된 서비스는 이름만 읽어요. 접속 정보는 읽지도, 보여 주지도 않아요."
            : "이 항목은 보여 줄 원문 파일이 없어요."}
      </p>
    );
  }
  if (result === "loading") {
    return (
      <div className="skeleton" role="status" aria-busy="true">
        <div className="skeleton-row">
          <span className="skeleton-lines">
            <span className="skeleton-line" />
            <span className="skeleton-line" />
            <span className="skeleton-line is-short" />
          </span>
        </div>
        <p className="loading-text">원문을 불러오는 중이에요</p>
      </div>
    );
  }
  if (result.kind === "forbidden") {
    return <p className="node-meta">비밀 정보가 들어 있을 수 있는 파일이라 보여 주지 않아요.</p>;
  }
  if (result.kind === "error") {
    return (
      <div className="state state--error state-inline" role="alert">
        <h3 className="state-title">원문을 불러오지 못했어요</h3>
        <p className="state-desc">파일이 옮겨졌거나 점검 서버가 꺼졌을 수 있어요.</p>
        <div className="state-actions">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setTries(tries + 1)}>
            다시 불러오기
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {item.path && <p className="meta path">{item.path}</p>}
      <pre className="code-block" tabIndex={0} aria-label="원문">
        {result.body}
      </pre>
    </>
  );
}

// ---- 사용 ----

function UsagePanel({ item }: { item: Item }) {
  const u = item.usage;
  const max = Math.max(1, ...u.daily30);
  const sum = u.daily30.reduce((s, n) => s + n, 0);
  const via = u.via;
  const viaUser = via?.user ?? 0;
  const viaModel = via?.model ?? 0;
  const showVia = (item.kind === "skill" || item.kind === "command") && viaUser + viaModel > 0;
  const h = item.hook;
  const noRecord = item.kind === "instruction" || item.kind === "memory-index";

  return (
    <>
      {noRecord ? (
        <p className="node-meta">지시문과 메모리 목차는 대화마다 항상 읽혀서 사용 횟수를 세지 않아요.</p>
      ) : (
        <div>
          <div className="sec-title">최근 30일 {item.kind === "hook" ? "실행" : item.kind === "memory" ? "읽힘" : "사용"}</div>
          <div className="bars" role="img" aria-label={`최근 30일 동안 모두 ${num(sum)}번, 하루 최대 ${num(max === 1 && sum === 0 ? 0 : max)}번`}>
            {u.daily30.map((n, i) => (
              <i key={i} className={n > 0 ? "on" : ""} style={{ height: `${Math.max(4, Math.round((n / max) * 100))}%` }} />
            ))}
          </div>
          <div className="bars-axis" aria-hidden="true">
            <span>30일 전</span>
            <span>오늘</span>
          </div>
          <p className="node-meta">
            {sum > 0 ? `모두 ${num(sum)}번, 하루 최대 ${num(max)}번이에요.` : "한 달 동안 한 번도 쓰지 않았어요."} 전체 기록으로는 {num(u.countAll)}번이에요.
          </p>
        </div>
      )}

      {showVia && (
        <div>
          <div className="sec-title">어떻게 쓰였나요?</div>
          <div className="split" role="img" aria-label={`직접 불러서 ${viaUser}번, AI가 골라서 ${viaModel}번`}>
            <i className="used" style={{ flex: viaUser }} />
            <i className="idle" style={{ flex: viaModel }} />
          </div>
          <div className="legend">
            <span>
              <i className="dot used" />직접 불러서 {num(viaUser)}번
            </span>
            <span>
              <i className="dot idle" />
              AI가 알아서 골라서 {num(viaModel)}번
            </span>
          </div>
        </div>
      )}

      {h && (
        <div>
          <div className="sec-title">실행 기록</div>
          <dl className="facts">
            <div>
              <dt>실행되는 때</dt>
              <dd>
                {HOOK_EVENT[h.event] ?? h.event} ({h.event}){h.matcher ? `, 대상 ${h.matcher}` : ""}
              </dd>
            </div>
            <div>
              <dt>기록에 남은 실행 (30일)</dt>
              <dd>{num(h.runs30)}번 <span className="meta">Claude Code는 성공한 실행을 다 기록하지 않아 실제로는 더 많을 수 있어요</span></dd>
            </div>
            <div>
              <dt>평균 걸린 시간</dt>
              <dd>{seconds(h.avgMs)}</dd>
            </div>
            <div>
              <dt>가장 오래 걸린 시간</dt>
              <dd>{seconds(h.maxMs)}</dd>
            </div>
            <div>
              <dt>실패한 횟수</dt>
              <dd>{num(h.failures30)}번</dd>
            </div>
            {h.injectedCharsAvg !== undefined && (
              <div>
                <dt>대화에 넣은 글자 수</dt>
                <dd>평균 {num(h.injectedCharsAvg)}자</dd>
              </div>
            )}
            <div>
              <dt>실행 명령</dt>
              <dd className="mono">{h.command}</dd>
            </div>
          </dl>
        </div>
      )}
    </>
  );
}
