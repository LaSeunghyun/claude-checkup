// 스냅샷 규격. 스캐너(src/scan)가 만들고 화면(src/ui)이 읽는 유일한 계약이다.
// 바꿀 때는 docs/design.md 와 양쪽 코드를 함께 고친다.

export type ItemKind =
  | "instruction" // CLAUDE.md, AGENTS.md
  | "memory-index" // MEMORY.md
  | "memory" // 메모리 파일
  | "skill" // 작업 설명서
  | "command" // 직접 부르는 명령
  | "agent" // 에이전트
  | "hook" // 자동 실행 규칙
  | "mcp" // 연결된 서비스
  | "plugin"; // 플러그인

export type SourceType = "user" | "project" | "plugin" | "builtin" | "history"; // history = 대화 기록에만 있고 지금 파일이 없는 항목

export interface Source {
  type: SourceType;
  plugin?: string; // 플러그인 이름 (@marketplace 접미사 제외)
  project?: string; // 프로젝트 폴더 표시 이름
}

export interface Usage {
  count30: number; // 최근 30일
  countAll: number; // 기록 전체
  lastUsed?: string; // ISO
  daily30: number[]; // 길이 30, 마지막 원소가 오늘
  via?: { user?: number; model?: number }; // 직접 부름 / AI가 고름 (30일)
}

export interface HookInfo {
  event: string; // SessionStart, UserPromptSubmit, PreToolUse ...
  matcher?: string;
  command: string;
  runs30: number;
  avgMs: number;
  maxMs: number;
  failures30: number; // 종료 코드 2(일부러 막음)는 빼고 센다
  blocked30: number; // 종료 코드 2 로 막은 횟수
  injectedCharsAvg?: number; // hook_additional_context 평균 글자 수
}

export interface Item {
  id: string; // `${kind}:${source.type}:${plugin|project|''}:${name}` 소문자
  kind: ItemKind;
  name: string;
  source: Source;
  path?: string; // 표시용, 홈은 ~ 로 줄인다
  summary: string; // frontmatter description 또는 첫 문단, 300자 이내
  outline: string[]; // H2 제목
  size: { chars: number; lines: number; tokens: number };
  alwaysLoaded: { chars: number; tokens: number; what: string } | null; // 대화마다 미리 채워지는 부분
  enabled: boolean;
  modifiedAt?: string;
  usage: Usage;
  hook?: HookInfo;
  links: { out: string[]; in: string[] }; // 다른 Item id
  findings: string[]; // Finding id
}

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string;
  rule: string; // design.md 6절 규칙 이름
  severity: Severity;
  title: string; // 무엇이
  why: string; // 왜 중요한지
  fix: string; // 어떻게 고치나 (규칙 공통 한 문장)
  items: string[]; // 관련 Item id
  evidence: string; // 숫자 근거
  steps: string[]; // 이 진단에 맞춘, 순서대로 할 일
  prompt: string; // Claude Code 에 그대로 붙여 넣을 요청문
  command?: string; // 터미널에서 실행할 명령 (있을 때만)
}

export interface Group {
  id: string;
  kind: ItemKind;
  title: string; // 예: "nestads-product-review", "개인", "기본 제공"
  source: Source;
  items: string[];
}

export interface ContextPart {
  key: "instructions" | "memory-index" | "skills" | "agents" | "hooks";
  label: string;
  tokens: number;
  unusedTokens: number; // 30일 0회 항목 몫
}

export interface Snapshot {
  version: 1;
  generatedAt: string;
  home: string; // 표시용 (~)
  window: { from: string; to: string; days: 30 };
  stats: {
    sessions30: number;
    prompts30: number;
    toolCalls30: { read: number; bash: number; mcp: number; other: number };
    transcriptsScanned: number;
    bytesScanned: number;
    durationMs: number;
  };
  context: {
    budgetTokens: 200000;
    totalTokens: number;
    unusedTokens: number;
    parts: ContextPart[];
  };
  items: Item[];
  groups: Group[];
  findings: Finding[];
  warnings: string[]; // 읽기 실패 등, 사용자에게 보일 말
}

export interface Progress {
  phase: "idle" | "inventory" | "transcripts" | "diagnose" | "done" | "error";
  filesDone: number;
  filesTotal: number;
  message?: string;
}

export interface Settings {
  telemetry: "on" | "off" | null; // null = 아직 묻지 않음
  installId?: string; // telemetry=on 일 때만 있다
}

// 익명 통계 한 건. design.md 8-1절 밖의 필드를 넣지 않는다.
export interface TelemetryEvent {
  installId: string;
  appVersion: string;
  os: "windows" | "macos" | "linux" | "other";
  event: "launch" | "scan_done" | "view_open";
  view?: "home" | "group" | "item" | "findings" | "settings";
  scanSeconds?: "0-9" | "10-59" | "60-299" | "300+";
  itemCount?: "0-49" | "50-99" | "100-199" | "200-499" | "500+";
}

// 서버 API
// GET  /api/snapshot           -> Snapshot | { error: string }  (스캔 전이면 404 + Progress)
// POST /api/rescan             -> Progress
// GET  /api/progress           -> Progress
// GET  /api/item-body?id=      -> { id: string; body: string } (비밀 파일은 403)
// GET  /api/settings           -> Settings
// POST /api/settings           -> Settings   body: { telemetry: "on" | "off" }
// POST /api/reveal            -> 204          body: { id }  그 항목 파일을 탐색기에서 연다
// GET  /api/telemetry-preview  -> TelemetryEvent (보낼 내용 그대로)
// POST /api/telemetry          -> 204          body: { event, view? }  서버가 나머지 필드를 채워 보낸다
