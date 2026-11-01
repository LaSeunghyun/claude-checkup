import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scan";
import { isSecretName, readText } from "../src/scan/fsutil";
import { redactCommand } from "../src/scan/inventory";
import { isSectionKey } from "../src/ui/model";
import { memoryLinks, parseFrontmatter, estimateTokens, summarize } from "../src/scan/text";
import type { Finding, Item, Snapshot } from "../src/shared/types";
import { buildFixtureHome, buildMiniHome, hookLine, type Fixture } from "./fixtures/build";

let dir: string;
let fx: Fixture;
let snap: Snapshot;
let progress: string[] = [];

const find = (id: string): Item => {
  const it = snap.items.find((i) => i.id === id);
  if (!it) throw new Error(`항목 없음: ${id}\n${snap.items.map((i) => i.id).join("\n")}`);
  return it;
};
const rule = (r: string): Finding[] => snap.findings.filter((f) => f.rule === r);
const findingsOf = (id: string): Finding[] => snap.findings.filter((f) => f.items.includes(id));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cc-fixture-"));
  const now = new Date();
  now.setHours(12, 0, 0, 0); // 자정 근처에서 날짜가 갈리지 않게
  fx = buildFixtureHome(dir, now);
  snap = await scan(fx.home, { now: fx.now, cache: false, onProgress: (p) => progress.push(p.phase) });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("텍스트 도구", () => {
  test("frontmatter 는 한 줄, 따옴표, 블록 값을 읽는다", () => {
    const fm = parseFrontmatter('---\nname: a\ndescription: >\n  첫 줄\n  둘째 줄\ntitle: "따옴표 값"\n---\n본문\n');
    expect(fm.data.name).toBe("a");
    expect(fm.data.description).toBe("첫 줄 둘째 줄");
    expect(fm.data.title).toBe("따옴표 값");
    expect(fm.body).toBe("본문\n");
  });
  test("요약은 description, 없으면 첫 문단, 300자 이내", () => {
    expect(summarize("설명", "# 제목\n본문")).toBe("설명");
    expect(summarize(undefined, "# 제목\n\n첫 문단 한 줄\n둘째 줄\n\n다음 문단")).toBe("첫 문단 한 줄 둘째 줄");
    expect(Array.from(summarize("가".repeat(500), "")).length).toBe(300);
  });
  test("토큰 추정은 ASCII/4 + 비ASCII/1.5 올림", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("가나다")).toBe(2);
    expect(estimateTokens("abcd가나")).toBe(Math.ceil(1 + 2 / 1.5));
  });
  test("메모리 링크는 코드 안과 외부 주소를 건너뛴다", () => {
    const t = "[a](x.md) [b](https://e.com/y.md) [[wiki]] `[c](z.md)` [d](#anchor)\n```\n[e](w.md)\n```";
    expect(memoryLinks(t)).toEqual({ md: ["x.md"], wiki: ["wiki"] });
  });
});

describe("비밀 파일 보호", () => {
  test("이름 규칙", () => {
    for (const n of [".credentials.json", "atlassian_token.txt", "figma_pat.txt", "my.env", "k.pem", "a.key", "secret.md", "oauth.md"]) expect(isSecretName(n)).toBe(true);
    for (const n of ["SKILL.md", "MEMORY.md", "patterns.md", "settings.json", ".claude.json"]) expect(isSecretName(n)).toBe(false);
  });
  test("readText 는 비밀 이름 파일을 열지 않는다", () => {
    expect(readText(join(fx.home, ".claude", ".credentials.json"))).toBeNull();
    expect(readText(join(fx.home, ".claude", "atlassian_token.txt"))).toBeNull();
    expect(readText(join(fx.home, ".claude", "settings.json"))).not.toBeNull();
  });
  test("스냅샷에 가짜 비밀값이 한 글자도 없다", () => {
    const json = JSON.stringify(snap);
    for (const s of ["FAKESECRET", "FAKECREDENTIAL", "FAKETOKEN", "FAKEFAKE", "SHOULDNOTLEAK", "example.invalid"]) expect(json).not.toContain(s);
    expect(json.match(/sk-[A-Za-z0-9]|ghp_|xox[bp]-|ATATT|figd_|eyJ[A-Za-z0-9_-]{20,}/g) ?? []).toHaveLength(0);
  });
  test("이름 때문에 열지 않은 메모리 파일도 항목으로는 보인다", () => {
    const it = find("memory:project:fx-alpha:secret-token-notes.md");
    expect(it.summary).toContain("읽지 않았어요");
    expect(it.size.chars).toBe(0);
  });
  test("훅 명령 속 비밀 인자는 가린다", () => {
    const h = snap.items.find((i) => i.hook?.command.includes("unrun-hook"));
    expect(h?.hook?.command).toContain("***");
  });
});

