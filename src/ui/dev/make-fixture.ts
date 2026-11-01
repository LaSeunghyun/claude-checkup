// 개발용 가짜 점검 결과를 만든다: bun run src/ui/dev/make-fixture.ts
// 실제 ~/.claude 는 읽지 않는다. 같은 입력이면 항상 같은 결과가 나오게 난수는 고정 씨앗을 쓴다.
import type { Finding, Group, Item, ItemKind, Snapshot, Source } from "../../shared/types";
import { categoryOf, type RuleId } from "../../scan/findings";
import { zeroLeaks } from "../../scan/graph";
import { summaryOf } from "../../scan";

// ---- 고정 난수 ----
let seed = 20261101;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rint = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

// 설계서 5절의 토큰 추정식
function tokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of s) ch.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4 + other / 1.5);
}
const tokensOfChars = (chars: number) => Math.ceil(chars / 2.4);

const NOW = new Date("2026-11-01T15:20:00+09:00");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

// ---- 항목 만들기 ----
const items: Item[] = [];
const byId = new Map<string, Item>();

const USER: Source = { type: "user" };
const BUILTIN: Source = { type: "builtin" };
const plugin = (p: string): Source => ({ type: "plugin", plugin: p });
const project = (p: string): Source => ({ type: "project", project: p });

function makeId(kind: ItemKind, s: Source, name: string): string {
  return `${kind}:${s.type}:${s.plugin ?? s.project ?? ""}:${name}`.toLowerCase();
}

function daily(count: number): number[] {
  const d = new Array<number>(30).fill(0);
  if (count <= 0) return d;
  const hot = Math.max(3, Math.min(14, Math.ceil(count / 2)));
  const days = Array.from({ length: hot }, () => rint(2, 29));
  for (let i = 0; i < count; i++) d[days[i % days.length]!]!++;
  return d;
}

interface Spec {
  kind: ItemKind;
  name: string;
  source: Source;
  summary: string;
  count30?: number;
  via?: [number, number]; // 직접, AI
  chars?: number;
  lines?: number;
  outline?: string[];
  enabled?: boolean;
  path?: string;
  alwaysWhat?: string;
  alwaysChars?: number;
}

function add(spec: Spec): Item {
  const enabled = spec.enabled ?? true;
  const count30 = enabled ? (spec.count30 ?? 0) : 0;
  const chars = spec.chars ?? rint(900, 5200);
  const lines = spec.lines ?? Math.max(8, Math.round(chars / 42));
  const listLine = `- ${spec.name}: ${spec.summary}`;
  let always: Item["alwaysLoaded"] = null;
  if (enabled) {
    if (spec.kind === "skill" || spec.kind === "command" || spec.kind === "agent") {
      // 실제 설명은 이 예시보다 길어서(영문 200~300자) 한 줄에 글자와 토큰을 더 얹는다
      always = { chars: listLine.length + 180, tokens: tokens(listLine) + 55, what: "목록 한 줄(이름과 설명)" };
    } else if (spec.alwaysChars) {
      always = { chars: spec.alwaysChars, tokens: tokensOfChars(spec.alwaysChars), what: spec.alwaysWhat ?? "파일 전체" };
    }
  }
  const item: Item = {
    id: makeId(spec.kind, spec.source, spec.name),
    kind: spec.kind,
    name: spec.name,
    source: spec.source,
    path: spec.path,
    summary: spec.summary,
    outline: spec.outline ?? [],
    size: { chars, lines, tokens: tokensOfChars(chars) },
    alwaysLoaded: always,
    enabled,
    modifiedAt: iso(rint(1, 120)),
    usage: {
      count30,
      countAll: count30 > 0 ? count30 + rint(0, count30 * 6) : rint(0, 3) === 0 ? rint(1, 4) : 0,
      lastUsed: count30 > 0 ? iso(rint(0, 6)) : undefined,
      daily30: daily(count30),
      via: spec.via ? { user: spec.via[0], model: spec.via[1] } : undefined,
    },
    links: { out: [], in: [] },
    findings: [],
  };
  items.push(item);
  byId.set(item.id, item);
  return item;
}

const idOf = (kind: ItemKind, s: Source, name: string) => makeId(kind, s, name);
function link(from: string, to: string) {
  const a = byId.get(from);
  const b = byId.get(to);
  if (!a || !b) throw new Error(`연결 대상이 없어요: ${from} -> ${to}`);
  if (!a.links.out.includes(to)) a.links.out.push(to);
  if (!b.links.in.includes(from)) b.links.in.push(from);
}

type Row = [name: string, desc: string, count30: number, via?: [number, number]];
function bulk(kind: ItemKind, source: Source, rows: Row[], enabled = true, pathBase?: string) {
  for (const [name, summary, count30, via] of rows) {
    add({
      kind, name, source, summary, count30, via, enabled,
      path: pathBase ? `${pathBase}/${name}${kind === "skill" ? "/SKILL.md" : ".md"}` : undefined,
      outline: kind === "skill" ? ["언제 쓰나요", "진행 순서", "결과 형식", "주의할 점"] : kind === "agent" ? ["역할", "쓸 수 있는 도구", "출력 형식"] : [],
    });
  }
}

