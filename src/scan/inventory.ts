// 설정 묶음 읽기: 지시문, 메모리, 스킬, 명령, 에이전트, 훅, 연결된 서비스, 플러그인.
// 비밀값이 있을 수 있는 파일은 열지 않고, 연결된 서비스는 이름만 읽는다.
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Item, ItemKind, Source } from "../shared/types";
import {
  displayPath,
  exists,
  isDir,
  isFile,
  isSecretName,
  listDir,
  mtimeIso,
  readJson,
  readText,
  redactSecrets,
  resolveFrom,
  slash,
} from "./fsutil";
import { countLines, estimateTokens, importRefs, outlineOf, parseFrontmatter, summarize, truncate } from "./text";

export const MEMORY_INDEX_LINES = 200;

export interface Entry {
  item: Item;
  abs?: string; // 파일 절대경로
  text?: string; // 전체 글
  body?: string; // frontmatter 뺀 본문
  hasDescription?: boolean; // frontmatter description 이 있는가
  inv: string[]; // 호출 이름 후보 (소문자)
  memDir?: string; // 메모리 폴더 절대경로
  pluginKey?: string;
  secret?: boolean; // 이름 때문에 열지 않은 파일
  rawCmd?: string; // 훅 원래 명령 (대화 기록 매칭용, 화면에는 가린 것을 쓴다)
  wordsSource?: string; // 설명 (유사도 비교용)
}

export interface PluginEntry {
  key: string;
  name: string;
  enabled: boolean;
  item: Item;
  installPath: string | null;
}

export interface Inventory {
  entries: Entry[];
  plugins: PluginEntry[];
  warnings: string[];
}

const zeroUsage = (): Item["usage"] => ({ count30: 0, countAll: 0, daily30: new Array(30).fill(0) });

const EVENT_WHEN: Record<string, string> = {
  SessionStart: "대화를 시작할 때",
  UserPromptSubmit: "내가 요청을 보낼 때",
  PreToolUse: "AI가 도구를 쓰기 전에",
  PostToolUse: "AI가 도구를 쓴 뒤에",
  Stop: "AI가 답을 끝냈을 때",
  SubagentStop: "하위 에이전트가 끝났을 때",
  SessionEnd: "대화를 끝낼 때",
  Notification: "알림이 뜰 때",
  PreCompact: "대화를 줄이기 직전에",
};

const BUILTIN_AGENTS: [string, string][] = [
  ["general-purpose", "여러 단계로 된 조사나 작업을 맡기는 기본 에이전트예요."],
  ["Explore", "코드나 파일을 빠르게 훑어서 찾아 주는 읽기 전용 에이전트예요."],
  ["Plan", "구현 계획을 세워 주는 에이전트예요."],
  ["statusline-setup", "화면 아래 상태 줄 설정을 도와주는 에이전트예요."],
  ["claude-code-guide", "Claude Code 사용법을 알려 주는 에이전트예요."],
];

export function itemId(kind: ItemKind, source: Source, name: string): string {
  return `${kind}:${source.type}:${source.plugin ?? source.project ?? ""}:${name}`.toLowerCase();
}

export const mangle = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, "-");

class Builder {
  entries: Entry[] = [];
  warnings: string[] = [];
  ids = new Set<string>();
  constructor(readonly home: string) {}

  // JSON 설정 읽기. 파일이 있는데 못 읽으면(깨졌거나 권한 문제) 안내에 남긴다
  json(abs: string): any | null {
    const j = readJson(abs);
    if (j == null && exists(abs)) this.warnings.push(`${displayPath(abs, this.home)} 를 읽지 못했어요. 파일이 깨졌거나 권한이 없을 수 있어요.`);
    return j;
  }

  add(e: Omit<Entry, "item" | "inv"> & { inv?: string[]; item: Omit<Item, "id" | "usage" | "links" | "findings" | "outline"> & { outline?: string[] } }): Entry {
    const source = e.item.source;
    let id = itemId(e.item.kind, source, e.item.name);
    for (let n = 2; this.ids.has(id); n++) id = itemId(e.item.kind, source, `${e.item.name}~${n}`);
    this.ids.add(id);
    const entry: Entry = {
      ...e,
      inv: e.inv ?? [],
      item: { outline: [], ...e.item, id, usage: zeroUsage(), links: { out: [], in: [] }, findings: [] },
    };
    this.entries.push(entry);
    return entry;
  }