describe("보안 보강: 훅 명령 가리기, 막음, 중복", () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const at = (ms = 0) => new Date(now.getTime() - 60_000 - ms).toISOString();
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`; // 줄 uuid
  // 임시 홈 하나를 만들고 점검한 뒤 지운다
  async function inMini<T>(commands: string[], transcripts: Record<string, string[]>, then: (s: Snapshot, home: string) => T | Promise<T>): Promise<T> {
    const d = mkdtempSync(join(tmpdir(), "cc-mini-"));
    try {
      const home = buildMiniHome(d, commands, transcripts);
      return await then(await scan(home, { now, cache: false }), home);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
  const hookOf = (s: Snapshot, needle: string) => s.items.find((i) => i.hook?.command.includes(needle))!.hook!;

  test("훅 이름과 id 에 토큰이 없다", async () => {
    const cmds = [
      "npx -y notifier --token=ghp_ABCDEFGHIJKLMNOPQRS",
      "curl https://api.telegram.org/bot123456:ABCdefGHIjklMNOpqr/sendMessage",
      "curl -u user:pass https://h",
      'curl -H "Authorization: Basic dXNlcjpwYXNz" https://h',
      'curl -H "Authorization: token abc123def456" https://h', // Basic/Bearer 가 아닌 방식: 이름 앞 40자에 값이 들어가는 길이
      'curl -H "Authorization: Bot MTIzNDU2Nzg5.Gx7aBc" https://h',
    ];
    const rows = cmds.map((c, i) => hookLine(at(i * 1000), "Stop", c, 10, 0, "hook_success", "", uid(100 + i)));
    await inMini(cmds, { s1: rows }, (s) => {
      const json = JSON.stringify(s);
      const bads = ["ghp_", "ABCdefGHI", "user:pass", "dXNlcjpwYXNz", "abc123def456", "MTIzNDU2Nzg5"];
      for (const bad of bads) expect(json).not.toContain(bad);
      const hooks = s.items.filter((i) => i.hook);
      expect(hooks).toHaveLength(6);
      for (const h of hooks) {
        expect(h.hook!.runs30).toBe(1); // 가려도 대화 기록과는 원문으로 이어진다
        for (const bad of bads) expect(`${h.name} ${h.id}`).not.toContain(bad); // 이름과 id 에도 없다
      }
    });
  });

  test("redactCommand: 모양별로 가리고, 멀쩡한 명령은 그대로 둔다", () => {
    const secret: [string, string][] = [
      ["tool --token=ghp_ABCDEFGHIJKLMNOPQRS", "ghp_"],
      ["tool --token abcdef123", "abcdef123"],
      ["tool --key=abcdef123", "abcdef123"],
      ["tool --key abcdef123", "abcdef123"],
      ["curl https://user:hunter2@host.example/x", "hunter2"],
      ["curl https://api.telegram.org/bot123456:ABCdefGHIjklMNOpqr/sendMessage", "ABCdefGHI"],
      ["curl -X POST https://hooks.slack.com/services/T00000000/B00000000/abcdEFGHijklMNOPqrst", "T00000000"],
      ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://h', "dXNlcjpwYXNz"],
      ["curl -H 'Authorization: Bearer abc.def.ghi' https://h", "abc.def.ghi"],
      ['curl -H "Authorization: token abc123def456" https://h', "abc123def456"],
      ['curl -H "Authorization: Bot MTIzNDU2Nzg5.Gx7aBc" https://h', "MTIzNDU2Nzg5"],
      ["curl -H 'authorization:ApiKey k-12345' https://h", "k-12345"], // 방식 이름이 무엇이든, 콜론 뒤 공백이 없어도
      ['curl -H "Proxy-Authorization: Negotiate YIIabc123" https://h', "YIIabc123"],
      ["curl -u user:pass https://h", "user:pass"],
      ["curl --user user:pass https://h", "user:pass"],
      ["run " + "a1B2c3D4".repeat(4), "a1B2c3D4a1B2c3D4"], // 32자 영숫자 덩어리
    ];
    for (const [cmd, leak] of secret) {
      const out = redactCommand(cmd);
      expect(out).not.toContain(leak);
      expect(out).toContain("***");
    }
    // 음성 대조: 비밀이 아닌 것은 바뀌지 않는다
    for (const ok of [
      "bun run C:/fx/hooks/ok-hook.mjs",
      "git push -u origin main",
      "git clone ssh://git@github.com/o/r.git",
      "curl https://example.com/api/v1/items",
      "run " + "a1B2c3D4".repeat(4).slice(0, 31), // 31자는 덩어리로 보지 않는다
    ]) expect(redactCommand(ok)).toBe(ok);
  });

  test("종료 코드 2는 막음", async () => {
    const guard = "bun run C:/fx/hooks/guard-hook.mjs";
    const bad = "bun run C:/fx/hooks/bad-hook.mjs";
    const rows = [
      ...[0, 1, 2].map((i) => hookLine(at(i * 1000), "Stop", guard, 20, 2, "hook_blocking_error", "", uid(200 + i))),
      hookLine(at(9000), "Stop", bad, 20, 1, "hook_non_blocking_error", "", uid(300)), // 대조: 진짜 실패는 여전히 잡힌다
    ];
    await inMini([guard, bad], { s1: rows }, (s) => {
      expect(hookOf(s, "guard-hook")).toMatchObject({ runs30: 3, failures30: 0, blocked30: 3 });
      expect(hookOf(s, "bad-hook")).toMatchObject({ runs30: 1, failures30: 1, blocked30: 0 });
      const failing = s.findings.filter((f) => f.rule === "failing-hook");
      expect(failing).toHaveLength(1);
      expect(failing[0].items[0]).toContain("bad-hook");
    });
  });

  test("재개 복사본의 훅 기록은 한 번만", async () => {
    const cmd = "bun run C:/fx/hooks/dup-hook.mjs";
    const ok = hookLine(at(6000), "Stop", cmd, 10, 0, "hook_success", "", uid(401));
    const fail = hookLine(at(5000), "Stop", cmd, 30, 1, "hook_non_blocking_error", "", uid(402));
    await inMini([cmd], { a: [ok, fail], b: [ok, fail], c: [fail] }, (s) => {
      expect(hookOf(s, "dup-hook")).toMatchObject({ runs30: 2, failures30: 1 }); // 같은 uuid 줄은 세 파일에 있어도 한 번
    });
    // 대조: uuid 가 다른 두 줄은 따로 센다
    const fail2 = hookLine(at(4000), "Stop", cmd, 30, 1, "hook_non_blocking_error", "", uid(403));
    await inMini([cmd], { a: [fail], b: [fail2] }, (s) => expect(hookOf(s, "dup-hook").failures30).toBe(2));
  });

  test("있는데 JSON 으로 못 읽은 설정 파일은 안내에 나온다", async () => {
    await inMini(["bun run C:/fx/hooks/x-hook.mjs"], {}, async (s0, home) => {
      expect(s0.warnings.join("\n")).not.toContain(".claude.json"); // 대조: 파일이 없으면 안내하지 않는다
      writeFileSync(join(home, ".claude.json"), "{ broken");
      const s = await scan(home, { now, cache: false });
      expect(s.warnings.join("\n")).toContain("~/.claude.json");
    });
  });
});

describe("화면 모델", () => {
  test("isSectionKey 는 자기 이름만 받고 상속 이름(constructor)은 거른다", () => {
    for (const k of ["instruction", "skill", "hook", "mcp"]) expect(isSectionKey(k)).toBe(true);
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "", null, undefined]) expect(isSectionKey(k as string | null | undefined)).toBe(false);
  });
});

describe("목록 만들기", () => {
  test("진행 단계가 순서대로 나온다", () => {
    expect(progress[0]).toBe("inventory");
    expect(progress).toContain("transcripts");
    expect(progress.at(-1)).toBe("done");
  });
  test("개인 스킬·명령·에이전트와 기본 제공 에이전트", () => {
    expect(snap.items.filter((i) => i.kind === "skill" && i.source.type === "user")).toHaveLength(7);
    expect(find("command:user::hello").summary).toBe("Say hello to the user in a friendly way.");
    expect(find("agent:user::reviewer").enabled).toBe(true);
    expect(snap.items.filter((i) => i.source.type === "builtin" && i.kind === "agent").map((i) => i.name).sort()).toEqual(["Explore", "Plan", "claude-code-guide", "general-purpose", "statusline-setup"]);
  });
  test("기록에만 있는 작업 설명서는 기록에만 있음 항목으로 만들고, 없는 플러그인 이름은 만들지 않는다", () => {
    const b = find("skill:history::not-installed");
    expect(b.usage.count30).toBe(1);
    expect(b.alwaysLoaded).toBeNull();
    expect(snap.items.some((i) => i.name.includes("gone-plugin") || i.name === "old" || i.name === "old-gone")).toBe(false);
    expect(snap.findings.flatMap((f) => f.items)).not.toContain(b.id);
  });
  test("frontmatter 의 description 이 요약이고 H2 가 개요다", () => {
    const g = find("skill:user::good-skill");
    expect(g.summary).toBe("Review pull requests and summarize risky changes for the reviewer.");
    expect(g.outline).toEqual(["사용 시점", "절차"]);
    expect(g.id).toBe(g.id.toLowerCase());
  });
  test("설명이 없으면 첫 문단이 요약", () => {
    expect(find("skill:user::no-desc").summary).toStartWith("This skill has no frontmatter");
  });
  test("플러그인: 켜진 것만 enabled, 프로젝트 전용은 꺼진 채 안내", () => {
    expect(find("plugin:plugin:plugin-a:plugin-a").enabled).toBe(true);
    expect(find("plugin:plugin:plugin-off:plugin-off").enabled).toBe(false);
    const p = find("plugin:plugin:plugin-proj:plugin-proj");
    expect(p.enabled).toBe(false);
    expect(p.summary).toContain("proj-a");
    expect(find("skill:plugin:plugin-proj:proj-skill").enabled).toBe(false);
    expect(find("skill:plugin:plugin-off:good-skill").enabled).toBe(false);
    expect(find("skill:plugin:plugin-a:helper").enabled).toBe(true);
  });
  test("지시문 import 는 별도 항목이고 서로 연결된다", () => {
    const root = find("instruction:user::claude.md");
    const imp = find("instruction:user::rules/style.md");
    expect(root.links.out).toContain(imp.id);
    expect(imp.links.in).toContain(root.id);
    expect(root.alwaysLoaded?.what).toBe("전역 CLAUDE.md");
  });
  test("프로젝트 지시문은 .claude.json 의 실제 폴더에서 읽는다", () => {
    expect(find("instruction:project:proj-a:claude.md").alwaysLoaded).toBeNull();
    find("instruction:project:proj-a:agents.md");
    expect(snap.items.some((i) => i.source.project === "gone")).toBe(false);
  });
  test("연결된 서비스는 이름만 있고 값은 없다", () => {
    const names = snap.items.filter((i) => i.kind === "mcp").map((i) => i.id).sort();
    expect(names).toEqual(["mcp:plugin:plugin-a:psvc", "mcp:project:proj-a:proj-svc", "mcp:user::svc-a", "mcp:user::svc-env"]);
  });
  test("훅은 설정과 플러그인에서 모두 읽는다", () => {
    const ev = snap.items.filter((i) => i.hook).map((i) => `${i.source.type}:${i.hook!.event}`).sort();
    expect(ev).toEqual(["plugin:PostToolUse", "user:PostToolUse", "user:PreToolUse", "user:SessionStart", "user:Stop", "user:UserPromptSubmit"]);
  });
  test("항목마다 id 가 겹치지 않고 daily30 은 길이 30", () => {
    expect(new Set(snap.items.map((i) => i.id)).size).toBe(snap.items.length);
    for (const i of snap.items) expect(i.usage.daily30).toHaveLength(30);
  });
  test("묶음은 종류와 출처로 나뉜다", () => {
    const g = snap.groups.find((x) => x.id === "group:skill:plugin:plugin-a");
    expect(g?.title).toBe("plugin-a");
    expect(g?.items).toContain("skill:plugin:plugin-a:helper");
    expect(snap.groups.find((x) => x.id === "group:agent:builtin:")?.title).toBe("기본 제공");
  });
});

describe("사용량", () => {
  test("스킬: AI가 고른 것과 직접 부른 것을 나눠 센다", () => {
    const g = find("skill:user::good-skill");
    expect(g.usage.via).toEqual({ model: 3, user: 1 }); // 본 대화 2 + 하위 에이전트 1 / /good-skill 1
    expect(g.usage.count30).toBe(4);
    expect(g.usage.countAll).toBe(5); // 60일 전 1건 포함
    expect(g.usage.daily30[29]).toBe(3);
    expect(g.usage.daily30[28]).toBe(1);
    expect(g.usage.lastUsed).toBeDefined();
  });
  test("재개된 대화가 복사해 온 줄은 두 번 세지 않는다", () => {
    // 복사본 파일이 있어도 사용량·요청·도구 호출 수가 그대로다
    expect(find("skill:user::good-skill").usage.count30).toBe(4);
    expect(find("mcp:user::svc-a").usage.count30).toBe(2);
    expect(snap.stats.prompts30).toBe(6);
    expect(snap.stats.toolCalls30).toEqual({ read: 3, bash: 1, mcp: 3, other: 12 });
  });
  test("스킬 메타 줄과 도구 결과 안의 명령 이름은 세지 않는다", () => {
    expect(find("command:user::hello").usage).toMatchObject({ count30: 1, via: { user: 1 } });
  });
  test("플러그인: plugin:이름 으로 매칭, 이름만이면 개인 스킬이 먼저", () => {
    expect(find("skill:plugin:plugin-a:helper").usage.count30).toBe(1);
    expect(find("skill:user::shared-name").usage.count30).toBe(1);
    expect(find("skill:plugin:plugin-a:shared-name").usage.count30).toBe(0);
    expect(find("command:plugin:plugin-a:run").usage).toMatchObject({ count30: 1, via: { user: 1 } });
  });
  test("30일 밖 사용은 count30 에 안 들어가고 countAll 에만", () => {
    const u = find("skill:user::unused-one").usage;
    expect(u.count30).toBe(0);
    expect(u.countAll).toBe(1);
  });
  test("에이전트: subagent_type, 없으면 general-purpose, 기본 제공도 센다", () => {
    expect(find("agent:user::reviewer").usage.count30).toBe(1);
    expect(find("agent:plugin:plugin-a:plugin-agent").usage.count30).toBe(1);
    expect(find("agent:builtin::explore").usage.count30).toBe(1);
    expect(find("agent:builtin::general-purpose").usage.count30).toBe(1);
  });
  test("연결된 서비스: 서버 이름, 플러그인 서버는 plugin_<플러그인>_<서버>", () => {
    expect(find("mcp:user::svc-a").usage.count30).toBe(2);
    expect(find("mcp:plugin:plugin-a:psvc").usage.count30).toBe(1);
    expect(find("mcp:user::svc-env").usage.count30).toBe(0);
  });
  test("파일 읽힘: 8.3 짧은 홈 이름(WISEBI~1)과 긴 이름이 같은 파일로 매칭", () => {
    expect(find("memory:project:fx-alpha:linked.md").usage.count30).toBe(2);
    expect(find("memory:project:fx-alpha:orphan.md").usage.count30).toBe(0);
  });
  test("플러그인 사용량은 구성의 합", () => {
    expect(find("plugin:plugin:plugin-a:plugin-a").usage.count30).toBe(1 + 1 + 1 + 1); // helper, run, plugin-agent, psvc
    expect(find("plugin:plugin:plugin-unused:plugin-unused").usage.count30).toBe(0);
  });
  test("훅: 실행 횟수, 평균·최대 시간, 실패, 30일 밖 실패는 제외", () => {
    const ok = find("hook:user::userpromptsubmit · ok-hook.mjs");
    expect(ok.hook).toMatchObject({ runs30: 3, avgMs: 200, maxMs: 300, failures30: 0 });
    expect(ok.usage.countAll).toBe(4);
    const slow = find("hook:user::stop · slow-hook.mjs");
    expect(slow.hook).toMatchObject({ runs30: 2, avgMs: 8000, maxMs: 12000, failures30: 0 });
    const bad = find("hook:user::pretooluse · failing-hook.mjs");
    expect(bad.hook).toMatchObject({ runs30: 4, failures30: 3 }); // 역슬래시 명령도 같은 훅으로
    const start = find("hook:user::sessionstart · start-ok.mjs");
    expect(start.hook?.injectedCharsAvg).toBe(120);
    expect(find("hook:user::posttooluse · unrun-hook.mjs").hook?.runs30).toBe(0);
  });
  test("통계: 대화·요청·도구 호출 수", () => {
    expect(snap.stats.sessions30).toBe(2); // 본 대화 + 재개된 복사본. 하위 에이전트와 60일 전 파일 제외
    expect(snap.stats.prompts30).toBe(6); // 일반 3 + 직접 부름 3, 중단·메타·도구 결과·하위 에이전트 제외
    expect(snap.stats.toolCalls30).toEqual({ read: 3, bash: 1, mcp: 3, other: 12 });
    expect(snap.stats.transcriptsScanned).toBe(4);
    expect(snap.window.days).toBe(30);
  });
});

describe("컨텍스트 추정", () => {
  const part = (k: string) => snap.context.parts.find((p) => p.key === k)!;
  test("합계는 부분의 합이고 예산은 200,000", () => {
    expect(snap.context.budgetTokens).toBe(200000);
    expect(snap.context.totalTokens).toBe(snap.context.parts.reduce((s, p) => s + p.tokens, 0));
    expect(snap.context.unusedTokens).toBe(snap.context.parts.reduce((s, p) => s + p.unusedTokens, 0));
  });
  test("전역 지시문은 CLAUDE.md 와 import 의 합", () => {
    const sum = find("instruction:user::claude.md").alwaysLoaded!.tokens + find("instruction:user::rules/style.md").alwaysLoaded!.tokens;
    expect(part("instructions").tokens).toBe(sum);
  });
  test("MEMORY.md 는 앞 200줄만 센다", () => {
    const trunc = find("memory-index:project:fx-trunc:memory.md");
    expect(trunc.size.lines).toBe(205);
    expect(trunc.alwaysLoaded!.chars).toBeLessThan(trunc.size.chars);
    expect(part("memory-index").tokens).toBe(trunc.alwaysLoaded!.tokens); // 가장 큰 것 기준
  });
  test("안 쓴 양은 30일 0회인 켜진 목록 줄의 합", () => {
    const skills = snap.items.filter((i) => (i.kind === "skill" || i.kind === "command") && i.enabled && i.alwaysLoaded);
    const unused = skills.filter((i) => i.usage.count30 === 0).reduce((s, i) => s + i.alwaysLoaded!.tokens, 0);
    expect(part("skills").unusedTokens).toBe(unused);
    expect(unused).toBeGreaterThan(0);
    expect(find("skill:plugin:plugin-off:good-skill").alwaysLoaded).toBeNull(); // 꺼진 플러그인은 안 센다
  });
  test("시작 훅이 넣는 글은 additional_context 평균", () => {
    expect(part("hooks").tokens).toBe(100); // (100+50 / 50) 평균
  });
});

describe("진단 규칙: 모두 한 번 이상 나온다", () => {
  test("memory-index-truncated", () => {
    const f = rule("memory-index-truncated");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].items).toEqual(["memory-index:project:fx-trunc:memory.md"]);
    expect(f[0].evidence).toContain("205줄");
  });
  test("memory-index-near-limit", () => {
    const f = rule("memory-index-near-limit");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("low");
    expect(f[0].items).toEqual(["memory-index:project:fx-near:memory.md"]);
  });
  test("broken-link: 마크다운 링크만 센다. [[위키]] 는 아직 없는 메모리 표시라 제외", () => {
    const f = rule("broken-link");
    expect(f.map((x) => x.items[0]).sort()).toEqual(["memory-index:project:fx-alpha:memory.md", "memory:project:fx-alpha:linked.md"]);
    const linked = f.find((x) => x.items[0].endsWith("linked.md"))!;
    expect(linked.evidence).toContain("gone.md");
    expect(linked.evidence).not.toContain("ghost");
    expect(f.find((x) => x.items[0].includes("memory-index"))?.evidence).toContain("missing.md");
  });
  test("[[위키]] 링크는 대소문자, - _ 차이를 무시하고 이어진다", () => {
    const linked = snap.items.find((x) => x.id === "memory:project:fx-alpha:linked.md")!;
    expect(linked.links.out).toContain("memory:project:fx-alpha:secret-token-notes.md");
  });
  test("orphan-memory: 연결 안 된 파일만", () => {
    const f = rule("orphan-memory");
    expect(f).toHaveLength(1);
    expect(f[0].items).toEqual(["memory:project:fx-alpha:orphan.md"]);
  });
  test("MEMORY.md 에 이름만 적힌 파일은 고아가 아니고 목차와 이어진다", () => {
    const named = snap.items.find((x) => x.id === "memory:project:fx-alpha:named-only.md")!;
    expect(named.links.in).toContain("memory-index:project:fx-alpha:memory.md");
    expect(rule("orphan-memory").flatMap((f) => f.items)).not.toContain(named.id);
  });
  test("duplicate-rule: 25자 이상 같은 줄이 지시문·MEMORY.md 2곳에", () => {
    const f = rule("duplicate-rule");
    expect(f).toHaveLength(1);
    expect(f[0].items.sort()).toEqual(["instruction:user::claude.md", "memory-index:project:fx-alpha:memory.md"]);
    expect(f[0].evidence).toContain("겹치는 줄 1개");
  });
  test("duplicate-name: 켜진 두 출처만", () => {
    const f = rule("duplicate-name");
    expect(f).toHaveLength(1);
    expect(f[0].items.sort()).toEqual(["skill:plugin:plugin-a:shared-name", "skill:user::shared-name"]);
  });
  test("similar-description: Jaccard 0.5 이상 한 쌍", () => {
    const f = rule("similar-description");
    expect(f).toHaveLength(1);
    expect(f[0].items.sort()).toEqual(["skill:user::sim-one", "skill:user::sim-two"]);
  });
  test("missing-description: 출처마다 1건", () => {
    const f = rule("missing-description");
    expect(f).toHaveLength(1);
    expect(f[0].items.sort()).toEqual(["agent:user::no-desc-agent", "skill:user::no-desc"]);
  });
  test("unused-plugin: 켜져 있고 구성을 한 번도 안 쓴 것", () => {
    const f = rule("unused-plugin");
    expect(f).toHaveLength(1);
    expect(f[0].items).toEqual(["plugin:plugin:plugin-unused:plugin-unused"]);
  });
  test("unused-items: 출처마다 1건, 플러그인 전체가 안 쓰인 경우는 unused-plugin 으로만", () => {
    const f = rule("unused-items");
    const sources = f.map((x) => x.title).sort();
    expect(f).toHaveLength(2);
    expect(sources.join("|")).toContain("플러그인 plugin-a");
    expect(sources.join("|")).toContain("개인 설정");
    const user = f.find((x) => x.title.includes("개인 설정"))!;
    expect(user.items).toContain("skill:user::unused-one");
    expect(user.items).not.toContain("skill:user::good-skill");
    expect(user.items).not.toContain("command:user::hello");
    expect(user.items.some((i) => i.includes("builtin"))).toBe(false);
    expect(f.some((x) => x.items.some((i) => i.includes("plugin-unused")))).toBe(false);
  });
  test("long-skill", () => {
    const f = rule("long-skill");
    expect(f).toHaveLength(1);
    expect(f[0].items).toEqual(["skill:user::long-skill"]);
  });
  test("slow-hook", () => {
    const f = rule("slow-hook");
    expect(f).toHaveLength(1);
    expect(f[0].items).toEqual(["hook:user::stop · slow-hook.mjs"]);
    expect(f[0].severity).toBe("medium");
  });
  test("failing-hook", () => {
    const f = rule("failing-hook");
    expect(f).toHaveLength(1);
    expect(f[0].items).toEqual(["hook:user::pretooluse · failing-hook.mjs"]);
    expect(f[0].severity).toBe("high");
  });
  test("모든 설계 규칙이 나왔다", () => {
    const want = [
      "memory-index-truncated", "memory-index-near-limit", "broken-link", "orphan-memory", "duplicate-rule", "duplicate-name",
      "similar-description", "missing-description", "unused-plugin", "unused-items", "long-skill", "slow-hook", "failing-hook",
    ];
    expect([...new Set(snap.findings.map((f) => f.rule))].sort()).toEqual([...want].sort());
  });
});

describe("진단 규칙: 깨끗한 항목은 걸리지 않는다 (음성 대조)", () => {
  test("깨끗한 작업 설명서·에이전트·명령·훅에는 진단이 없다", () => {
    for (const id of [
      "skill:user::good-skill", "command:user::hello", "agent:user::reviewer", "skill:plugin:plugin-a:helper",
      "hook:user::userpromptsubmit · ok-hook.mjs", "hook:user::sessionstart · start-ok.mjs", "hook:user::posttooluse · unrun-hook.mjs",
    ]) expect(findingsOf(id).map((f) => f.rule)).toEqual([]);
  });
  test("깨끗한 메모리 폴더(gamma)와 프로젝트 메모리에는 진단이 없다", () => {
    const clean = snap.items.filter((x) => x.source.project === "fx-gamma" || (x.source.project === "proj-a" && x.kind.startsWith("memory")));
    expect(clean.length).toBe(3 + 2); // gamma 3개 + proj-a 메모리 2개 (대조군이 비어 있지 않다는 확인)
    for (const i of clean) expect(findingsOf(i.id).map((f) => f.rule)).toEqual([]);
  });
  test("꺼진 플러그인의 항목은 어떤 진단에도 안 들어간다", () => {
    const off = snap.items.filter((x) => !x.enabled);
    expect(off.length).toBeGreaterThan(3);
    for (const i of off) expect(findingsOf(i.id)).toEqual([]);
  });
  test("연결된 파일(linked.md, secret-token-notes.md)은 고아가 아니다", () => {
    expect(findingsOf("memory:project:fx-alpha:linked.md").map((f) => f.rule)).toEqual(["broken-link"]);
    expect(findingsOf("memory:project:fx-alpha:secret-token-notes.md").map((f) => f.rule)).toEqual([]);
  });
  test("쓰인 스킬은 unused-items 에 없다", () => {
    const unused = new Set(rule("unused-items").flatMap((f) => f.items));
    for (const id of ["skill:user::good-skill", "skill:user::shared-name", "skill:plugin:plugin-a:helper", "agent:user::reviewer"]) expect(unused.has(id)).toBe(false);
  });
});

describe("진단 결과 형식", () => {
  test("심각도 순으로 정렬, id 는 유일, 문구는 해요체이고 대시가 없다", () => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < snap.findings.length; i++) expect(order[snap.findings[i - 1].severity]).toBeLessThanOrEqual(order[snap.findings[i].severity]);
    expect(new Set(snap.findings.map((f) => f.id)).size).toBe(snap.findings.length);
    for (const f of snap.findings) {
      expect(f.title && f.why && f.fix && f.evidence).toBeTruthy();
      expect(f.items.length).toBeGreaterThan(0);
      expect(`${f.title}${f.why}${f.fix}${f.evidence}`).not.toMatch(/[—–]/);
      expect(f.why).toMatch(/요\.?$/);
    }
  });
  test("모든 진단에 순서대로 할 일과 Claude 요청문이 있고, 기본 문장으로 때우지 않는다", () => {
    for (const f of snap.findings) {
      expect(f.steps.length).toBeGreaterThanOrEqual(2);
      expect(f.prompt.length).toBeGreaterThan(20);
      expect(f.prompt).not.toBe(`${f.title}. ${f.fix}`); // todo.ts 의 기본 분기로 빠지지 않았다
      expect(`${f.steps.join("")}${f.prompt}${f.command ?? ""}`).not.toMatch(/[—–]/);
    }
  });
  test("할 일은 그 항목의 이름과 위치를 담는다", () => {
    const up = rule("unused-plugin")[0];
    expect(up.command).toBe("claude plugin disable plugin-unused@mkt");
    expect(up.steps.join(" ")).toContain("/plugin");
    const long = rule("long-skill")[0];
    expect(long.prompt).toContain(find(long.items[0]).path!);
    const bl = rule("broken-link").find((x) => x.items[0].endsWith("linked.md"))!;
    expect(bl.prompt).toContain("gone.md");
    const fail = rule("failing-hook")[0];
    expect(fail.command).toBe(find(fail.items[0]).hook!.command); // 개인 훅은 직접 실행해 볼 명령을 준다
  });
  test("항목의 findings 는 진단의 items 와 서로 맞는다", () => {
    for (const f of snap.findings) for (const id of f.items) expect(find(id).findings).toContain(f.id);
    for (const i of snap.items) for (const fid of i.findings) expect(snap.findings.find((f) => f.id === fid)?.items).toContain(i.id);
  });
});

describe("연결", () => {
  test("본문 속 이름 언급이 연결이 된다", () => {
    const root = find("instruction:user::claude.md");
    expect(root.links.out).toContain("skill:user::good-skill"); // /good-skill
    expect(root.links.out).toContain("agent:user::reviewer"); // `reviewer`
    expect(find("skill:user::good-skill").links.in).toContain(root.id);
  });
  test("플러그인은 구성과 서로 연결된다", () => {
    const p = find("plugin:plugin:plugin-a:plugin-a");
    expect(p.links.out).toEqual(expect.arrayContaining(["skill:plugin:plugin-a:helper", "command:plugin:plugin-a:run", "agent:plugin:plugin-a:plugin-agent", "mcp:plugin:plugin-a:psvc"]));
    expect(find("skill:plugin:plugin-a:helper").links.in).toContain(p.id);
  });
  test("MEMORY.md 는 메모리 파일로 이어진다", () => {
    expect(find("memory-index:project:fx-alpha:memory.md").links.out).toEqual(expect.arrayContaining(["memory:project:fx-alpha:linked.md", "memory:project:fx-alpha:secret-token-notes.md"]));
  });
});

describe("캐시와 예외", () => {
  test("두 번째 실행은 캐시를 쓰고 같은 결과를 낸다", async () => {
    const a = await scan(fx.home, { now: fx.now });
    expect(existsSync(join(fx.home, ".claude-checkup", "cache.json"))).toBe(true);
    const b = await scan(fx.home, { now: fx.now });
    for (const s of [a, b]) {
      s.generatedAt = "";
      s.stats.durationMs = 0;
    }
    expect(b).toEqual(a);
    expect(b.stats.prompts30).toBe(6);
  });
  test("파일이 바뀌면 그 파일만 다시 센다", async () => {
    const f = join(fx.home, ".claude", "projects", "C--fx-sessions", "main-session.jsonl");
    const line = JSON.stringify({ type: "assistant", timestamp: new Date(fx.now.getTime() - 5000).toISOString(), message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "good-skill" } }] } });
    appendFileSync(f, line + "\n");
    const s = await scan(fx.home, { now: fx.now });
    expect(s.items.find((i) => i.id === "skill:user::good-skill")?.usage.count30).toBe(5);
  });
  test(".claude 폴더가 없으면 비어 있고 안내가 있다", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cc-empty-"));
    try {
      const s = await scan(empty, { cache: false });
      expect(s.items).toEqual([]);
      expect(s.warnings.join(" ")).toContain(".claude 폴더");
      expect(s.context.totalTokens).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