// ================= 지시문 =================
add({
  kind: "instruction", name: "CLAUDE.md", source: USER, path: "~/.claude/CLAUDE.md",
  summary: "모든 작업에 적용하는 개인 지시문. 응답 원칙, 프로젝트 컨텍스트, 위임 규칙이 들어 있어요.",
  chars: 11840, lines: 214, alwaysChars: 11840,
  outline: ["응답 원칙", "프롬프트 층 소유 규칙", "프로젝트 컨텍스트", "코드 작성 규칙", "업무 지식 캐시", "검증과 지시 함정", "에이전트 위임"],
});
add({
  kind: "instruction", name: "CLAUDE.md", source: project("nestads-frontend"), path: "C:/lash/nestads-frontend/CLAUDE.md",
  summary: "프론트엔드 레포의 작업 규칙. 스택, 폴더 구조, 컴포넌트 재사용 원칙을 적어 뒀어요.",
  chars: 4620, lines: 98, alwaysChars: 4620, outline: ["스택", "폴더 구조", "컴포넌트 규칙", "테스트"],
});
add({
  kind: "instruction", name: "AGENTS.md", source: project("claude-checkup"), path: "C:/lash/claude-checkup/AGENTS.md",
  summary: "Hearth 디자인 가이드. 색과 간격은 토큰만 쓰고, 글자 크기와 터치 영역 하한을 지켜요.",
  chars: 2310, lines: 54, alwaysChars: 2310, outline: ["디자인 규칙", "금지 목록"],
});

// ================= 메모리 =================
const MEM_ROOT = "~/.claude/projects/C--lash/memory";
const memRows: [string, string, number][] = [
  ["user_profile", "역할, 기술 스택, 도메인 전문성, 언어 선호", 9],
  ["feedback_preferences", "영어 혼입 금지, 스킬 생성 금지 같은 개인 선호", 6],
  ["feedback_collaboration_handoff", "Claude와 사용자 작업 구분, 대화형 스텝 처리", 3],
  ["feedback_rework_causes", "되돌리기를 만든 원인 14종과 방지 규칙", 4],
  ["feedback_wiki_width", "Confluence 위키는 항상 페이지 폭 wide로", 1],
  ["feedback_code_analysis_speed", "코드 동작 질문은 레포 최신화 후 SDK 3종 병렬 조회", 2],
  ["feedback_stock_data_routing", "종목 질문은 Supabase에서 오늘자 데이터를 먼저 본다", 0],
  ["feedback_explain_before_agree", "의문이 제기되면 근거를 먼저 설명하고 동의한다", 5],
  ["project_work_kb", "Jira, Confluence, Slack 로컬 캐시 구조와 갱신 절차", 12],
  ["project_actc_studio", "단일 TC 관리 시스템 착수 기록", 2],
  ["project_iphone_duo_policy", "iPhone Duo 화면 대응 정책 논의안", 0],
  ["project_wp11011_delivery_priority", "매체 광고 유형별 송출 우선순위 결정 4건", 1],
  ["project_krxdata_workflow", "주식 점수 산정 워크플로우와 공시 조회법", 0],
  ["project_krxdata_validation_method", "백테스트 판정 전 필수 검증 6단", 0],
  ["reference_sdk_code_index", "SDK 동작 질문 시 먼저 볼 코드 색인", 7],
  ["reference_nestads_feature_doc_index", "기능별 문서 위키 목록", 2],
  ["reference_token_rotation", "토큰 교체 절차 메모", 0],
  ["reference_mcp_windows_path", "stdio MCP 가 Windows 경로에서 끊길 때 대처", 1],
];
for (const [name, summary, c] of memRows) {
  add({
    kind: "memory", name, source: project("lash"), path: `${MEM_ROOT}/${name}.md`, summary, count30: c,
    chars: rint(600, 3800), outline: name.startsWith("feedback") ? ["규칙", "이유", "적용 시점"] : ["개요", "현재 상태", "다음 단계"],
  });
}
for (const [name, summary, c] of [
  ["feedback_component_reuse", "DS 컴포넌트 재사용을 먼저 확인한다", 3],
  ["project_admin_list_fit", "어드민 목록 화면 폭 맞춤 규칙", 0],
  ["reference_playwright_setup", "테스트 환경 준비 절차", 0],
] as [string, string, number][]) {
  add({
    kind: "memory", name, source: project("nestads-frontend"), path: `~/.claude/projects/C--lash-nestads-frontend/memory/${name}.md`,
    summary, count30: c, chars: rint(500, 2400), outline: ["개요", "규칙"],
  });
}
add({
  kind: "memory-index", name: "MEMORY.md", source: project("lash"), path: `${MEM_ROOT}/MEMORY.md`,
  summary: "메모리 파일 목차. 한 줄에 파일 하나와 한 줄 설명이 있어요.",
  chars: 41200, lines: 214, alwaysChars: 24000, alwaysWhat: "앞 200줄 (201줄부터는 읽히지 않아요)",
  outline: ["항상 참조", "나머지 개인 메모리", "진행 중인 기획", "개인 PC 트러블슈팅"],
});
add({
  kind: "memory-index", name: "MEMORY.md", source: project("nestads-frontend"), path: "~/.claude/projects/C--lash-nestads-frontend/memory/MEMORY.md",
  summary: "프론트엔드 레포 메모리 목차.",
  chars: 9800, lines: 186, alwaysChars: 9800, alwaysWhat: "파일 전체 (186줄)", outline: ["규칙", "참고"],
});

