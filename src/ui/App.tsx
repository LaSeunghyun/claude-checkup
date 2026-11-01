import { Component, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Finding, Settings } from "../shared/types";
import { getSettings, postViewOpen } from "./api";
import { Header } from "./components/Header";
import { CloseButton, Modal } from "./components/Modal";
import { StepList } from "./components/TodoCard";
import { UiContext, type Ui } from "./context";
import { useRoute, useSnapshot, useTheme } from "./hooks";
import { ChevronLeft } from "./icons";
import { buildModel } from "./model";
import { Checkup } from "./screens/Checkup";
import { Consent } from "./screens/Consent";
import { Findings } from "./screens/Findings";
import { ToolsModal } from "./screens/InfoModal";
import { ItemModal } from "./screens/ItemModal";
import { SectionView } from "./screens/SectionView";
import { SettingsModal } from "./screens/SettingsModal";
import { BootState, CrashState, EmptyState, ErrorState, ScanningState } from "./screens/States";
import { Usage } from "./screens/Usage";

type Overlay = null | "settings" | "tools";

// 임시: 고치기 화면(미리 보기 시트)이 생기기 전까지 "고치기"를 누르면 보여 주는 안내. 시트가 생기면 지운다
function FixSoon({ finding, onClose }: { finding: Finding; onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className="dlg-head">
        <div className="dlg-head-text">
          <h2 id={titleId}>고치기 화면은 곧 열려요</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <p className="dlg-sum">지금은 아래 순서대로 직접 해 주세요.</p>
      <StepList finding={finding} />
    </Modal>
  );
}

// 임시: 연결 지도 화면이 생기기 전까지 자리만 지킨다
function LinksSoon({ onBack }: { onBack: () => void }) {
  return (
    <section className="card" aria-label="연결 지도">
      <h1 className="here">연결 지도는 곧 열려요</h1>
      <p className="sub">md 파일이 서로 어떻게 이어지는지 보여 주는 화면을 준비하고 있어요.</p>
      <div className="acts">
        <button className="btn btn-primary" type="button" onClick={onBack}>
          <ChevronLeft size={20} />
          검진 결과
        </button>
      </div>
    </section>
  );
}

// 화면을 그리다 던져진 오류를 잡아 빈 화면 대신 안내를 보여 준다
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.failed ? <CrashState onReload={() => window.location.reload()} /> : this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  );
}

function Shell() {  const { theme, toggle } = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const { state, rescan } = useSnapshot();
  const [route, go] = useRoute();
  const [stack, setStack] = useState<string[]>([]); // 항목 모달: 칩으로 이동한 순서
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [fixing, setFixing] = useState<Finding | null>(null);

  useEffect(() => {
    // 설정을 못 불러와도 앱은 쓸 수 있어야 한다. 이때는 통계를 끈 것으로 본다
    getSettings().then(setSettings, () => setSettings({ telemetry: "off" }));
  }, []);

  const model = useMemo(() => (state.status === "ready" ? buildModel(state.snapshot) : null), [state]);

  const openItem = useCallback((id: string) => {
    setOverlay(null);
    setStack((s) => (s[s.length - 1] === id ? s : [...s, id]));
  }, []);
  const closeItem = useCallback(() => setStack([]), []);
  const backItem = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const openTools = useCallback(() => setOverlay("tools"), []);

  // 화면이 바뀔 때 맨 위로, 점검을 다시 시작하면 열린 창을 닫는다
  const viewKey = route.name === "section" ? `section:${route.key}` : route.name;
  useEffect(() => {
    window.scrollTo(0, 0);
    // 뒤로 가기 등으로 화면이 바뀌면 열려 있던 창도 닫는다
    setStack([]);
    setOverlay(null);
    setFixing(null);
  }, [viewKey]);
  useEffect(() => {
    if (state.status !== "ready") {
      setStack([]);
      setOverlay(null);
      setFixing(null);
    }
  }, [state.status]);

  // 익명 통계: 어느 화면을 열었는지만 알린다. 보낼지 말지는 서버가 정한다
  const ready = state.status === "ready" && settings !== null;
  useEffect(() => {
    if (!ready) return;
    postViewOpen(route.name === "section" ? "group" : route.name === "findings" ? "findings" : "home");
  }, [ready, viewKey]);
  const topItem = stack[stack.length - 1];
  useEffect(() => {
    if (topItem && ready) postViewOpen("item");
  }, [topItem, ready]);
  useEffect(() => {
    if (overlay === "settings" && settings) postViewOpen("settings");
  }, [overlay, settings !== null]);

  const ui: Ui | null = useMemo(() => (model ? { model, openItem, go, openTools } : null), [model, openItem, go, openTools]);

  if (!settings) {
    return (
      <main className="page">
        <BootState />
      </main>
    );
  }
  if (settings.telemetry === null) {
    return <Consent onDone={setSettings} />;
  }

  const common = { theme, onToggleTheme: toggle, onSettings: () => setOverlay("settings"), onRescan: rescan };

  let body;
  if (state.status === "ready" && ui) {
    const { snapshot } = state;
    body =
      snapshot.items.length === 0 ? (
        <>
          <Header left={<h1 className="top-title">Claude 설정 점검</h1>} theme={theme} onToggleTheme={toggle} onSettings={common.onSettings} />
          <EmptyState onRetry={rescan} />
        </>
      ) : (
        <UiContext.Provider value={ui}>
          {route.name === "home" && <Checkup {...common} onFix={setFixing} />}
          {route.name === "usage" && <Usage {...common} />}
          {route.name === "links" && (
            <>
              <Header left={<h1 className="top-title">연결 지도</h1>} theme={theme} onToggleTheme={toggle} onSettings={common.onSettings} onRescan={rescan} />
              <LinksSoon onBack={() => go({ name: "home" })} />
            </>
          )}
          {route.name === "section" && <SectionView sectionKey={route.key} mode={route.mode} {...common} />}
          {route.name === "findings" && <Findings severity={route.severity} {...common} />}
          {topItem && <ItemModal id={topItem} canBack={stack.length > 1} onBack={backItem} onClose={closeItem} />}
          {overlay === "tools" && <ToolsModal onClose={() => setOverlay(null)} />}
          {fixing && !topItem && <FixSoon finding={fixing} onClose={() => setFixing(null)} />}
        </UiContext.Provider>
      );
  } else {
    body = (
      <>
        <Header left={<h1 className="top-title">Claude 설정 점검</h1>} theme={theme} onToggleTheme={toggle} onSettings={common.onSettings} />
        {state.status === "error" ? (
          <ErrorState message={state.message} onRetry={rescan} />
        ) : state.status === "scanning" ? (
          <ScanningState progress={state.progress} />
        ) : (
          <BootState />
        )}
      </>
    );
  }

  return (
    <main className="page">
      {body}
      {overlay === "settings" && <SettingsModal settings={settings} onChange={setSettings} onClose={() => setOverlay(null)} />}
    </main>
  );
}
