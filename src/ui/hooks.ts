// 화면 상태 훅: 점검 결과 불러오기, 주소(#) 기반 화면 전환, 테마.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Progress, Severity, Snapshot } from "../shared/types";
import { getProgress, getSnapshot, rescan as apiRescan } from "./api";
import { isSectionKey, type SectionKey, type ViewMode } from "./model";

// ---- 점검 결과 ----

export type SnapState =
  | { status: "loading" }
  | { status: "scanning"; progress: Progress }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "error"; message: string };

const POLL_MS = 700;

export function useSnapshot(): { state: SnapState; rescan: () => void } {
  const [state, setState] = useState<SnapState>({ status: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0); // 오래된 응답이 새 상태를 덮어쓰지 않게 하는 번호
  const kicked = useRef(false);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const load = useCallback(async () => {
    const my = ++gen.current;
    clear();
    const r = await getSnapshot();
    if (my !== gen.current) return;
    if (r.kind === "ok") return setState({ status: "ready", snapshot: r.snapshot });
    if (r.kind === "error") return setState({ status: "error", message: r.message });
    setState({ status: "scanning", progress: r.progress });
    // 서버가 아직 점검을 시작하지 않았으면 한 번 깨운다
    if (r.progress.phase === "idle" && !kicked.current) {
      kicked.current = true;
      await apiRescan().catch(() => undefined);
    }
    poll(my);
  }, []);

  const poll = (my: number) => {
    timer.current = setTimeout(async () => {
      try {
        const p = await getProgress();
        if (my !== gen.current) return;
        if (p.phase === "done") return void load();
        if (p.phase === "error") return setState({ status: "error", message: p.message ?? "점검 중에 문제가 생겼어요." });
        setState({ status: "scanning", progress: p });
      } catch {
        if (my !== gen.current) return;
        return setState({ status: "error", message: "점검 서버에 연결하지 못했어요. 앱이 꺼져 있지 않은지 확인해 주세요." });
      }
      poll(my);
    }, POLL_MS);
  };

  const rescan = useCallback(async () => {
    const my = ++gen.current;
    clear();
    setState({ status: "scanning", progress: { phase: "inventory", filesDone: 0, filesTotal: 0 } });
    try {
      const p = await apiRescan();
      if (my !== gen.current) return;
      setState({ status: "scanning", progress: p });
      poll(my);
    } catch {
      if (my !== gen.current) return;
      setState({ status: "error", message: "다시 점검을 시작하지 못했어요. 앱이 꺼져 있지 않은지 확인해 주세요." });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      gen.current++;
      clear();
    };
  }, [load]);

  return { state, rescan: () => void rescan() };
}

// ---- 화면 전환 (주소의 # 부분) ----

export type SeverityFilter = "all" | Severity;
export type Route =
  | { name: "home" }
  | { name: "section"; key: SectionKey; mode: ViewMode }
  | { name: "findings"; severity: SeverityFilter };

function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const q = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "section" && isSectionKey(parts[1])) {
    const mode = q.get("mode");
    return { name: "section", key: parts[1], mode: mode === "usage" || mode === "idle" ? mode : "groups" };
  }
  if (parts[0] === "findings") {
    const s = q.get("sev");
    return { name: "findings", severity: s === "high" || s === "medium" || s === "low" ? s : "all" };
  }
  return { name: "home" };
}

function routeHash(r: Route): string {
  if (r.name === "section") return `#/section/${r.key}${r.mode === "groups" ? "" : `?mode=${r.mode}`}`;
  if (r.name === "findings") return `#/findings${r.severity === "all" ? "" : `?sev=${r.severity}`}`;
  return "#/";
}

export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route, replace = false) => {
    const h = routeHash(r);
    if (replace) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${h}`);
      setRoute(r);
    } else {
      window.location.hash = h;
    }
  }, []);
  return [route, go];
}

// ---- 테마 ----

export type Theme = "light" | "dark";
const THEME_KEY = "claude-checkup-theme";

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // 저장소를 못 쓰면 시스템 설정을 따른다
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // 저장 실패는 무시한다
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