// ================= 개인 작업 설명서·명령·에이전트 =================
const SK = "~/.claude/skills";
bulk("skill", USER, [
  ["my-design", "Hearth 디자인 시스템으로 화면과 제안서 장표를 만들고 고치고 판정해요", 6, [6, 0]],
  ["compound", "하네스를 실사용 기록을 근거로 개선해요", 2, [2, 0]],
  ["nestads-update", "NestAds 레포 6개를 한 번에 최신으로 맞춰요", 4, [3, 1]],
  ["work-kb-qa", "NestAds의 단일 사실과 현재 상태 질문에 원문 근거로 답해요", 12, [1, 11]],
  ["deep-research", "복잡한 주제를 나눠 웹에서 찾고 교차 검증해 보고서로 정리해요", 0],
  ["new-service-advisor", "신규 서비스 아이디어를 시장, 경쟁, 팀 구성까지 분석해요", 0],
], true, SK);
bulk("command", USER, [
  ["harness-trace", "하네스 훅이 언제 무엇을 넣었는지 한눈에 보여 줘요", 3, [3, 0]],
  ["weekly-digest", "지난주 작업 기록을 정리해요", 0],
], true, "~/.claude/commands");
add({ kind: "agent", name: "code-reviewer", source: USER, path: "~/.claude/agents/code-reviewer.md", summary: "큰 작업이 끝나면 별도 관점으로 코드를 검토해요", count30: 5, outline: ["역할", "점검 항목"] });
add({ kind: "agent", name: "db-migrator", source: USER, path: "~/.claude/agents/db-migrator.md", summary: "", count30: 0, outline: ["역할"] });

// ================= 기본 제공 에이전트 =================
bulk("agent", BUILTIN, [
  ["general-purpose", "여러 단계 조사나 검색을 맡아요", 31, [4, 27]],
  ["Explore", "파일을 넓게 훑어 위치만 찾아요", 18, [0, 18]],
  ["Plan", "구현 계획을 세워요", 4, [0, 4]],
  ["statusline-setup", "상태 표시줄 설정을 바꿔요", 0],
  ["claude-code-guide", "Claude Code 사용법 질문에 답해요", 0],
]);

// ================= 플러그인 =================
interface Plug { name: string; blurb: string; enabled?: boolean }
const plugins: Plug[] = [
  { name: "nestads-product-review", blurb: "기획서를 다섯 가지 관점으로 검토해요" },
  { name: "nestads-product", blurb: "NestAds 정책서와 AC 검토 도구" },
  { name: "nestads-frontend-pipeline", blurb: "프론트엔드 개발 파이프라인" },
  { name: "nestads-frontend", blurb: "어드민 화면 테스트 도구" },
  { name: "nestads-backend-pipeline", blurb: "백엔드 개발 파이프라인" },
  { name: "vercel", blurb: "Vercel 배포와 성능 도구" },
  { name: "superpowers", blurb: "계획, 디버깅, 검증 작업 습관" },
  { name: "commit-commands", blurb: "커밋과 PR 만들기 명령" },
  { name: "code-review", blurb: "PR 코드 리뷰" },
  { name: "atlassian", blurb: "Jira와 Confluence 연결" },
  { name: "slack", blurb: "Slack 검색과 메시지 도구" },
  { name: "figma", blurb: "Figma 읽기와 쓰기 도구" },
  { name: "frontend-design", blurb: "화면 디자인 길잡이" },
  { name: "supabase", blurb: "Supabase 데이터베이스 도구", enabled: false },
];
const PL = "~/.claude/plugins/cache";

bulk("skill", plugin("nestads-product-review"), [
  ["plan-review", "기획서를 다섯 가지 관점(정책, 읽기 쉬움, 개발 규칙, 실제로 만들 수 있는지, 자주 빠뜨리는 것)으로 나눠 검토하고 결과를 하나로 합쳐요", 14, [9, 5]],
  ["plan-diff", "기획서 두 판의 달라진 점을 정리해요", 2, [2, 0]],
  ["kb-harvest", "개발 리뷰 질문을 모아 누락 패턴 지식으로 정리해요", 3, [3, 0]],
  ["review-feedback", "리뷰 지적 중 오탐을 패턴으로 쌓아요", 1, [1, 0]],
], true, `${PL}/nestads-product-review`);
bulk("agent", plugin("nestads-product-review"), [
  ["plan-lens-policy", "정책 문서와 비교해 기획서의 충돌과 누락을 찾아요", 14],
  ["plan-lens-readability", "기획서 문장이 읽기 쉬운지 점검해요", 14],
  ["plan-lens-dev-policy", "개발 쪽에 이미 있는 규칙을 기획서가 고려했는지 봐요", 14],
  ["plan-lens-impl-fitness", "실제 시스템 기준으로 만들 수 있는 기획인지 봐요", 11],
  ["plan-lens-kb", "과거 리뷰에서 반복된 누락이 이번에도 있는지 봐요", 14],
], true, `${PL}/nestads-product-review/agents`);
bulk("skill", plugin("nestads-product"), [
  ["nestads-policy", "NestAds 정책서에서 현행 규칙을 찾아 답해요", 6, [1, 5]],
  ["nestads-product-ac-review", "AC와 TC 문장이 읽기 쉬운지 검토해요", 2, [2, 0]],
], true, `${PL}/nestads-product`);

