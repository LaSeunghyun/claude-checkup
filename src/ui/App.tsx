import { useCallback, useEffect, useMemo, useState } from "react";
import type { Settings } from "../shared/types";
import { getSettings, postViewOpen } from "./api";
import { Header } from "./components/Header";
import { UiContext, type Ui } from "./context";
import { useRoute, useSnapshot, useTheme } from "./hooks";
import { buildModel } from "./model";
import { Consent } from "./screens/Consent";
import { Findings } from "./screens/Findings";
import { Home } from "./screens/Home";
import { ToolsModal } from "./screens/InfoModal";
import { ItemModal } from "./screens/ItemModal";
import { SectionView } from "./screens/SectionView";
import { SettingsModal } from "./screens/SettingsModal";
import { BootState, EmptyState, ErrorState, ScanningState } from "./screens/States";

type Overlay = null | "settings" | "tools";

export default function App() {
  const { theme, toggle } = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const { state, rescan } = useSnapshot();
  const [route, go] = useRoute();
  const [stack, setStack] = useState<string[]>([]); // 항목 모달: 칩으로 이동한 순서
  const [overlay, setOverlay] = useState<Overlay>(null);

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
  }, [viewKey]);
  useEffect(() => {
    if (state.status !== "ready") {
      setStack([]);
      setOverlay(null);
    }
  }, [state.status]);

  // 익명 통계: 어느 화면을 열었는지만 알린다. 보낼지 말지는 서버가 정한다
  const ready = state.status === "ready" && settings !== null;
  useEffect(() => {
    if (!ready) return;
    postViewOpen(route.name === "home" ? "home" : route.name === "section" ? "group" : "findings");
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
          {route.name === "home" && <Home {...common} />}
          {route.name === "section" && <SectionView sectionKey={route.key} mode={route.mode} {...common} />}
          {route.name === "findings" && <Findings severity={route.severity} {...common} />}
          {topItem && <ItemModal id={topItem} canBack={stack.length > 1} onBack={backItem} onClose={closeItem} />}
          {overlay === "tools" && <ToolsModal onClose={() => setOverlay(null)} />}
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
