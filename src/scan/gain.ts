// 사전 기대 효과 (design.md 9절 1): 할 일 카드의 "얻는 것"은 미리 보기 전에 나와야 해서 점검 때 규칙별로 추정한다.
// mechanical 은 변경이 확정적이라 그 변경을 덮어쓴 가상의 홈을 다시 분석해 정확히 계산한다(upTo false).
// claude 와 manual 은 결과가 고치는 쪽에 달려 있어 규칙별 상한을 쓰고 글에 "최대"를 붙인다(upTo true). 정확한 값은 미리 보기에서 나온다.
import { dirname, join } from "node:path";
import type { Finding, Gain, Item, Snapshot } from "../shared/types";
import { a4, duplicateGroups, type DiagnoseCtx } from "./findings";
import { overlayKey, readJson, redactSecrets, type Overlay } from "./fsutil";
import { analyze, diagnoseCtxOf, type ScanCore } from "./index";
import { MEMORY_INDEX_LINES, type Entry } from "./inventory";
import { estimateTokens } from "./text";

const NEAR_TARGET_LINES = 150; // todo.ts 가 near-limit 에서 줄이라고 하는 줄 수

const pages = (tokens: number) => `A4 약 ${a4(tokens)}쪽`;
const sec = (ms: number) => (ms / 1000).toFixed(1);
const exact = (text: string, n: { tokens?: number; count?: number }): Gain => ({ text, upTo: false, ...n });
const upTo = (text: string, n: { tokens?: number; count?: number } = {}): Gain => ({ text, upTo: true, ...n });

// settings.json 의 enabledPlugins 에서 그 플러그인들만 false 로 바꾼 덮어쓰기 (claude plugin disable 과 같은 결과)
function pluginsOff(claudeDir: string, keys: string[]): Overlay | null {
  const p = join(claudeDir, "settings.json");
  const j = readJson(p);
  const on = j?.enabledPlugins;
  if (!on || typeof on !== "object" || Array.isArray(on)) return null;
  const next = { ...on };
  for (const k of keys) next[k] = false;
  return { files: new Map([[overlayKey(p), JSON.stringify({ ...j, enabledPlugins: next }, null, 2)]]) };
}

// 대화마다 실리는 목록 한 줄의 토큰 (index.ts buildContext 의 작업 설명서·명령·에이전트 몫과 같다)
const LIST_KINDS = new Set(["skill", "command", "agent"]);
const listTokens = (i: Item): number => (i.enabled && i.alwaysLoaded && LIST_KINDS.has(i.kind) ? i.alwaysLoaded.tokens : 0);
const PLUGIN_OFF_RULES = new Set(["unused-plugin", "unused-items", "slow-hook"]); // mechanical 이면 플러그인을 끈다

// 보관 폴더로 옮긴 것과 같은 덮어쓰기: 원래 자리에서 없앤다. 작업 설명서는 폴더째 옮긴다
function moveOff(es: Entry[]): Overlay | null {
  const files = new Map<string, null>();
  for (const e of es) if (e.abs) files.set(overlayKey(e.item.kind === "skill" ? dirname(e.abs) : e.abs), null);
  return files.size ? { files } : null;
}