const FRONT_SKILLS: Row[] = [
  ["api-integration", "백엔드 API를 화면 코드에 연결해요", 0], ["branch-from-ticket", "Jira 티켓에서 브랜치 이름을 만들어요", 0],
  ["code-review", "변경 사항을 검토하고 통과 여부를 판정해요", 0], ["code-writer", "계획서대로 화면 코드를 써요", 0],
  ["component-audit", "공통 컴포넌트 재사용 여부를 점검해요", 0], ["conventions", "프론트엔드 코드 규칙을 알려줘요", 0],
  ["coverage-report", "테스트 커버리지 보고서를 만들어요", 0], ["create-pull-request", "PR 설명을 쓰고 올려요", 0],
  ["e2e-test-gen", "브라우저 테스트를 만들어요", 0], ["epic-frontend-splitter", "에픽을 프론트 작업 단위로 나눠요", 0],
  ["feature-planner", "기능 구현 계획을 세워요", 0], ["figma-jira-prd", "Figma와 Jira로 요구사항 문서를 만들어요", 0],
  ["quick-fix", "작은 버그를 빠르게 고쳐요", 0], ["refactor", "동작은 그대로 두고 구조를 정리해요", 0],
];
bulk("skill", plugin("nestads-frontend-pipeline"), FRONT_SKILLS, true, `${PL}/nestads-frontend-pipeline`);
bulk("agent", plugin("nestads-frontend-pipeline"), [
  ["architect", "요구사항을 분석해 화면 설계를 해요", 0], ["code-reviewer", "PR 올리기 전에 코드 리뷰를 해요", 0],
  ["executor", "설계대로 코드를 작성해요", 0], ["vitest-test-engineer", "단위 테스트를 써요", 0],
  ["playwright-test-generator", "브라우저 테스트를 만들어요", 0], ["playwright-test-healer", "깨진 브라우저 테스트를 고쳐요", 0],
  ["playwright-test-planner", "브라우저 테스트 계획을 세워요", 0],
], true, `${PL}/nestads-frontend-pipeline/agents`);
bulk("agent", plugin("nestads-frontend"), [
  ["nestads-admin-playwright-test-generator", "어드민 화면 테스트를 만들어요", 0],
  ["nestads-admin-playwright-test-healer", "어드민 화면 테스트를 고쳐요", 0],
  ["nestads-admin-playwright-test-planner", "어드민 화면 테스트 계획을 세워요", 0],
], true, `${PL}/nestads-frontend/agents`);
bulk("skill", plugin("nestads-frontend"), [
  ["analyze-legacy", "예전 화면 코드를 읽고 구조를 설명해요", 0], ["design-to-code", "Figma 화면을 코드로 옮겨요", 0],
], true, `${PL}/nestads-frontend`);

bulk("skill", plugin("nestads-backend-pipeline"), [
  ["plan", "Jira 에픽과 Figma를 분석해 구현 계획을 써요", 2, [2, 0]], ["implement", "계획을 구현 설계서로 풀어요", 0],
  ["code-writer", "설계서대로 구현하고 테스트를 통과시켜요", 0], ["pr-description", "PR 설명을 써요", 0],
  ["reverse-merge", "운영 브랜치 변경을 개발 브랜치로 되돌려 합쳐요", 0], ["test-writer", "백엔드 테스트를 써요", 0],
], true, `${PL}/nestads-backend-pipeline`);
bulk("agent", plugin("nestads-backend-pipeline"), [
  ["plan-agent", "Jira 에픽과 Figma를 분석해 계획을 써요", 2], ["implement-agent", "기존 코드를 훑어 구현 설계를 써요", 0],
  ["code-writer-agent", "테스트를 통과할 때까지 구현해요", 0],
], true, `${PL}/nestads-backend-pipeline/agents`);

const VERCEL_SKILLS = ["bootstrap", "deploy", "env", "status", "ai-gateway", "ai-sdk", "auth", "nextjs", "shadcn", "turbopack", "workflow", "vercel-cli", "vercel-functions", "verification"];
bulk("skill", plugin("vercel"), VERCEL_SKILLS.map<Row>((n) => [n, `Vercel ${n} 관련 작업을 안내해요`, 0]), true, `${PL}/vercel`);
bulk("agent", plugin("vercel"), [
  ["ai-architect", "AI 앱 구조를 설계해요", 0], ["deployment-expert", "배포 문제를 풀어요", 0], ["performance-optimizer", "느린 화면을 개선해요", 0],
], true, `${PL}/vercel/agents`);
// 아주 긴 작업 설명서 한 개 (long-skill 진단용)
const longVercel = byId.get(idOf("skill", plugin("vercel"), "nextjs"))!;
longVercel.size = { chars: 38400, lines: 912, tokens: tokensOfChars(38400) };

bulk("skill", plugin("superpowers"), [
  ["brainstorming", "새 기능을 만들기 전에 요구를 같이 정리해요", 5, [1, 4]], ["writing-plans", "여러 단계 작업의 계획을 써요", 2, [0, 2]],
  ["systematic-debugging", "원인을 찾은 뒤에 고치도록 순서를 잡아요", 1, [0, 1]], ["test-driven-development", "테스트를 먼저 쓰고 구현해요", 0],
  ["verification-before-completion", "끝났다고 말하기 전에 직접 확인해요", 4, [0, 4]], ["requesting-code-review", "작업이 끝나면 검토를 요청해요", 1, [0, 1]],
  ["using-superpowers", "작업 시작 때 쓸 수 있는 도구를 먼저 살펴요", 8, [0, 8]], ["executing-plans", "쓴 계획을 단계별로 실행해요", 0],
  ["dispatching-parallel-agents", "독립된 일을 에이전트에게 나눠 맡겨요", 0], ["finishing-a-development-branch", "개발 브랜치를 정리하고 마무리해요", 0],
], true, `${PL}/superpowers`);
bulk("command", plugin("commit-commands"), [
  ["commit", "변경 사항을 커밋해요", 7, [7, 0]], ["commit-push-pr", "커밋하고 올린 뒤 PR까지 열어요", 3, [3, 0]], ["clean_gone", "원격에서 사라진 브랜치를 정리해요", 0],
], true, `${PL}/commit-commands/commands`);
bulk("skill", plugin("code-review"), [["code-review", "PR 코드를 검토해요", 2, [2, 0]]], true, `${PL}/code-review`);
bulk("skill", plugin("atlassian"), [
  ["search-company-knowledge", "회사 문서에서 답을 찾아요", 3, [0, 3]], ["triage-issue", "이슈를 분류하고 담당을 정해요", 0],
  ["generate-status-report", "진행 보고서를 만들어요", 0], ["spec-to-backlog", "명세서를 백로그 티켓으로 쪼개요", 0],
  ["capture-tasks-from-meeting-notes", "회의록에서 할 일을 뽑아요", 0],
], true, `${PL}/atlassian`);
bulk("skill", plugin("slack"), ["channel-digest", "draft-announcement", "find-discussions", "standup", "summarize-channel", "block-kit", "slack-api", "slack-search"].map<Row>((n) => [n, `Slack ${n} 작업을 도와요`, 0]), true, `${PL}/slack`);
bulk("skill", plugin("figma"), [
  ["figma-use", "Figma 파일에 직접 쓰기 전에 지켜야 할 규칙을 알려줘요", 9, [0, 9]], ["figma-generate-design", "화면 코드를 Figma 화면으로 옮겨요", 4, [2, 2]],
  ["figma-design-to-code", "Figma 화면을 코드로 옮겨요", 0], ["figma-code-connect", "Figma 컴포넌트와 코드를 이어요", 0],
  ["figma-create-new-file", "새 Figma 파일을 만들어요", 0], ["figma-generate-library", "디자인 시스템 라이브러리를 만들어요", 0],
], true, `${PL}/figma`);
bulk("skill", plugin("frontend-design"), [["frontend-design", "화면 디자인을 처음부터 잡을 때 방향을 정해 줘요", 2, [0, 2]]], true, `${PL}/frontend-design`);
bulk("skill", plugin("supabase"), [["supabase", "Supabase 작업을 안내해요", 0], ["supabase-postgres-best-practices", "Postgres 작성 모범 사례", 0]], false, `${PL}/supabase`);

