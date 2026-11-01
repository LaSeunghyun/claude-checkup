// 홈 지도의 노드와 선. 좌표는 지도 안의 도면 좌표(px)이고, 선 굵기는 30일 이용량에서 구한다.
import { a4, num, seconds } from "./format";
import type { Model, SectionKey, ViewMode } from "./model";
import { SECTIONS, contextPart, idleList, usageOf } from "./model";

export type Tone = "ok" | "warn" | "bad" | "idle";
export type MapAction = { type: "section"; key: SectionKey; mode: ViewMode } | { type: "tools" };

export interface MapNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  tag?: { text: string; tone: Tone };
  title: string;
  meta?: string;
  ghost?: boolean;
  pill?: boolean;
  action?: MapAction;
}

export interface MapEdge {
  id: string;
  d: string;
  width: number;
  style: "start" | "busy" | "ref" | "faint";
}

export interface MapSpec {
  width: number;
  height: number;
  nodes: MapNode[];
  labels: { x: number; y: number; text: string }[];
  edges: MapEdge[];
}

// 도면 규격
const NODE_H = 120; // 선이 닿는 기준 높이. 글이 길면 조금 더 커질 수 있다
const PITCH = 152;
const TOP0 = 40;
const START = { x: 24, w: 120, h: 48 };
const LEFT = { x: 176, w: 224 };
const REQ = { x: 432, w: 160, h: 76 };
const COL_C = 640;
const COL_D = 880;
const COL_W = 208;
const WIDTH = 1104;
const LANE_Y = TOP0 + 4 * PITCH + NODE_H + 28; // 메모리 선이 아래로 돌아가는 길
const HEIGHT = LANE_Y + 24;

const top = (row: number) => TOP0 + row * PITCH;
const mid = (row: number) => top(row) + NODE_H / 2;
const MID_Y = mid(2);

