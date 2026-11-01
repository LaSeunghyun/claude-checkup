// 항목 사이 연결: 플러그인 구성, 메모리 링크, 본문 속 이름 언급. md 파일 사이 길(edges)도 함께 만든다.
import { basename, dirname, resolve } from "node:path";
import type { MdEdge } from "../shared/types";
import { exists } from "./fsutil";
import { MEMORY_INDEX_LINES, type Entry, type PluginEntry } from "./inventory";
import { memoryKey, memoryLinks, stripCode } from "./text";

function link(from: Entry, to: Entry) {
  if (from === to) return;
  if (!from.item.links.out.includes(to.item.id)) from.item.links.out.push(to.item.id);
  if (!to.item.links.in.includes(from.item.id)) to.item.links.in.push(from.item.id);
}

const TEXT_KINDS = new Set(["instruction", "memory-index", "memory", "skill", "command", "agent"]);
const TARGET_KINDS = new Set(["skill", "command", "agent"]);
const MD_KINDS = new Set(["instruction", "memory-index", "memory"]); // 연결 그래프의 노드

const rank = (e: Entry): number => {
  const s = e.item.source.type;
  return (s === "user" ? 0 : s === "project" ? 1 : s === "plugin" ? (e.item.enabled ? 2 : 3) : 4) * 2 + (e.item.kind === "skill" ? 0 : 1);
};

export interface LinkResult {
  broken: Map<string, string[]>; // 항목 id -> 대상이 없는 링크
  edges: MdEdge[]; // md 파일 사이 길. 같은 쌍이 여러 번 나올 수 있어서 buildGraph 가 하나로 합친다
}

// 본문 속 md 파일 이름 (코드 표기 안의 것도 센다). `~/` 로 시작하는 경로는 home 을 알 때만 풀고, 절대경로·주소 속 이름은 제외한다
const MD_NAME = /(?<![\w./\\~:@-])((?:~\/)?(?:\.{1,2}\/|[\w.-]+\/)*[\w.-]+\.md)(?![\w-])/gi;

// MEMORY.md 는 앞 MEMORY_INDEX_LINES 줄만 AI에게 읽힌다. 목차 길은 그 안에서만 만든다
const readable = (e: Entry): string => (e.item.kind === "memory-index" && e.text ? e.text.split("\n").slice(0, MEMORY_INDEX_LINES).join("\n") : (e.text ?? ""));