// 플러그인 항목 (플러그인 단위 요약)
for (const p of plugins) {
  const children = items.filter((i) => i.source.type === "plugin" && i.source.plugin === p.name && i.kind !== "plugin");
  const item = add({
    kind: "plugin", name: p.name, source: plugin(p.name), summary: `${p.blurb}. 작업 설명서·에이전트·명령 ${children.length}개를 가져와요.`,
    enabled: p.enabled ?? true, chars: 600, lines: 20, path: `${PL}/${p.name}/.claude-plugin/plugin.json`, outline: ["들어 있는 것"],
  });
  item.usage.count30 = children.reduce((s, c) => s + c.usage.count30, 0);
  item.usage.daily30 = daily(item.usage.count30);
  for (const c of children) link(item.id, c.id);
}

// ================= 연결된 서비스 =================
const MCPS: [string, Source, number, string][] = [
  ["atlassian", plugin("atlassian"), 142, "Jira와 Confluence 읽기, 쓰기"],
  ["figma", plugin("figma"), 86, "Figma 파일 읽기, 쓰기"],
  ["wkb", USER, 204, "업무 지식 캐시 검색"],
  ["nestads-admin", USER, 77, "NestAds 어드민 조회"],
  ["playwright", USER, 31, "브라우저 조작"],
  ["nestads-kibana", USER, 12, "Kibana 로그 조회"],
  ["slack", plugin("slack"), 0, "Slack 검색과 메시지"],
  ["telegram", USER, 0, "텔레그램 메시지"],
  ["notebooklm-mcp", plugin("nestads-frontend"), 0, "NotebookLM 노트북 조회"],
  ["supabase", plugin("supabase"), 0, "Supabase 데이터베이스"],
];
for (const [name, source, c, summary] of MCPS) {
  add({ kind: "mcp", name, source, summary, count30: c, enabled: source.plugin !== "supabase", chars: 240, lines: 8, outline: [] });
}
byId.get(idOf("mcp", USER, "telegram"))!.summary = "텔레그램 메시지 (연결이 자주 끊겨요)";

// ================= 자동 실행 규칙 =================
interface H { event: string; matcher?: string; script: string; source: Source; runs: number; avg: number; max: number; fail: number; inject?: number; }
const HOOKS: H[] = [
  { event: "SessionStart", script: "session-start.mjs", source: USER, runs: 212, avg: 1800, max: 4100, fail: 0, inject: 3200 },
  { event: "UserPromptSubmit", script: "trigger-inject.mjs", source: USER, runs: 1240, avg: 3400, max: 9800, fail: 0, inject: 900 },
  { event: "PreToolUse", matcher: "Bash|Write|Edit", script: "wkb-first.mjs", source: USER, runs: 3880, avg: 410, max: 2200, fail: 6 },
  { event: "PostToolUse", matcher: "Write|Edit", script: "design-gate.mjs", source: USER, runs: 640, avg: 780, max: 3100, fail: 0 },
  { event: "Stop", script: "compound-detector.mjs", source: USER, runs: 480, avg: 300, max: 900, fail: 0, inject: 220 },
  { event: "SessionStart", script: "session-start-seen-skills.mjs", source: plugin("vercel"), runs: 0, avg: 0, max: 0, fail: 0 },
];
for (const h of HOOKS) {
  const name = `${h.event}: ${h.script}`;
  const it = add({
    kind: "hook", name, source: h.source, count30: h.runs, chars: 180, lines: 4,
    summary: `${h.event} 때 ${h.script}를 실행해요`, outline: [],
    alwaysChars: h.event === "SessionStart" ? h.inject : undefined, alwaysWhat: "대화 시작 때 넣는 글(평균)",
  });
  it.hook = {
    event: h.event, matcher: h.matcher, command: `bun run ~/.claude/harness/hooks/${h.script}`,
    runs30: h.runs, avgMs: h.avg, maxMs: h.max, failures30: h.fail, blocked30: 0, injectedCharsAvg: h.inject,
  };
  it.usage.count30 = h.runs;
  it.usage.daily30 = daily(h.runs);
}

