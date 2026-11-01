// 화면 표기용 문구와 숫자 포맷. 용어 규칙은 docs/design.md 3절.
import type { Category, Item, ItemKind, Severity, Source } from "../shared/types";

// 토큰 1,500개 = A4 1쪽 (추정). 화면에는 항상 "약"을 붙인다.
const TOKENS_PER_PAGE = 1500;

/** "A4 약 25쪽" / "A4 1쪽 미만" / "0쪽" */
export function a4(tokens: number): string {
  if (tokens <= 0) return "0쪽";
  const n = Math.round(tokens / TOKENS_PER_PAGE);
  return n < 1 ? "A4 1쪽 미만" : `A4 약 ${n}쪽`;
}

/** "약 25쪽" (A4 접두어 없이, 문장 안에서) */
export function pages(tokens: number): string {
  if (tokens <= 0) return "0쪽";
  const n = Math.round(tokens / TOKENS_PER_PAGE);
  return n < 1 ? "1쪽 미만" : `약 ${n}쪽`;
}

export function num(n: number): string {
  return n.toLocaleString("ko-KR");
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

export function seconds(ms: number): string {
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)}초`;
}

export function dateText(iso: string | undefined): string {
  if (!iso) return "기록 없음";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "기록 없음";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function dateTimeText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${m}`;
}

export function periodText(w: { from: string; to: string }): string {
  return `${dateText(w.from)} ~ ${dateText(w.to)}`;
}

/** 긴 글을 문장 중간에서 자르지 않고 줄임표로 끝낸다 (CSS 잘림 대신 글자 수로) */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}...`;
}

// 용어: 바꿔 쓰는 말과 원래 이름
export const KIND_LABEL: Record<ItemKind, string> = {
  instruction: "지시문",
  "memory-index": "메모리 목차",
  memory: "메모리",
  skill: "작업 설명서",
  command: "직접 부르는 명령",
  agent: "에이전트",
  hook: "자동 실행 규칙",
  mcp: "연결된 서비스",
  plugin: "플러그인",
};

export const KIND_ORIGIN: Record<ItemKind, string> = {
  instruction: "지시문 파일(CLAUDE.md, AGENTS.md)",
  "memory-index": "MEMORY.md",
  memory: "메모리 파일(memory)",
  skill: "스킬(Skill)",
  command: "슬래시 명령(Slash command)",
  agent: "에이전트(Agent)",
  hook: "훅(Hook)",
  mcp: "MCP 서버(MCP server)",
  plugin: "플러그인(Plugin)",
};

export const SEVERITY_LABEL: Record<Severity, string> = { high: "높음", medium: "중간", low: "낮음" };
export const SEVERITY_BADGE: Record<Severity, string> = {
  high: "badge-danger",
  medium: "badge-warning",
  low: "badge-info",
};
export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** 출처 한 줄 설명 */
export function sourceText(s: Source): string {
  switch (s.type) {
    case "plugin":
      return s.plugin ? `${s.plugin} 플러그인에서 왔어요` : "플러그인에서 왔어요";
    case "project":
      return s.project ? `${s.project} 프로젝트에 있어요` : "프로젝트에 있어요";
    case "builtin":
      return "Claude Code에 처음부터 들어 있어요";
    case "history":
      return "대화 기록에만 있고 지금 파일은 없어요";
    default:
      return "내가 직접 만든 것이에요";
  }
}

/** 묶음 카드 부제 */
export function sourceNote(s: Source): string {
  switch (s.type) {
    case "plugin":
      return "플러그인으로 설치했어요";
    case "project":
      return s.project ? `프로젝트 ${s.project}` : "프로젝트 안에 있어요";
    case "builtin":
      return "Claude Code에 처음부터 들어 있어요";
    case "history":
      return "기본 내장이거나, 지웠거나, 이름이 바뀐 항목이에요";
    default:
      return "내가 직접 만든 것이에요";
  }
}

export function sourceKey(s: Source): string {
  return `${s.type}:${s.plugin ?? s.project ?? ""}`;
}

export function itemSourceName(item: Item): string {
  const s = item.source;
  if (s.type === "plugin") return s.plugin ?? "플러그인";
  if (s.type === "project") return s.project ?? "프로젝트";
  if (s.type === "builtin") return "기본 제공";
  if (s.type === "history") return "기록에만 있음";
  return "개인";
}

// 훅 실행 시점 이름
export const HOOK_EVENT: Record<string, string> = {
  SessionStart: "대화를 시작할 때",
  UserPromptSubmit: "내가 요청을 보낼 때",
  PreToolUse: "AI가 도구를 쓰기 전",
  PostToolUse: "AI가 도구를 쓴 뒤",
  Stop: "AI가 답을 마칠 때",
  SubagentStop: "에이전트가 일을 마칠 때",
  Notification: "알림이 뜰 때",
  PreCompact: "대화를 줄이기 전",
  SessionEnd: "대화를 끝낼 때",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  risk: "위험",
  broken: "고장",
  leak: "연결 누수",
  waste: "낭비",
  confusion: "헷갈림",
};