/** 이용량 -> 선 굵기. 몇 배씩 차이 나는 값을 한 지도에 그리려고 로그로 줄인다 */
export function lineWidth(volume: number): number {
  return volume <= 0 ? 1.5 : Math.min(8, 1.5 + 1.3 * Math.log10(volume + 1));
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.min(24, (x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

export function buildMap(m: Model): MapSpec {
  const { snap } = m;
  const all = snap.items;
  const enabled = (kinds: string[]) => all.filter((i) => kinds.includes(i.kind) && i.enabled);

  const instr = enabled(["instruction"]);
  const memIdx = all.filter((i) => i.kind === "memory-index");
  const skills = enabled(["skill", "command"]);
  const agents = enabled(["agent"]);
  const hooks = enabled(["hook"]);
  const mcps = enabled(["mcp"]);
  const mems = all.filter((i) => i.kind === "memory");

  const skillUses = skills.reduce((s, i) => s + usageOf(i), 0);
  const agentUses = agents.reduce((s, i) => s + usageOf(i), 0);
  const hookRuns = hooks.reduce((s, i) => s + usageOf(i), 0);
  const tc = snap.stats.toolCalls30;
  const toolTotal = tc.read + tc.bash + tc.other;

  const skillTypes = skills.filter((i) => usageOf(i) > 0).length;
  const agentTypes = agents.filter((i) => usageOf(i) > 0).length;
  const mcpUsed = mcps.filter((i) => usageOf(i) > 0).length;
  const memRead = mems.filter((i) => usageOf(i) > 0).length;
  const idleSkills = idleList(m, "skill").length;

  const instrTokens = contextPart(m, "instruction")?.tokens ?? instr.reduce((s, i) => s + (i.alwaysLoaded?.tokens ?? 0), 0);
  const skillTokens = contextPart(m, "skill")?.tokens ?? 0;
  const agentTokens = contextPart(m, "agent")?.tokens ?? 0;

  const longest = memIdx.reduce((mx, i) => Math.max(mx, i.size.lines), 0);
  const memTag: MapNode["tag"] =
    memIdx.length === 0
      ? undefined
      : longest > 200
        ? { text: "잘려요", tone: "bad" }
        : longest >= 180
          ? { text: "거의 다 참", tone: "warn" }
          : { text: a4(memIdx.reduce((s, i) => s + (i.alwaysLoaded?.tokens ?? 0), 0)), tone: "idle" };

  const failing = hooks.filter((h) => (h.hook?.failures30 ?? 0) > 0).length;
  const slow = hooks.filter((h) => (h.hook?.avgMs ?? 0) >= 3000 || (h.hook?.maxMs ?? 0) >= 10000).length;
  const hookMax = hooks.reduce((mx, h) => Math.max(mx, h.hook?.maxMs ?? 0), 0);
  const hookTag: MapNode["tag"] =
    failing > 0 ? { text: `실패 ${failing}개`, tone: "bad" } : slow > 0 ? { text: "느려요", tone: "warn" } : { text: "정상", tone: "ok" };

  const nodes: MapNode[] = [
    { id: "start", x: START.x, y: MID_Y - START.h / 2, w: START.w, h: START.h, kind: "", title: "대화 시작", pill: true },

    {
      id: "instr", x: LEFT.x, y: top(0), w: LEFT.w, h: NODE_H, kind: "매번 읽어요",
      tag: { text: a4(instrTokens), tone: "idle" },
      title: instr.length ? `CLAUDE.md 지시문 ${instr.length}개` : "CLAUDE.md 지시문 없음",
      meta: instr.length ? "AI에게 늘 지키라고 적어 둔 규칙" : "아직 적어 둔 규칙이 없어요",
      action: { type: "section", key: "instruction", mode: "groups" },
    },
    {
      id: "memidx", x: LEFT.x, y: top(1), w: LEFT.w, h: NODE_H, kind: "매번 읽어요", tag: memTag,
      title: "MEMORY.md 메모리 목차",
      meta: memIdx.length ? `200줄까지 읽혀요. 지금 ${num(longest)}줄` : "메모리 목차가 아직 없어요",
      action: { type: "section", key: "memory-index", mode: "groups" },
    },
    {
      id: "skills", x: LEFT.x, y: top(2), w: LEFT.w, h: NODE_H, kind: "매번 읽어요",
      tag: { text: a4(skillTokens), tone: "idle" },
      title: `작업 설명서 목록 ${num(skills.length)}개`,
      meta: `한 달 동안 ${num(skillTypes)}개 사용`,
      action: { type: "section", key: "skill", mode: "groups" },
    },
    {
      id: "agents", x: LEFT.x, y: top(3), w: LEFT.w, h: NODE_H, kind: "매번 읽어요",
      tag: { text: a4(agentTokens), tone: "idle" },
      title: `에이전트 목록 ${num(agents.length)}개`,
      meta: `한 달 동안 ${num(agentTypes)}개 사용`,
      action: { type: "section", key: "agent", mode: "groups" },
    },
    {
      id: "ghost", x: LEFT.x, y: top(4), w: LEFT.w, h: NODE_H, kind: "목록에만 있어요", ghost: true,
      tag: { text: "한 달 0번", tone: "idle" },
      title: `안 쓰는 작업 설명서 ${num(idleSkills)}개`,
      meta: "목록만 차지하고 있어요",
      action: { type: "section", key: "skill", mode: "idle" },
    },

    {
      id: "req", x: REQ.x, y: MID_Y - REQ.h / 2, w: REQ.w, h: REQ.h, kind: "한 달",
      title: snap.stats.prompts30 > 0 ? `내 요청 ${num(snap.stats.prompts30)}번` : "내 요청 기록 없음",
    },

    {
      id: "skillUse", x: COL_C, y: top(1), w: COL_W, h: NODE_H, kind: "작업 설명서",
      tag: { text: `${num(skillUses)}번`, tone: skillUses > 0 ? "ok" : "idle" },
      title: "작업 설명서 사용", meta: `${num(skillTypes)}종류 사용`,
      action: { type: "section", key: "skill", mode: "usage" },
    },
    {
      id: "agentUse", x: COL_C, y: top(2), w: COL_W, h: NODE_H, kind: "에이전트",
      tag: { text: `${num(agentUses)}번`, tone: agentUses > 0 ? "ok" : "idle" },
      title: "에이전트 사용", meta: `${num(agentTypes)}종류 사용`,
      action: { type: "section", key: "agent", mode: "usage" },
    },
    {
      id: "hooks", x: COL_C, y: top(3), w: COL_W, h: NODE_H, kind: "하네스", tag: hooks.length ? hookTag : undefined,
      title: `자동 실행 규칙 ${num(hooks.length)}개`,
      meta: hookMax > 0 ? `한 번에 최대 ${seconds(hookMax)} 걸려요` : "한 달 동안 실행 기록이 없어요",
      action: { type: "section", key: "hook", mode: "groups" },
    },

    {
      id: "tools", x: COL_D, y: top(1), w: COL_W, h: NODE_H, kind: "도구",
      tag: { text: `${num(toolTotal)}번`, tone: "idle" },
      title: "파일 읽기·명령 실행", meta: `읽기 ${num(tc.read)}번, 명령 ${num(tc.bash)}번`,
      action: { type: "tools" },
    },
    {
      id: "mcp", x: COL_D, y: top(2), w: COL_W, h: NODE_H, kind: "외부 연결",
      tag: { text: `${num(tc.mcp)}번`, tone: "idle" },
      title: "연결된 서비스", meta: `${num(mcps.length)}개 중 ${num(mcpUsed)}개 사용`,
      action: { type: "section", key: "mcp", mode: "groups" },
    },
    {
      id: "memfiles", x: COL_D, y: top(3), w: COL_W, h: NODE_H, kind: "필요할 때 읽어요",
      tag: { text: `${num(memRead)}개 읽음`, tone: "idle" },
      title: "메모리 파일", meta: `${num(mems.length)}개 중 ${num(mems.length - memRead)}개는 안 읽었어요`,
      action: { type: "section", key: "memory", mode: "groups" },
    },
  ];

  const memFilesBottom = top(3) + NODE_H;
  const midD = COL_D + COL_W / 2;
  const edges: MapEdge[] = [
    // 대화 시작 -> 미리 채워지는 묶음
    ...[0, 1, 2, 3, 4].map<MapEdge>((row) => ({
      id: `start-${row}`, d: curve(START.x + START.w, MID_Y, LEFT.x, mid(row)), width: 1.5, style: "start",
    })),
    // 목록·목차를 보고 찾아가는 길 (점선)
    { id: "ref-skills", d: `M${LEFT.x + LEFT.w} ${mid(2) - 24} C430 ${mid(2) - 24} 430 326 520 326 C600 326 600 ${mid(1)} ${COL_C} ${mid(1)}`, width: 1.5, style: "ref" },
    { id: "ref-agents", d: `M${LEFT.x + LEFT.w} ${mid(3)} C430 ${mid(3)} 430 482 520 482 C600 482 600 ${mid(2)} ${COL_C} ${mid(2)}`, width: 1.5, style: "ref" },
    { id: "ref-memory", d: `M${LEFT.x + LEFT.w} ${mid(1)} C424 ${mid(1)} 424 ${LANE_Y} 480 ${LANE_Y} H920 C960 ${LANE_Y} ${midD} ${LANE_Y - 30} ${midD} ${memFilesBottom}`, width: 1.5, style: "ref" },
    // 내 요청 -> AI가 골라 쓴 것 (굵기 = 이용량)
    { id: "req-skill", d: curve(REQ.x + REQ.w, MID_Y, COL_C, mid(1)), width: lineWidth(skillUses), style: skillUses > 0 ? "busy" : "faint" },
    { id: "req-agent", d: `M${REQ.x + REQ.w} ${MID_Y} H${COL_C}`, width: lineWidth(agentUses), style: agentUses > 0 ? "busy" : "faint" },
    { id: "req-hook", d: curve(REQ.x + REQ.w, MID_Y, COL_C, mid(3)), width: lineWidth(hookRuns), style: hookRuns > 0 ? "busy" : "faint" },
    // AI가 한 일
    { id: "skill-tools", d: `M${COL_C + COL_W} ${mid(1)} H${COL_D}`, width: lineWidth(skillUses), style: skillUses > 0 ? "busy" : "faint" },
    { id: "agent-tools", d: curve(COL_C + COL_W, mid(2), COL_D, mid(1)), width: lineWidth(agentUses), style: agentUses > 0 ? "busy" : "faint" },
    { id: "hook-tools", d: curve(COL_C + COL_W, mid(3), COL_D, mid(1) + 24), width: 1.5, style: "ref" },
    { id: "tools-mcp", d: `M${midD} ${top(1) + NODE_H} V${top(2)}`, width: lineWidth(tc.mcp), style: tc.mcp > 0 ? "busy" : "faint" },
  ];

  return {
    width: WIDTH,
    height: HEIGHT,
    nodes,
    labels: [
      { x: LEFT.x, y: 12, text: "대화마다 컨텍스트에 미리 채워져요" },
      { x: COL_C, y: top(1) - 28, text: "AI가 골라 쓴 것" },
      { x: COL_D, y: top(1) - 28, text: "AI가 한 일" },
    ],
    edges,
  };
}

/** 노드가 가리키는 화면 이름 (스크린 리더용 설명에 쓴다) */
export function actionHint(a: MapAction | undefined): string {
  if (!a) return "";
  return a.type === "tools" ? "자세히 보기" : `${SECTIONS[a.key].noun} 펼쳐 보기`;
}