// ================= 연결 =================
const pr = idOf("skill", plugin("nestads-product-review"), "plan-review");
for (const a of ["plan-lens-policy", "plan-lens-readability", "plan-lens-dev-policy", "plan-lens-impl-fitness", "plan-lens-kb"]) {
  link(pr, idOf("agent", plugin("nestads-product-review"), a));
}
link(pr, idOf("memory", project("lash"), "project_work_kb"));
link(idOf("skill", plugin("nestads-product-review"), "kb-harvest"), idOf("memory", project("lash"), "project_work_kb"));
link(idOf("skill", plugin("nestads-backend-pipeline"), "plan"), idOf("agent", plugin("nestads-backend-pipeline"), "plan-agent"));
link(idOf("skill", USER, "work-kb-qa"), idOf("mcp", USER, "wkb"));
link(idOf("skill", plugin("atlassian"), "search-company-knowledge"), idOf("mcp", plugin("atlassian"), "atlassian"));
link(idOf("skill", plugin("figma"), "figma-use"), idOf("mcp", plugin("figma"), "figma"));
link(idOf("instruction", USER, "CLAUDE.md"), idOf("skill", USER, "work-kb-qa"));
link(idOf("instruction", USER, "CLAUDE.md"), idOf("agent", USER, "code-reviewer"));
link(idOf("instruction", USER, "CLAUDE.md"), idOf("memory", project("lash"), "feedback_preferences"));
const MI = idOf("memory-index", project("lash"), "MEMORY.md");
for (const [name] of memRows) {
  if (name === "reference_token_rotation" || name === "project_krxdata_validation_method") continue; // 목차에 없는 파일 (unreachable-md 진단용)
  link(MI, idOf("memory", project("lash"), name));
}
link(idOf("memory", project("lash"), "feedback_rework_causes"), idOf("memory", project("lash"), "feedback_explain_before_agree"));
const MI2 = idOf("memory-index", project("nestads-frontend"), "MEMORY.md");
for (const n of ["feedback_component_reuse", "project_admin_list_fit", "reference_playwright_setup"]) link(MI2, idOf("memory", project("nestads-frontend"), n));

// ================= 진단 =================
const findings: Finding[] = [];
const F = (f: Omit<Finding, "id" | "rule" | "category" | "fixKind" | "steps" | "prompt"> & { rule: RuleId } & Partial<Pick<Finding, "category" | "fixKind" | "steps" | "prompt">> & { key: string }) => {
  const { key, ...rest } = f;
  // 가짜 데이터의 할 일은 규칙 공통 문장으로 채운다. 분류는 스캐너 규칙 표, 고치는 방법은 manual 로 둔다 (화면 개발용)
  findings.push({ id: `f-${key}`, category: categoryOf(rest.rule), fixKind: "manual", steps: [rest.fix], prompt: `${rest.title}. ${rest.fix}`, ...rest });
};
const fid = (kind: ItemKind, s: Source, name: string) => idOf(kind, s, name);