export function buildLinks(entries: Entry[], plugins: PluginEntry[], home?: string): LinkResult {
  const broken = new Map<string, string[]>();
  const edges: MdEdge[] = [];
  // MEMORY.md 가 가리키는 길은 어떻게 찾았든(링크, 이름 적기, 언급) 목차 길이다
  const edge = (from: Entry, to: Entry, kind: MdEdge["kind"]) => {
    if (from === to) return;
    edges.push({ from: from.item.id, to: to.item.id, kind: from.item.kind === "memory-index" && kind !== "import" ? "index" : kind });
  };

  // 지시문 @import: 인벤토리가 이미 이어 둔 지시문끼리의 연결이다
  const byId = new Map(entries.map((e) => [e.item.id, e] as const));
  for (const e of entries) {
    if (e.item.kind !== "instruction") continue;
    for (const id of e.item.links.out) {
      const t = byId.get(id);
      if (t?.item.kind === "instruction") edge(e, t, "import");
    }
  }

  // 플러그인 <-> 구성
  const byPlugin = new Map<string, Entry>();
  for (const p of plugins) {
    const e = entries.find((x) => x.item === p.item);
    if (e) byPlugin.set(p.key, e);
  }
  for (const e of entries) {
    if (!e.pluginKey || e.item.kind === "plugin") continue;
    const p = byPlugin.get(e.pluginKey);
    if (p) link(p, e);
  }

  // 메모리 링크
  const memByPath = new Map<string, Entry>();
  const memByKey = new Map<string, Entry>(); // `${memDir}|${memoryKey}` -> 메모리 (파일 이름과 frontmatter name 둘 다)
  for (const e of entries) {
    if ((e.item.kind === "memory" || e.item.kind === "memory-index") && e.abs) {
      memByPath.set(resolve(e.abs).toLowerCase(), e);
      if (e.memDir) {
        const dir = resolve(e.memDir).toLowerCase();
        memByKey.set(`${dir}|${memoryKey(basename(e.abs))}`, e);
        const name = e.text?.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)/m)?.[1];
        if (name) memByKey.set(`${dir}|${memoryKey(name.trim())}`, e);
      }
    }
  }
  for (const e of entries) {
    if (!e.memDir || !e.text) continue;
    const { md, wiki } = memoryLinks(e.text);
    // 연결(links)과 끊긴 링크는 파일 전체로, 길(edges)은 읽히는 부분(MEMORY.md 는 앞 200줄)으로만 만든다
    const shown = readable(e);
    const seen = shown === e.text ? { md, wiki } : memoryLinks(shown);
    const shownMd = new Set(seen.md);
    const shownWiki = new Set(seen.wiki);
    const dir = resolve(e.memDir).toLowerCase();
    for (const w of new Set(wiki)) {
      const target = memByKey.get(`${dir}|${memoryKey(w)}`);
      if (target) {
        link(e, target);
        if (shownWiki.has(w)) edge(e, target, "link");
      }
    }
    // MEMORY.md 가 링크 없이 파일 이름만 적어 둔 경우도 목차에 있는 것으로 본다
    if (e.item.kind === "memory-index") {
      const plain = stripCode(e.text).toLowerCase();
      const plainShown = shown === e.text ? plain : stripCode(shown).toLowerCase();
      for (const x of entries) {
        if (x.item.kind !== "memory" || !x.abs || !x.memDir || resolve(x.memDir).toLowerCase() !== dir) continue;
        const stem = basename(x.abs).replace(/\.md$/i, "").toLowerCase();
        const re = new RegExp(`(?<![\\w-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
        if (re.test(plain)) {
          link(e, x);
          if (re.test(plainShown)) edge(e, x, "index");
        }
      }
    }
    const bad: string[] = [];
    for (const t of new Set(md)) {
      const cands = t.toLowerCase().endsWith(".md") ? [t] : [t + ".md", t];
      let ok = false;
      let target: Entry | undefined;
      for (const c of cands) {
        const abs = resolve(e.memDir, c);
        if (exists(abs)) {
          ok = true;
          target = memByPath.get(abs.toLowerCase());
          break;
        }
      }
      if (!ok) bad.push(t);
      else if (target) {
        link(e, target);
        if (shownMd.has(t)) edge(e, target, "link");
      }
    }
    if (bad.length) broken.set(e.item.id, bad);
  }

  // 본문에 다른 md 파일 이름이 나옴: 이 파일 기준으로 풀리는 경로(같은 폴더 이름 포함)가 노드일 때
  const nodeByPath = new Map<string, Entry>();
  for (const e of entries) if (MD_KINDS.has(e.item.kind) && e.abs) nodeByPath.set(resolve(e.abs).toLowerCase(), e);
  for (const e of entries) {
    if (!e.abs || !e.text || !MD_KINDS.has(e.item.kind)) continue;
    const dir = dirname(e.abs);
    const seen = new Set<Entry>();
    for (const m of readable(e).matchAll(MD_NAME)) {
      const fromHome = m[1].startsWith("~/");
      if (fromHome && !home) continue;
      const t = nodeByPath.get((fromHome ? resolve(home!, m[1].slice(2)) : resolve(dir, m[1])).toLowerCase());
      if (t && t !== e && !seen.has(t)) {
        seen.add(t);
        edge(e, t, "mention");
      }
    }
  }

  // 본문 속 이름 언급 (작업 설명서·명령·에이전트)
  const qualified = new Map<string, Entry>();
  const bare = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!TARGET_KINDS.has(e.item.kind)) continue;
    for (const n of e.inv) {
      if (n.includes(":")) qualified.set(n, e);
      else (bare.get(n) ?? bare.set(n, []).get(n)!).push(e);
    }
  }
  const pick = (n: string): Entry | undefined => bare.get(n)?.slice().sort((a, b) => rank(a) - rank(b))[0];
  const reSlash = /(?<![\w/.:~-])\/([a-z][\w-]{3,})(?![\w/-]|\.\w|:\w)/gi;
  const reTick = /`([a-z][\w-]{3,})`/gi;
  const reQual = /(?<![\w-])([a-z0-9][\w-]*:[a-z0-9][\w-]*)(?![\w-])/gi;
  for (const e of entries) {
    if (!e.text || !TEXT_KINDS.has(e.item.kind)) continue;
    const t = stripCodeKeepTicks(e.body ?? e.text);
    for (const m of t.matchAll(reQual)) {
      const x = qualified.get(m[1].toLowerCase());
      if (x) link(e, x);
    }
    for (const re of [reSlash, reTick]) {
      for (const m of t.matchAll(re)) {
        const x = pick(m[1].toLowerCase());
        if (x) link(e, x);
      }
    }
  }
  return { broken, edges };
}

// 코드 블록은 지우되, 한 줄짜리 `이름` 표기는 남긴다
function stripCodeKeepTicks(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "");
}