  // 글 파일 하나를 항목으로 만든다
  file(args: {
    kind: ItemKind;
    source: Source;
    name: string;
    abs: string;
    enabled: boolean;
    always?: (text: string, summary: string) => { chars: number; tokens: number; what: string } | null;
    inv?: string[];
    memDir?: string;
    pluginKey?: string;
    descLine?: boolean;
  }): Entry {
    const { kind, source, name, abs, enabled } = args;
    const base = {
      kind,
      name,
      source,
      path: displayPath(abs, this.home),
      enabled,
      modifiedAt: mtimeIso(abs),
    };
    if (isSecretName(abs)) {
      return this.add({
        abs,
        memDir: args.memDir,
        pluginKey: args.pluginKey,
        secret: true,
        item: {
          ...base,
          summary: "이름에 민감한 단어가 들어 있어서 내용은 읽지 않았어요.",
          size: { chars: 0, lines: 0, tokens: 0 },
          alwaysLoaded: null,
        },
      });
    }
    const text = readText(abs);
    if (text == null) {
      this.warnings.push(`${base.path} 를 읽지 못했어요.`);
      return this.add({
        abs,
        memDir: args.memDir,
        pluginKey: args.pluginKey,
        item: { ...base, summary: "", size: { chars: 0, lines: 0, tokens: 0 }, alwaysLoaded: null },
      });
    }
    const fm = parseFrontmatter(text);
    const hasDesc = !!fm.data.description?.trim();
    const summary = redactSecrets(summarize(fm.data.description, fm.body));
    const always = enabled && args.always ? args.always(text, summary) : null;
    return this.add({
      abs,
      text,
      body: fm.body,
      hasDescription: hasDesc,
      memDir: args.memDir,
      pluginKey: args.pluginKey,
      wordsSource: fm.data.description ?? "",
      inv: args.inv,
      item: {
        ...base,
        summary,
        outline: outlineOf(fm.body).map(redactSecrets),
        size: { chars: text.length, lines: countLines(text), tokens: estimateTokens(text) },
        alwaysLoaded: always,
      },
    });
  }
}

const listLine = (listName: string, summary: string) => `- ${listName}: ${summary}\n`;

function loadAlways(listName: string, what: string) {
  return (_t: string, summary: string) => {
    const line = listLine(listName, summary);
    return { chars: line.length, tokens: estimateTokens(line), what };
  };
}

// ---- 훅 ----