F({
  key: "memidx-truncated", rule: "memory-index-truncated", severity: "high",
  title: "MEMORY.md가 길어서 201줄부터는 AI가 읽지 못해요",
  why: "Claude Code는 메모리 목차의 앞 200줄만 읽어요. 그 뒤에 적은 메모리는 목차에 있어도 AI가 존재를 알지 못해서, 필요할 때 찾아 읽지 못할 수 있어요.",
  fix: "오래된 항목을 지우거나, 한 줄 설명을 더 짧게 줄여 보세요. 자주 안 쓰는 메모리는 목차에서 빼고 파일만 남겨 두면 줄 수가 줄어요.",
  items: [MI], evidence: "지금 214줄이에요. 14줄(약 6퍼센트)이 읽히지 않아요.",
});
F({
  key: "failing-hook", rule: "failing-hook", severity: "high",
  title: "자동 실행 규칙 하나가 한 달 동안 6번 실패했어요",
  why: "실패한 규칙은 AI에게 넣으려던 안내나 막으려던 동작이 빠졌다는 뜻일 수 있어요. 실패가 이어져도 화면에는 크게 드러나지 않을 수 있어요.",
  fix: "아래 규칙을 직접 한 번 실행해서 오류 메시지를 확인해 보세요. 경로가 바뀌었거나 프로그램이 설치돼 있지 않은 경우가 많아요.",
  items: [fid("hook", USER, "PreToolUse: wkb-first.mjs")], evidence: "3,880번 중 6번 실패 (종료 코드가 0이 아니었어요).",
});
F({
  key: "unused-plugin-front", rule: "unused-plugin", severity: "medium",
  title: "nestads-frontend-pipeline 플러그인을 한 달 동안 하나도 안 썼어요",
  why: "켜 둔 플러그인은 안에 든 작업 설명서와 에이전트 목록이 대화마다 컨텍스트에 미리 채워져요. 안 쓰는데 켜져 있으면 자리만 차지해요.",
  fix: "당분간 안 쓴다면 플러그인을 꺼 두세요. 필요할 때 다시 켜면 돼요.",
  items: items.filter((i) => i.source.plugin === "nestads-frontend-pipeline" && i.kind !== "plugin").map((i) => i.id),
  evidence: "작업 설명서 14개와 에이전트 7개, 합쳐서 21개를 한 번도 안 불렀어요. 목록이 대화마다 A4 약 1쪽을 차지해요.",
});
F({
  key: "unused-plugin-vercel", rule: "unused-plugin", severity: "medium",
  title: "vercel 플러그인을 한 달 동안 하나도 안 썼어요",
  why: "켜 둔 플러그인의 목록이 대화마다 컨텍스트에 미리 채워져요.",
  fix: "Vercel을 안 쓰는 PC라면 플러그인을 꺼 두세요.",
  items: items.filter((i) => i.source.plugin === "vercel" && i.kind !== "plugin").map((i) => i.id),
  evidence: "작업 설명서 14개와 에이전트 3개, 자동 실행 규칙 1개를 한 번도 안 불렀어요.",
});
F({
  key: "unused-plugin-slack", rule: "unused-plugin", severity: "medium",
  title: "slack 플러그인을 한 달 동안 하나도 안 썼어요",
  why: "켜 둔 플러그인의 목록이 대화마다 컨텍스트에 미리 채워져요.",
  fix: "Slack 연결이 필요 없다면 플러그인을 꺼 두세요.",
  items: [...items.filter((i) => i.source.plugin === "slack" && i.kind !== "plugin").map((i) => i.id)],
  evidence: "작업 설명서 8개와 연결된 서비스 1개를 한 번도 안 썼어요.",
});
F({
  key: "slow-hook", rule: "slow-hook", severity: "medium",
  title: "요청을 보낼 때마다 도는 자동 실행 규칙이 느려요",
  why: "이 규칙은 내가 요청을 보낼 때마다 끝날 때까지 기다려요. 평균 3초가 넘으면 요청할 때마다 답이 늦어지는 것처럼 느껴질 수 있어요.",
  fix: "규칙 안에서 하는 일을 줄이거나, 결과를 저장해 두고 다시 쓰도록 바꿔 보세요.",
  items: [fid("hook", USER, "UserPromptSubmit: trigger-inject.mjs")], evidence: "평균 3.4초, 가장 오래 걸린 때는 9.8초였어요 (1,240번 실행).",
});
F({
  key: "dup-rule", rule: "duplicate-rule", severity: "medium",
  title: "같은 규칙이 지시문과 메모리에 두 번 적혀 있어요",
  why: "같은 규칙이 여러 곳에 있으면 한쪽만 고쳤을 때 서로 달라져서 AI가 헷갈릴 수 있어요. 글자 수도 두 번 차지해요.",
  fix: "한 곳에만 남기고, 다른 곳에는 그 위치를 가리키는 한 줄만 두세요.",
  items: [fid("instruction", USER, "CLAUDE.md"), fid("memory", project("lash"), "feedback_preferences")],
  evidence: "정규화한 같은 줄 4개가 2곳에서 발견됐어요 (각 25자 이상).",
});
F({
  key: "broken-link", rule: "broken-link", severity: "medium",
  title: "MEMORY.md가 가리키는 파일 2개가 없어요",
  why: "목차에는 있는데 파일이 없으면 AI가 읽으려다 실패하거나, 이미 없는 내용을 있다고 믿을 수 있어요.",
  fix: "없어진 파일의 줄을 목차에서 지우거나, 파일을 다시 만들어 주세요.",
  items: [MI], evidence: "project_haru_life_sim.md, reference_figma_pat.md 를 찾지 못했어요.",
});
F({
  key: "missing-desc", rule: "missing-description", severity: "medium",
  title: "db-migrator 에이전트에 설명이 없어요",
  why: "AI는 설명을 보고 어떤 에이전트를 부를지 골라요. 설명이 없으면 이 에이전트는 사실상 한 번도 선택되지 않아요.",
  fix: "파일 맨 위의 description 에 언제 쓰는 에이전트인지 한 문장으로 적어 주세요.",
  items: [fid("agent", USER, "db-migrator")], evidence: "description 이 비어 있어요.",
});
F({
  key: "dup-name", rule: "duplicate-name", severity: "medium",
  title: "code-review 작업 설명서가 두 곳에 켜져 있어요",
  why: "이름이 같으면 어느 쪽이 실행될지 헷갈리고, 목록에도 두 번 올라가요.",
  fix: "쓰지 않는 쪽 플러그인을 끄거나 이름을 바꿔 주세요.",
  items: [fid("skill", plugin("code-review"), "code-review"), fid("skill", plugin("nestads-frontend-pipeline"), "code-review")],
  evidence: "code-review 플러그인과 nestads-frontend-pipeline 플러그인에 같은 이름이 있어요.",
});
F({
  key: "unused-items", rule: "unused-items", severity: "low",
  title: "superpowers 플러그인에서 한 달 동안 안 쓴 작업 설명서 4개",
  why: "안 쓰는 작업 설명서도 목록 한 줄씩은 대화마다 읽혀요.",
  fix: "자주 안 쓰는 것은 플러그인 설정에서 빼 보세요. 꼭 지울 필요는 없어요.",
  items: items.filter((i) => i.source.plugin === "superpowers" && i.kind === "skill" && i.usage.count30 === 0).map((i) => i.id),
  evidence: "10개 중 4개가 한 달 동안 0번이에요.",
});
F({
  key: "unused-items-backend", rule: "unused-items", severity: "low",
  title: "nestads-backend-pipeline에서 한 달 동안 안 쓴 것 7개",
  why: "안 쓰는 항목도 목록 한 줄씩은 대화마다 읽혀요.",
  fix: "백엔드 작업이 드물다면 필요할 때만 플러그인을 켜 두세요.",
  items: items.filter((i) => i.source.plugin === "nestads-backend-pipeline" && i.kind !== "plugin" && i.usage.count30 === 0).map((i) => i.id),
  evidence: "9개 중 7개가 한 달 동안 0번이에요.",
});
F({
  key: "long-skill", rule: "long-skill", severity: "low",
  title: "vercel의 nextjs 작업 설명서 본문이 아주 길어요",
  why: "작업 설명서를 부를 때마다 본문 전체를 읽어요. 길수록 더 오래 걸리고 컨텍스트도 많이 차지해요.",
  fix: "자주 쓰는 부분만 본문에 두고, 나머지는 따로 파일로 떼어 필요할 때만 읽게 해 보세요.",
  items: [fid("skill", plugin("vercel"), "nextjs")], evidence: "본문 38,400자 (A4 약 11쪽).",
});
F({
  key: "near-limit", rule: "memory-index-near-limit", severity: "low",
  title: "프론트엔드 MEMORY.md가 200줄에 가까워요",
  why: "200줄을 넘으면 그 뒤는 AI가 읽지 못해요. 새 메모리가 늘면 곧 넘을 수 있어요.",
  fix: "오래된 메모리를 정리하거나 한 줄 설명을 줄여 두세요.",
  items: [MI2], evidence: "지금 186줄이에요 (한도 200줄).",
});
F({
  key: "orphan", rule: "unreachable-md", severity: "medium",
  title: "AI가 찾아갈 길이 없는 메모리 파일 2개",
  why: "목차에도 없고 다른 메모리에서도 연결되지 않으면 AI가 이 파일이 있는 줄 모를 수 있어요.",
  fix: "목차에 한 줄로 추가하거나, 필요 없다면 파일을 정리해 주세요.",
  items: [fid("memory", project("lash"), "reference_token_rotation"), fid("memory", project("lash"), "project_krxdata_validation_method")],
  evidence: "MEMORY.md와 다른 메모리 어디에도 연결이 없어요.",
});
F({
  key: "similar", rule: "similar-description", severity: "low",
  title: "figma-design-to-code와 figma-generate-design 설명이 비슷해요",
  why: "설명이 비슷하면 AI가 어느 쪽을 골라야 할지 헷갈려요.",
  fix: "각각 언제 쓰는지 서로 다른 단어로 구분해서 적어 주세요.",
  items: [fid("skill", plugin("figma"), "figma-design-to-code"), fid("skill", plugin("figma"), "figma-generate-design")],
  evidence: "설명에 쓴 단어 중 62퍼센트가 같아요.",
});

