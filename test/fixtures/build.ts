// 결함을 심은 가짜 홈을 만든다.
// 정적 부분은 test/fixtures/home, 시간·경로에 따라 달라지는 부분은 여기서 만든다.
// 직접 실행: bun test/fixtures/build.ts <만들 폴더>   (UI 개발 중 서버를 이 홈으로 띄울 때 쓴다)
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const DAY = 86_400_000;

export const mangle = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, "-");

export interface Fixture {
  home: string;
  now: Date;
  projA: string;
}

const lines = (n: number, label: string) => Array.from({ length: n }, (_, i) => `- ${label} entry ${i + 1}: a note that is different on every line`).join("\n") + "\n";

// 대화 기록 한 줄
const L = (o: Record<string, unknown>) => JSON.stringify(o);

export function buildFixtureHome(dest: string, now: Date = new Date()): Fixture {
  const home = resolve(dest);
  mkdirSync(home, { recursive: true });
  cpSync(join(HERE, "home"), home, { recursive: true });
  const claude = join(home, ".claude");
  const projA = join(home, "work", "proj-a");
  const w = (p: string, content: string) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };

  // 설정 파일: 절대경로가 들어가서 여기서 만든다
  const cache = join(claude, "plugins", "cache", "mkt");
  w(
    join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "plugin-a@mkt": [{ scope: "user", installPath: join(cache, "plugin-a", "1.0.0"), version: "1.0.0" }],
        "plugin-unused@mkt": [{ scope: "user", installPath: join(cache, "plugin-unused", "1.0.0"), version: "1.0.0" }],
        "plugin-off@mkt": [{ scope: "user", installPath: join(cache, "plugin-off", "1.0.0"), version: "1.0.0" }],
        "plugin-proj@mkt": [{ scope: "project", installPath: join(cache, "plugin-proj", "1.0.0"), version: "1.0.0", projectPath: projA }],
      },
    }),
  );
  w(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "svc-a": { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer sk-FAKESECRETHEADERVALUE123456" } },
        "svc-env": { command: "node", args: ["x.js", "--token", "ghp_FAKESECRETARGVALUE1234567"], env: { API_TOKEN: "ghp_FAKESECRETENVVALUE123456" } },
      },
      projects: {
        [projA]: { mcpServers: { "proj-svc": { command: "node" } } },
        [join(home, "work", "gone")]: {},
      },
    }),
  );

  // 메모리 폴더
  const proj = (name: string) => join(claude, "projects", name, "memory");
  cpSync(join(HERE, "memory-alpha"), proj("C--fx-alpha"), { recursive: true });
  cpSync(join(HERE, "memory-gamma"), proj("C--fx-gamma"), { recursive: true });
  cpSync(join(HERE, "memory-proj-a"), proj(mangle(projA)), { recursive: true });
  w(join(proj("C--fx-trunc"), "MEMORY.md"), "# trunc\n" + lines(204, "trunc")); // 205줄
  w(join(proj("C--fx-near"), "MEMORY.md"), "# near\n" + lines(184, "near")); // 185줄

  // 20,000자를 넘는 작업 설명서
  w(
    join(claude, "skills", "long-skill", "SKILL.md"),
    `---\nname: long-skill\ndescription: A skill whose body is far too long to read every time.\n---\n\n# Long skill\n\n` + "This sentence is repeated to make the file long. ".repeat(500) + "\n",
  );

  // 대화 기록 (now 기준 상대 시각)
  const ts = (daysAgo: number, extra = 0) => new Date(now.getTime() - daysAgo * DAY - extra).toISOString();
  let seq = 0;
  const tool = (t: string, name: string, input: unknown) =>
    L({ type: "assistant", uuid: `u-${++seq}`, timestamp: t, isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_fixture${seq}`, name, input }] } });
  const prompt = (t: string, text: string, extra: Record<string, unknown> = {}) =>
    L({ type: "user", uuid: `u-${++seq}`, timestamp: t, isSidechain: false, message: { role: "user", content: text }, ...extra });
  const hook = (t: string, event: string, command: string, durationMs: number, exitCode = 0, type = "hook_success", stdout = "") =>
    L({ type: "attachment", timestamp: t, attachment: { type, hookEvent: event, hookName: event, command, durationMs, exitCode, stdout } });

  const convo = [
    prompt(ts(0, 3000), "첫 요청"),
    prompt(ts(1), "둘째 요청"),
    prompt(ts(2), "셋째 요청"),
    prompt(ts(2, 1000), "[Request interrupted by user]"), // 요청으로 세지 않음
    prompt(ts(2, 2000), "메타 메시지", { isMeta: true }), // 요청으로 세지 않음
    L({ type: "user", timestamp: ts(2, 3000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "<command-name>/hello</command-name> 도구 결과 안의 글" }] } }),
    // 직접 부름
    prompt(ts(0, 2000), "<command-message>good-skill</command-message>\n<command-name>/good-skill</command-name>"),
    prompt(ts(3), "<command-name>/hello</command-name>\n<command-message>hello</command-message>"),
    prompt(ts(3, 1000), "<command-name>/plugin-a:run</command-name>"),
    prompt(ts(3, 2000), "<command-message>good-skill</command-message>\n<command-name>/good-skill</command-name>\n<skill-format>true</skill-format>", { isMeta: true }), // 스킬 펼침, 세지 않음
    // AI가 고름 (스킬)
    tool(ts(0, 1000), "Skill", { skill: "good-skill" }),
    tool(ts(1, 1000), "Skill", { skill: "good-skill" }),
    tool(ts(1, 2000), "Skill", { skill: "plugin-a:helper" }),
    tool(ts(1, 3000), "Skill", { skill: "shared-name" }), // 개인 -> 플러그인 순서라 개인 쪽
    tool(ts(45), "Skill", { skill: "unused-one" }), // 30일 밖
    tool(ts(1, 4000), "Skill", { skill: "not-installed" }), // 목록에 없음, 무시
    // 에이전트
    tool(ts(1, 5000), "Agent", { subagent_type: "reviewer", prompt: "x" }),
    tool(ts(1, 6000), "Task", { subagent_type: "Explore", prompt: "x" }),
    tool(ts(1, 7000), "Agent", { subagent_type: "plugin-a:plugin-agent" }),
    tool(ts(1, 8000), "Task", { prompt: "no type" }), // general-purpose
    // 연결된 서비스
    tool(ts(0, 4000), "mcp__svc-a__do", {}),
    tool(ts(0, 5000), "mcp__svc-a__do", {}),
    tool(ts(0, 6000), "mcp__plugin_plugin-a_psvc__x", {}),
    // 파일 읽힘: 짧은 이름(8.3)과 긴 이름 모두 같은 파일
    tool(ts(0, 7000), "Read", { file_path: "C:\\Users\\WISEBI~1\\.claude\\projects\\C--fx-alpha\\memory\\linked.md" }),
    tool(ts(0, 8000), "Read", { file_path: "C:\\Users\\wisebirds\\.claude\\projects\\C--fx-alpha\\memory\\linked.md" }),
    tool(ts(0, 9000), "Read", { file_path: "C:/other/file.md" }), // 대상 아님
    tool(ts(0, 10000), "Bash", { command: "ls" }),
    tool(ts(0, 11000), "Edit", { file_path: "x" }),
  ];
  const rest = [
    // 훅 (복사본에는 넣지 않는다: 훅 실행은 사건 id 가 없어 중복을 걸러내지 않는다)
    hook(ts(0, 12000), "UserPromptSubmit", "bun run C:/fx/hooks/ok-hook.mjs", 100),
    hook(ts(1, 12000), "UserPromptSubmit", "bun run C:/fx/hooks/ok-hook.mjs", 200),
    hook(ts(2, 12000), "UserPromptSubmit", "bun run C:/fx/hooks/ok-hook.mjs", 300),
    hook(ts(45), "UserPromptSubmit", "bun run C:/fx/hooks/ok-hook.mjs", 100, 1, "hook_non_blocking_error"), // 30일 밖 실패
    hook(ts(0, 13000), "Stop", "bun run C:/fx/hooks/slow-hook.mjs", 4000),
    hook(ts(1, 13000), "Stop", "bun run C:/fx/hooks/slow-hook.mjs", 12000),
    hook(ts(0, 14000), "PreToolUse", "bun run C:\\fx\\hooks\\failing-hook.mjs", 50, 1, "hook_non_blocking_error"), // 역슬래시여도 같은 명령
    hook(ts(1, 14000), "PreToolUse", "bun run C:/fx/hooks/failing-hook.mjs", 50),
    hook(ts(0, 15000), "SessionStart", "bun run C:/fx/hooks/start-ok.mjs", 500, 0, "hook_success", JSON.stringify({ hookSpecificOutput: { additionalContext: "x".repeat(120) } })),
    L({ type: "attachment", timestamp: ts(0, 15000), attachment: { type: "hook_additional_context", hookEvent: "SessionStart", content: ["a".repeat(400), "b".repeat(200)] } }),
    L({ type: "attachment", timestamp: ts(1, 15000), attachment: { type: "hook_additional_context", hookEvent: "SessionStart", content: ["c".repeat(200)] } }),
    // 깨진 줄과 timestamp 없는 줄은 무시
    "{ not json at all",
    L({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_nots", name: "Skill", input: { skill: "good-skill" } }] } }),
  ];
  const main = [...convo, ...rest];
  const subagent = [
    tool(ts(0, 20000), "Skill", { skill: "good-skill" }),
    prompt(ts(0, 21000), "하위 에이전트가 받은 지시"), // 요청으로 세지 않음
  ];
  const old = [prompt(ts(60), "오래된 요청"), tool(ts(60, 1000), "Skill", { skill: "good-skill" })];

  const tdir = join(claude, "projects", "C--fx-sessions");
  w(join(tdir, "main-session.jsonl"), main.join("\n") + "\n");
  // 재개된 대화: 앞부분을 그대로 복사해 온 새 파일. 같은 사건이라 두 번 세면 안 된다
  w(join(tdir, "resumed-session.jsonl"), convo.join("\n") + "\n");
  w(join(tdir, "main-session", "subagents", "agent-1.jsonl"), subagent.join("\n") + "\n");
  w(join(tdir, "old-session.jsonl"), old.join("\n") + "\n");

  return { home, now, projA };
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (!dest) {
    console.error("사용법: bun test/fixtures/build.ts <만들 폴더>");
    process.exit(1);
  }
  const f = buildFixtureHome(dest);
  console.log(`가짜 홈을 만들었어요: ${f.home}`);
  console.log(`서버 실행: bun run src/server/main.ts --home ${f.home}`);
}