function hookLabel(command: string): string {
  const toks = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (const t of toks) {
    const s = t.replace(/^["']|["']$/g, "");
    if (/\.(mjs|cjs|js|ts|sh|py|cmd|bat|ps1|exe)$/i.test(s)) return s.split(/[\\/]/).pop() ?? s;
  }
  return truncate(command.replace(/\s+/g, " "), 40);
}

// 명령에 섞여 들어갔을지 모르는 비밀값 가리기 (화면에 나가는 이름·id·요약 모두 이것을 거친다)
export function redactCommand(cmd: string): string {
  return redactSecrets(cmd)
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1***@") // 주소 속 user:pass@
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot***") // 텔레그램 봇 주소
    .replace(/(hooks\.slack\.com\/services\/)[\w/-]+/gi, "$1***") // 슬랙 웹훅 주소
    .replace(/\b(Basic|Bearer)(\s+)[^\s"']+/gi, "$1$2***")
    .replace(/(\s(?:-u|--user)[\s=]+["']?)[^\s:"']+:[^\s"']+/g, "$1***") // curl -u user:pass (콜론이 없는 -u 는 건드리지 않는다)
    .replace(/((?:\b|--?)[\w-]*(?:token|secret|key|password|passwd|auth|credential)[\w-]*(?:\s*[=:]\s*|\s+))(?!\*\*\*|(?:Basic|Bearer)\s+\*\*\*)("[^"]*"|'[^']*'|[^\s-]\S*)/gi, "$1***")
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g, "***"); // 32자 이상 영숫자 덩어리는 키로 본다
}

interface RawHook {
  event: string;
  matcher?: string;
  command: string;
}

// obj 는 { 이벤트: [ { matcher, hooks: [ { command } ] } ] } 모양
function collectHooks(obj: unknown): RawHook[] {
  const out: RawHook[] = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [event, groups] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const matcher = typeof (g as { matcher?: unknown }).matcher === "string" ? (g as { matcher: string }).matcher : undefined;
      const hooks = (g as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        const cmd = h && typeof h === "object" ? (h as { command?: unknown }).command : undefined;
        if (typeof cmd === "string" && cmd.trim()) out.push({ event, matcher, command: cmd });
      }
    }
  }
  return out;
}

function addHooks(b: Builder, raw: RawHook[], source: Source, enabled: boolean, abs: string, pluginKey?: string) {
  const when = (e: string) => EVENT_WHEN[e] ?? `${e} 때`;
  for (const h of raw) {
    const cmd = redactCommand(h.command);
    const label = hookLabel(cmd); // 이름과 id 에도 가린 명령만 쓴다
    b.add({
      abs,
      pluginKey,
      rawCmd: h.command,
      item: {
        kind: "hook",
        name: `${h.event} · ${label}`,
        source,
        path: displayPath(abs, b.home),
        summary: truncate(`${when(h.event)} 자동으로 실행돼요. 실행 명령: ${cmd}`, 300),
        size: { chars: cmd.length, lines: 1, tokens: estimateTokens(cmd) },
        alwaysLoaded: null,
        enabled,
        hook: { event: h.event, matcher: h.matcher, command: cmd, runs30: 0, avgMs: 0, maxMs: 0, failures30: 0, blocked30: 0 },
      },
    });
  }
}

// ---- 지시문 import ----

function addGlobalInstructions(b: Builder, claudeDir: string) {
  const root = join(claudeDir, "CLAUDE.md");
  if (!isFile(root)) return;
  const seen = new Set<string>();
  const source: Source = { type: "user" };
  const visit = (abs: string, depth: number, parent?: Entry) => {
    const key = resolve(abs).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const inside = slash(relative(claudeDir, abs));
    const name = parent ? (inside.startsWith("..") ? basename(abs) : inside) : "CLAUDE.md";
    const e = b.file({
      kind: "instruction",
      source,
      name,
      abs,
      enabled: true,
      always: (t) => ({ chars: t.length, tokens: estimateTokens(t), what: parent ? "전역 CLAUDE.md 가 불러오는 파일" : "전역 CLAUDE.md" }),
    });
    if (parent) {
      parent.item.links.out.push(e.item.id);
      e.item.links.in.push(parent.item.id);
    }
    if (!e.text || depth >= 4) return;
    for (const ref of importRefs(e.text)) {
      const target = resolveFrom(dirname(abs), ref, b.home);
      if (isFile(target)) visit(target, depth + 1, e);
    }
  };
  visit(root, 0);
}

// ---- 플러그인 ----

interface InstallRec {
  scope?: string;
  installPath?: string;
  version?: string;
  projectPath?: string;
}

function resolveInstall(claudeDir: string, key: string, rec: InstallRec): string | null {
  if (rec.installPath && isDir(rec.installPath)) return rec.installPath;
  const [name, market] = key.split("@");
  if (market && rec.version) {
    const p = join(claudeDir, "plugins", "cache", market, name, rec.version);
    if (isDir(p)) return p;
  }
  return null;
}

function readMcpNames(b: Builder, abs: string): string[] {
  const j = b.json(abs);
  if (!j || typeof j !== "object") return [];
  const servers = j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : j;
  return Object.keys(servers).filter((k) => servers[k] && typeof servers[k] === "object");
}

function addMcp(b: Builder, name: string, source: Source, enabled: boolean, abs: string | undefined, pluginKey?: string) {
  const where = source.type === "user" ? "내 PC 설정" : source.type === "project" ? `프로젝트 ${source.project}` : `플러그인 ${source.plugin}`;
  b.add({
    abs,
    pluginKey,
    item: {
      kind: "mcp",
      name,
      source,
      path: abs ? displayPath(abs, b.home) : undefined,
      summary: `${where}에 등록된 연결된 서비스예요. 보안을 위해 이름만 확인해요.`,
      size: { chars: 0, lines: 0, tokens: 0 },
      alwaysLoaded: null,
      enabled,
    },
  });
}

function addPlugins(b: Builder, claudeDir: string, settings: Record<string, unknown> | null): PluginEntry[] {
  const out: PluginEntry[] = [];
  const reg = b.json(join(claudeDir, "plugins", "installed_plugins.json"));
  const plugins: Record<string, InstallRec[]> | undefined = reg?.plugins;
  if (!plugins || typeof plugins !== "object") return out;
  const enabledMap = (settings?.enabledPlugins ?? {}) as Record<string, unknown>;
  for (const [key, recs] of Object.entries(plugins)) {
    if (!Array.isArray(recs) || !recs.length) continue;
    const name = key.split("@")[0];
    const userRec = recs.find((r) => r.scope === "user");
    const rec = userRec ?? recs[0];
    const enabled = !!userRec && enabledMap[key] === true;
    const installPath = resolveInstall(claudeDir, key, rec);
    const source: Source = { type: "plugin", plugin: name };
    let note = "";
    if (!userRec) {
      const proj = rec.projectPath ? basename(rec.projectPath.replace(/[\\/]+$/, "")) : "";
      note = `프로젝트${proj ? ` ${proj}` : ""} 안에서만 설치돼 있어서 전체에서는 꺼져 있어요.`;
    } else if (!enabled) note = "설치돼 있지만 꺼져 있어요.";
    if (!installPath) {
      b.warnings.push(`플러그인 ${name} 의 설치 폴더를 찾지 못했어요.`);
      note = (note + " 설치 폴더를 찾지 못했어요.").trim();
    }

    let desc = "";
    let outline: string[] = [];
    let chars = 0;
    if (installPath) {
      const pj = b.json(join(installPath, ".claude-plugin", "plugin.json"));
      if (pj && typeof pj.description === "string") desc = pj.description;
      const readme = readText(join(installPath, "README.md"));
      if (readme) {
        const fm = parseFrontmatter(readme);
        if (!desc) desc = summarize(undefined, fm.body);
        outline = outlineOf(fm.body);
        chars = readme.length;
      }
    }
    const summary = truncate([note, desc].filter(Boolean).join(" "), 300);
    const entry = b.add({
      abs: installPath ?? undefined,
      pluginKey: key,
      item: {
        kind: "plugin",
        name,
        source,
        path: installPath ? displayPath(installPath, b.home) : undefined,
        summary,
        outline,
        size: { chars, lines: 0, tokens: 0 },
        alwaysLoaded: null,
        enabled,
        modifiedAt: installPath ? mtimeIso(installPath) : undefined,
      },
    });
    out.push({ key, name, enabled, item: entry.item, installPath });
    if (!installPath) continue;

    const listName = (n: string) => `${name}:${n}`;
    for (const d of listDir(join(installPath, "skills"))) {
      const dir = join(installPath, "skills", d.name);
      const abs = join(dir, "SKILL.md");
      if (!isDir(dir) || !isFile(abs)) continue;
      const nm = skillName(abs, d.name);
      const e = b.file({
        kind: "skill",
        source,
        name: nm,
        abs,
        enabled,
        pluginKey: key,
        always: loadAlways(listName(nm), "작업 설명서 목록 한 줄"),
      });
      e.inv = invNames(name, nm);
    }
    for (const d of listDir(join(installPath, "commands"))) {
      if (!d.isFile() || !d.name.endsWith(".md")) continue;
      const base = d.name.slice(0, -3);
      const e = b.file({
        kind: "command",
        source,
        name: base,
        abs: join(installPath, "commands", d.name),
        enabled,
        pluginKey: key,
        always: loadAlways(listName(base), "명령 목록 한 줄"),
      });
      e.inv = invNames(name, base);
    }
    for (const d of listDir(join(installPath, "agents"))) {
      if (!d.isFile() || !d.name.endsWith(".md")) continue;
      const abs = join(installPath, "agents", d.name);
      const base = d.name.slice(0, -3);
      const nm = frontName(abs) ?? base;
      const e = b.file({
        kind: "agent",
        source,
        name: nm,
        abs,
        enabled,
        pluginKey: key,
        always: loadAlways(listName(nm), "에이전트 목록 한 줄"),
      });
      e.inv = invNames(name, nm);
    }
    const hj = b.json(join(installPath, "hooks", "hooks.json"));
    if (hj) addHooks(b, collectHooks(hj.hooks ?? hj), source, enabled, join(installPath, "hooks", "hooks.json"), key);
    const mcpFile = join(installPath, ".mcp.json");
    if (isFile(mcpFile)) for (const s of readMcpNames(b, mcpFile)) addMcp(b, s, source, enabled, mcpFile, key);
  }
  return out;
}

function frontName(abs: string): string | null {
  if (isSecretName(abs)) return null;
  const t = readText(abs);
  if (t == null) return null;
  const n = parseFrontmatter(t).data.name?.trim();
  return n ? n : null;
}

const skillName = (abs: string, dirName: string): string => frontName(abs) ?? dirName;

// 호출 이름 후보. 플러그인 접두어가 이미 이름에 있으면 한 번만 쓴다
function invNames(plugin: string, name: string): string[] {
  const n = name.toLowerCase();
  const p = plugin.toLowerCase();
  const bare = n.startsWith(p + ":") ? n.slice(p.length + 1) : n;
  return [bare, `${p}:${bare}`];
}

// ---- 프로젝트 이름 ----

export function projectLabelFor(dirKey: string, home: string, known: Map<string, string>): string {
  const hit = known.get(dirKey.toLowerCase());
  if (hit) return hit;
  const mh = mangle(home);
  if (dirKey.toLowerCase() === mh.toLowerCase()) return "홈";
  if (dirKey.toLowerCase().startsWith(mh.toLowerCase() + "-")) return dirKey.slice(mh.length + 1);
  return dirKey.replace(/^[A-Za-z]--/, "");
}

const pathLabel = (p: string): string => {
  const parts = slash(p).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || parts[0] || p;
};

// ---- 전체 ----

export function buildInventory(home: string): Inventory {
  const claudeDir = join(home, ".claude");
  const b = new Builder(home);

  if (!isDir(claudeDir)) {
    b.warnings.push(".claude 폴더를 찾지 못했어요. Claude Code 를 한 번도 쓰지 않았거나 다른 위치에 있을 수 있어요.");
    return { entries: [], plugins: [], warnings: b.warnings };
  }

  const settings = readJson(join(claudeDir, "settings.json"));
  if (!settings && exists(join(claudeDir, "settings.json"))) b.warnings.push("settings.json 을 읽지 못했어요. 플러그인과 훅이 꺼져 있다고 보일 수 있어요.");
  const claudeJson = b.json(join(home, ".claude.json"));
  const user: Source = { type: "user" };

  // 지시문
  addGlobalInstructions(b, claudeDir);

  // 프로젝트 (.claude.json 의 projects)
  const known = new Map<string, string>();
  const projects: { dir: string; label: string; mcp: string[] }[] = [];
  const projs = claudeJson?.projects && typeof claudeJson.projects === "object" ? (claudeJson.projects as Record<string, unknown>) : {};
  const labelCount = new Map<string, number>();
  for (const [k, v] of Object.entries(projs)) {
    const abs = resolve(k);
    let label = pathLabel(abs);
    const c = labelCount.get(label.toLowerCase()) ?? 0;
    labelCount.set(label.toLowerCase(), c + 1);
    if (c > 0) label = `${pathLabel(dirname(abs))}/${label}`;
    known.set(mangle(abs).toLowerCase(), label);
    const ms = (v as { mcpServers?: unknown } | null)?.mcpServers;
    projects.push({ dir: abs, label, mcp: ms && typeof ms === "object" ? Object.keys(ms) : [] });
  }
  for (const p of projects) {
    if (!isDir(p.dir)) continue;
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      const abs = join(p.dir, f);
      if (isFile(abs)) b.file({ kind: "instruction", source: { type: "project", project: p.label }, name: f, abs, enabled: true });
    }
  }

  // 메모리
  const memFolders: { dir: string; source: Source }[] = [{ dir: join(claudeDir, "memory"), source: user }];
  for (const d of listDir(join(claudeDir, "projects"))) {
    if (!d.isDirectory()) continue;
    const label = projectLabelFor(d.name, home, known);
    memFolders.push({ dir: join(claudeDir, "projects", d.name, "memory"), source: { type: "project", project: label } });
  }
  for (const m of memFolders) {
    if (!isDir(m.dir)) continue;
    for (const f of listDir(m.dir)) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith(".md")) continue;
      const isIndex = f.name.toLowerCase() === "memory.md";
      b.file({
        kind: isIndex ? "memory-index" : "memory",
        source: m.source,
        name: f.name,
        abs: join(m.dir, f.name),
        memDir: m.dir,
        enabled: true,
        always: isIndex
          ? (t) => {
              const head = t.split("\n").slice(0, MEMORY_INDEX_LINES).join("\n");
              return { chars: head.length, tokens: estimateTokens(head), what: `MEMORY.md 앞 ${MEMORY_INDEX_LINES}줄` };
            }
          : undefined,
      });
    }
  }

  // 개인 스킬
  for (const d of listDir(join(claudeDir, "skills"))) {
    const dir = join(claudeDir, "skills", d.name);
    const abs = join(dir, "SKILL.md");
    if (!isDir(dir) || !isFile(abs)) continue;
    const nm = skillName(abs, d.name);
    const e = b.file({ kind: "skill", source: user, name: nm, abs, enabled: true, always: loadAlways(nm, "작업 설명서 목록 한 줄") });
    e.inv = [nm.toLowerCase()];
  }
  // 개인 명령
  for (const d of listDir(join(claudeDir, "commands"))) {
    if (!d.isFile() || !d.name.endsWith(".md")) continue;
    const base = d.name.slice(0, -3);
    const e = b.file({ kind: "command", source: user, name: base, abs: join(claudeDir, "commands", d.name), enabled: true, always: loadAlways(base, "명령 목록 한 줄") });
    e.inv = [base.toLowerCase()];
  }
  // 개인 에이전트
  for (const d of listDir(join(claudeDir, "agents"))) {
    if (!d.isFile() || !d.name.endsWith(".md")) continue;
    const abs = join(claudeDir, "agents", d.name);
    const nm = frontName(abs) ?? d.name.slice(0, -3);
    const e = b.file({ kind: "agent", source: user, name: nm, abs, enabled: true, always: loadAlways(nm, "에이전트 목록 한 줄") });
    e.inv = [nm.toLowerCase()];
  }
  // 기본 제공 에이전트
  for (const [name, summary] of BUILTIN_AGENTS) {
    const e = b.add({
      item: {
        kind: "agent",
        name,
        source: { type: "builtin" },
        summary,
        size: { chars: 0, lines: 0, tokens: 0 },
        alwaysLoaded: null,
        enabled: true,
      },
      hasDescription: true,
    });
    e.inv = [name.toLowerCase()];
  }

  // 훅 (settings.json)
  const settingsPath = join(claudeDir, "settings.json");
  if (settings?.hooks) addHooks(b, collectHooks(settings.hooks), user, true, settingsPath);

  // 연결된 서비스 (이름만)
  const cjPath = join(home, ".claude.json");
  if (claudeJson?.mcpServers && typeof claudeJson.mcpServers === "object") {
    for (const name of Object.keys(claudeJson.mcpServers)) addMcp(b, name, user, true, cjPath);
  }
  for (const p of projects) {
    for (const name of p.mcp) addMcp(b, name, { type: "project", project: p.label }, true, cjPath);
  }

  // 플러그인과 그 안의 구성
  const plugins = addPlugins(b, claudeDir, settings);

  return { entries: b.entries, plugins, warnings: b.warnings };
}