for (const f of findings) {
  for (const id of f.items) {
    const it = byId.get(id);
    if (!it) throw new Error(`진단이 없는 항목을 가리켜요: ${f.id} -> ${id}`);
    it.findings.push(f.id);
  }
}

// ================= 묶음 =================
const groups: Group[] = [];
const gmap = new Map<string, Group>();
for (const it of items) {
  if (it.kind === "plugin") continue;
  const title = it.source.type === "plugin" ? it.source.plugin! : it.source.type === "user" ? "개인" : it.source.type === "builtin" ? "기본 제공" : it.source.project!;
  const k = `${it.kind}|${it.source.type}|${title}`;
  let g = gmap.get(k);
  if (!g) {
    g = { id: `g:${k}`.toLowerCase(), kind: it.kind, title, source: it.source, items: [] };
    gmap.set(k, g);
    groups.push(g);
  }
  g.items.push(it.id);
}

// ================= 컨텍스트 =================
const sum = (xs: Item[], f: (i: Item) => number) => xs.reduce((s, i) => s + f(i), 0);
const loaded = (kinds: ItemKind[], extra?: (i: Item) => boolean) =>
  items.filter((i) => kinds.includes(i.kind) && i.enabled && i.alwaysLoaded && (!extra || extra(i)));
const part = (key: "instructions" | "memory-index" | "skills" | "agents" | "hooks", label: string, kinds: ItemKind[], extra?: (i: Item) => boolean) => {
  const list = loaded(kinds, extra);
  const t = sum(list, (i) => i.alwaysLoaded!.tokens);
  const unused = key === "instructions" || key === "memory-index" ? 0 : sum(list.filter((i) => i.usage.count30 === 0), (i) => i.alwaysLoaded!.tokens);
  return { key, label, tokens: t, unusedTokens: unused };
};
const parts = [
  part("instructions", "지시문(CLAUDE.md)", ["instruction"]),
  part("memory-index", "메모리 목차(MEMORY.md)", ["memory-index"]),
  part("skills", "작업 설명서·명령 목록", ["skill", "command"]),
  part("agents", "에이전트 목록", ["agent"]),
  part("hooks", "자동 실행 규칙이 넣는 글", ["hook"]),
];

const leaks = zeroLeaks(); // 연결 지도 화면 작업(Task 9)에서 값을 채운다
const mcpCalls = sum(items.filter((i) => i.kind === "mcp"), (i) => i.usage.count30);
const context: Snapshot["context"] = {
  budgetTokens: 200000,
  totalTokens: parts.reduce((n, p) => n + p.tokens, 0),
  unusedTokens: parts.reduce((n, p) => n + p.unusedTokens, 0),
  parts,
};
const snapshot: Snapshot = {
  version: 1,
  generatedAt: NOW.toISOString(),
  home: "~",
  window: { from: iso(29), to: NOW.toISOString(), days: 30 },
  stats: {
    sessions30: 112,
    prompts30: 1240,
    toolCalls30: { read: 3120, bash: 2410, mcp: mcpCalls, other: 880 },
    transcriptsScanned: 412,
    bytesScanned: 612_000_000,
    durationMs: 18420,
  },
  context,
  items,
  groups,
  findings,
  graph: { entries: [], nodes: [], edges: [] }, // Task 3 이후 채운다
  leaks,
  summary: summaryOf({ generatedAt: NOW.toISOString(), context, findings, leaks }),
  warnings: ["C:/lash/old-project 폴더가 없어서 그 프로젝트의 지시문은 건너뛰었어요."],
};

const out = new URL("./fixture-snapshot.json", import.meta.url);
await Bun.write(out, JSON.stringify(snapshot, null, 1) + "\n");
console.log(
  `fixture: items ${items.length}, groups ${groups.length}, findings ${findings.length}, ` +
    `context ${snapshot.context.totalTokens} tokens (unused ${snapshot.context.unusedTokens})`,
);