export function estimateGains(home: string, core: ScanCore, snap: Snapshot): void {
  const ctx: DiagnoseCtx | undefined = diagnoseCtxOf(snap) ?? diagnoseCtxOf(analyze(home, core));
  if (!ctx) return;
  const byId = new Map(ctx.entries.map((e) => [e.item.id, e] as const));
  const entriesOf = (f: Finding) => f.items.map((id) => byId.get(id)).filter((e): e is Entry => !!e);

  // 같은 변경(같은 플러그인 끄기)은 한 번만 다시 분석한다
  const memo = new Map<string, Snapshot | null>();
  const rerun = (key: string, make: () => Overlay | null): Snapshot | null => {
    if (!memo.has(key)) {
      const ov = make();
      memo.set(key, ov ? analyze(home, core, ov) : null);
    }
    return memo.get(key)!;
  };
  const savedBy = (after: Snapshot | null) => (after ? snap.context.totalTokens - after.context.totalTokens : 0);
  const pluginOf = (f: Finding) => {
    const k = byId.get(f.items[0] ?? "")?.pluginKey; // 플러그인 항목 자체도 pluginKey 가 있다
    return k ? ctx.plugins.find((p) => p.key === k) : undefined;
  };

  // 플러그인 끄기는 후보를 한꺼번에 끈 홈을 한 번만 분석하고, 줄어든 목록 토큰을 플러그인마다 나눈다.
  // 목록 토큰은 항목마다의 합이라 플러그인끼리 영향이 없다. 나눈 합이 전체 차이와 다르면 하나씩 다시 분석한다
  const offKeys = [...new Set(snap.findings.filter((f) => f.fixKind === "mechanical" && PLUGIN_OFF_RULES.has(f.rule)).map((f) => pluginOf(f)?.key).filter((k): k is string => !!k))];
  const offSaved = new Map<string, number>();
  const all = offKeys.length ? rerun("plugins", () => pluginsOff(ctx.claudeDir, offKeys)) : null;
  if (all) {
    const keyOf = new Map(ctx.entries.map((e) => [e.item.id, e.pluginKey] as const));
    const per = (items: Item[]) => {
      const m = new Map<string, number>();
      for (const i of items) {
        const k = keyOf.get(i.id);
        if (k) m.set(k, (m.get(k) ?? 0) + listTokens(i));
      }
      return m;
    };
    const b = per(snap.items);
    const a = per(all.items);
    for (const k of offKeys) offSaved.set(k, (b.get(k) ?? 0) - (a.get(k) ?? 0));
    if ([...offSaved.values()].reduce((n, v) => n + v, 0) !== savedBy(all)) {
      for (const k of offKeys) offSaved.set(k, savedBy(rerun(`plugin:${k}`, () => pluginsOff(ctx.claudeDir, [k]))));
    }
  }
  const offTokens = (key: string | undefined) => (key ? (offSaved.get(key) ?? 0) : 0);
  let dups: ReturnType<typeof duplicateGroups> | undefined;

  const gainOf = (f: Finding): Gain | undefined => {
    const es = entriesOf(f);
    const e = es[0];
    const plugin = pluginOf(f);
    const mech = f.fixKind === "mechanical";
    switch (f.rule) {
      case "unused-plugin":
      case "unused-items": {
        if (!mech) return undefined;
        // 플러그인 것은 플러그인을 끄고, 개인 것은 보관 폴더로 옮긴다 (8-2절)
        const tokens = plugin ? offTokens(plugin.key) : savedBy(rerun(`move:${f.id}`, () => moveOff(es)));
        if (tokens > 0) return exact(`대화마다 ${pages(tokens)}이 줄어요`, { tokens });
        // 목록 줄이 없는 구성뿐이면(연결된 서비스만 있는 플러그인 등) 꺼지는 개수로
        const n = f.rule === "unused-plugin" && plugin ? ctx.entries.filter((x) => x.pluginKey === plugin.key && x.item.kind !== "plugin" && x.item.kind !== "hook").length : es.length;
        return n ? exact(`안 쓰는 항목 ${n}개가 꺼져요`, { count: n }) : undefined;
      }
      case "unread-md": {
        // 옮기는 파일이 곧 안 읽힌 파일 전부라 개수가 정확하다. 다시 분석한 안 읽힘 차이는 쓰지 않는다:
        // 그 파일을 거쳐야 닿던 다른 파일이 길 없음으로 바뀌어도 줄어든 것으로 세어져 효과를 부풀린다(그건 미리 보기의 치르는 것)
        return es.length ? exact(`안 읽히는 메모리 파일 ${es.length}개가 정리돼요`, { count: es.length }) : undefined;
      }
      case "failing-hook": {
        const n = e?.item.hook?.failures30 ?? 0;
        if (!n) return undefined;
        return mech ? exact(`최근 30일에 ${n}번 실패한 자동 실행 규칙이 꺼져요`, { count: n }) : upTo(`최근 30일 기준 실패가 최대 ${n}번 줄어요`, { count: n });
      }
      case "slow-hook": {
        const s = sec(e?.item.hook?.avgMs ?? 0);
        if (!mech) return upTo(`실행마다 기다림이 최대 ${s}초 줄어요`);
        const tokens = offTokens(plugin?.key);
        return tokens > 0
          ? exact(`실행마다 평균 ${s}초 기다림이 없어지고, 대화마다 ${pages(tokens)}이 줄어요`, { tokens })
          : exact(`실행마다 평균 ${s}초 기다림이 없어져요`, {});
      }
      case "memory-index-truncated": {
        const n = (e?.item.size.lines ?? 0) - MEMORY_INDEX_LINES;
        return n > 0 ? upTo(`읽히지 않던 최대 ${n}줄이 다시 읽혀요`, { count: n }) : undefined;
      }
      case "memory-index-near-limit": {
        // 목표 줄 수 아래로 줄이면 빠지는 줄(앞 200줄 안)의 양
        const cut = (e?.text ?? "").split("\n").slice(NEAR_TARGET_LINES, MEMORY_INDEX_LINES).join("\n");
        const tokens = estimateTokens(cut);
        return tokens > 0 ? upTo(`대화마다 최대 ${pages(tokens)}이 줄어요`, { tokens }) : undefined;
      }
      case "broken-link": {
        const n = ctx.broken.get(e?.item.id ?? "")?.length ?? 0;
        return n ? upTo(`끊긴 링크가 최대 ${n}곳 줄어요`, { count: n }) : undefined;
      }
      case "unreachable-md":
        return upTo(`길 없는 파일이 최대 ${f.items.length}개 줄어요`, { count: f.items.length });
      case "duplicate-rule": {
        // 한 곳만 남기면 나머지 곳의 같은 줄이 빠진다
        const key = [...f.items].sort().join("|");
        const g = (dups ??= duplicateGroups(ctx.entries)).find((x) => x.ids.join("|") === key);
        const tokens = g ? g.samples.reduce((n, s) => n + estimateTokens(s), 0) * (g.ids.length - 1) : 0;
        return tokens > 0 ? upTo(`대화마다 최대 ${pages(tokens)}이 줄어요`, { tokens }) : undefined;
      }
      case "long-skill": {
        // 대화마다가 아니라 부를 때마다 읽는 양이라 tokens 에는 넣지 않는다
        const tokens = estimateTokens(e?.body ?? "");
        return tokens > 0 ? upTo(`부를 때마다 읽는 양이 최대 ${pages(tokens)} 줄어요`) : undefined;
      }
      case "similar-description":
        return upTo("헷갈릴 수 있는 짝이 최대 1개 줄어요", { count: 1 });
      case "missing-description":
        return upTo(`설명 없는 항목이 최대 ${f.items.length}개 줄어요`, { count: f.items.length });
      case "duplicate-name":
        return upTo(`같은 이름이 겹치는 곳이 최대 ${f.items.length - 1}곳 줄어요`, { count: f.items.length - 1 });
      // secret-in-file 은 위험 칸에 따로 보여 주고 효과 숫자를 붙이지 않는다
    }
    return undefined;
  };

  for (const f of snap.findings) {
    const g = gainOf(f);
    if (g) f.gain = { ...g, text: redactSecrets(g.text) };
    else delete f.gain;
  }
}
