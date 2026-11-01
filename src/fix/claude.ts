// `claude -p` 로 고치기 계획 만들기. 대상 파일을 임시 폴더에 복사해 거기서만 고치게 하고, 끝나면 원본과 비교한다.
// 비밀값이 든 파일은 복사하지 않고, 허용 폴더 밖 변경은 버린다. 원본은 이 파일에서 한 번도 쓰지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isSecretName, overlayFrom, redactSecrets } from "../scan/fsutil";
import type { ClaudeEnv, DiffLine, FileChange, FixPreview } from "../shared/types";
import { hashPath, type Planned } from "./backup";
import { lineDiff } from "./diff";
import { absOf, relOf, tmpDir } from "./paths";

export class SecretInTargetError extends Error {
  constructor(public rel: string) {
    super("고칠 파일에 비밀값이 있어서 Claude에게 보내지 않아요. 먼저 비밀값을 지우고 다시 점검해 주세요: " + rel);
    this.name = "SecretInTargetError";
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_FILE_BYTES = 2_000_000;
const NOT_FOUND = 127;

// 환경변수 CLAUDE_CHECKUP_CLAUDE 가 있으면 공백으로 나눈 명령, 없으면 PATH 의 claude
export function resolveClaude(): string[] | null {
  const env = process.env.CLAUDE_CHECKUP_CLAUDE?.trim();
  if (env) return env.split(/\s+/);
  const found = Bun.which("claude");
  return found ? [found] : null;
}

// 윈도우의 .cmd/.bat 은 cmd 를 거쳐야 실행된다. .exe 는 그대로 된다
function spawnable(cmd: string[]): string[] {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd[0]) ? ["cmd", "/c", ...cmd] : cmd;
}

interface Ran {
  code: number;
  stdout: string;
  timedOut: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 자식과 그 아래 프로세스를 모두 끝낸다 (윈도우는 taskkill /T, 그 밖은 프로세스 그룹)
function killTree(proc: { pid: number; kill(sig?: any): void }): void {
  try {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" });
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 이미 끝났다 */
    }
  }
}

// 요청문은 명령줄이 아니라 표준 입력(input)으로 보낸다. 시간이 지나면 프로세스 트리를 죽이고, 손자가 출력 통로를 붙들고 있어도 기다리지 않는다
async function runProcess(cmd: string[], args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<Ran> {
  const proc = Bun.spawn([...spawnable(cmd), ...args], {
    cwd: opts.cwd,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    ...(process.platform === "win32" ? {} : { detached: true }),
  } as any) as any;
  let out = "";
  const drain = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream as any) if (keep) out += dec.decode(chunk, { stream: true });
    } catch {
      /* 닫힘 */
    }
  };
  const reading = Promise.all([drain(proc.stdout, true), drain(proc.stderr, false)]);
  // 요청문 쓰기도 시간 제한 안에서 한다. 자식이 입력을 안 읽거나 큰 출력을 먼저 쏟아도 멈추지 않는다
  const writing =
    opts.input === undefined
      ? Promise.resolve()
      : (async () => {
          try {
            proc.stdin.write(opts.input);
            await proc.stdin.end();
          } catch {
            /* 일찍 끝난 프로세스 */
          }
        })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = opts.timeoutMs ? new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), opts.timeoutMs))) : new Promise<never>(() => {});
  try {
    const r = await Promise.race([proc.exited as Promise<number>, timeout]);
    if (r === "timeout") {
      killTree(proc);
      await Promise.race([proc.exited, sleep(2000)]);
      return { code: 124, stdout: out, timedOut: true };
    }
    await Promise.race([Promise.all([writing, reading]), sleep(3000)]); // 출력은 끝난 뒤 잠깐만 더 기다린다
    return { code: r, stdout: out, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// claude 명령 하나를 돌려 종료 코드만 돌려준다. 못 찾거나 실행이 안 되면 던지지 않고 0 이 아닌 값 (플러그인 끄기가 설정 파일로 대신하도록)
export async function runClaudeCli(cmd: string[] | null, args: string[], timeoutMs = 60_000): Promise<number> {
  if (!cmd || !cmd.length) return NOT_FOUND;
  try {
    const r = await runProcess(cmd, args, { timeoutMs });
    return r.timedOut ? 124 : r.code;
  } catch {
    return NOT_FOUND;
  }
}

export async function claudeEnv(): Promise<ClaudeEnv> {
  const cmd = resolveClaude();
  if (!cmd) return { available: false, reason: "이 컴퓨터에서 Claude Code 를 찾지 못했어요. 설치돼 있어야 Claude에게 맡길 수 있어요" };
  const code = await runClaudeCli(cmd, ["--version"], 15_000);
  if (code !== 0) return { available: false, reason: "Claude Code 를 실행하지 못했어요. 설치와 로그인을 확인해 주세요" };
  return { available: true };
}

const isSecretBody = (b: Buffer): boolean => {
  const s = b.toString("utf8");
  return redactSecrets(s) !== s;
};

const inside = (p: string, root: string): boolean => {
  const n = process.platform === "win32" ? (x: string) => x.toLowerCase() : (x: string) => x;
  return n(p) === n(root) || n(p).startsWith(n(root) + sep);
};

// 폴더 안 일반 파일 절대경로 (링크는 따라가지 않는다). dirs 에는 폴더 자신과 하위 폴더를 모은다
function walkFiles(root: string, out: string[] = [], dirs?: Map<string, string>): string[] {
  dirs?.set(norm(root), root);
  let ents;
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(p, out, dirs);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const norm = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// 윈도우는 방금 끝난 프로세스가 작업 폴더를 잠깐 붙들고 있을 수 있어서(EBUSY) 몇 번 다시 시도하고, 끝내 안 되면 결과를 막지 않는다
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}

const hasFile = (d: string): boolean => {
  try {
    return readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? hasFile(join(d, e.name)) : true));
  } catch {
    return true; // 읽을 수 없으면 건드리지 않는다
  }
};

// claude 는 작업 폴더 이름으로 설정 폴더(CLAUDE_CONFIG_DIR 또는 실제 홈의 .claude)/projects 에 폴더를 만든다.
// 이번 실행의 id 로 끝나는 폴더가 빈 폴더뿐이면 지운다. 파일이 하나라도 있으면 남긴다
async function cleanProjectsDir(id: string): Promise<void> {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(id)) continue;
    const d = join(root, n);
    if (!hasFile(d)) await removeDir(d);
  }
}

export interface PlanOpts {
  targets: string[]; // 절대경로, .claude 안
  scopeDirs: string[]; // 쓰기 허용 폴더 절대경로
  prompt: string;
  timeoutMs?: number;
  cmd?: string[];
}

// resultText 는 claude 가 마지막에 쓴 글(json 출력의 result). 보관 후보 블록을 읽는 데 쓴다
export async function planWithClaude(home: string, opts: PlanOpts): Promise<Planned & { usage?: FixPreview["usage"]; warnings: string[]; resultText: string }> {
  const cmd = opts.cmd ?? resolveClaude();
  if (!cmd) throw new Error("이 컴퓨터에서 Claude Code 를 찾지 못했어요");
  // 쓰는 곳은 .claude 안뿐이다
  const scopes = opts.scopeDirs.map((d) => resolve(d));
  for (const d of scopes) if (relOf(home, join(d, "x")) === null) throw new Error("Claude에게 맡길 수 없는 폴더예요: " + redactSecrets(d));
  const targets = opts.targets.map((t) => resolve(t));
  for (const t of targets) if (relOf(home, t) === null) throw new Error("Claude에게 맡길 수 없는 파일이에요: " + redactSecrets(t));
  const warnings: string[] = [];

  // 고칠 대상에 비밀값이 있으면 실행하지 않는다 (이름이 비밀 꼴이면 열지도 않는다)
  for (const t of targets) {
    const rel = relOf(home, t)!;
    if (isSecretName(t)) throw new SecretInTargetError(rel);
    try {
      if (lstatSync(t).isFile() && isSecretBody(readFileSync(t))) throw new SecretInTargetError(rel);
    } catch (e) {
      if (e instanceof SecretInTargetError) throw e;
    }
  }

  const id = randomUUID();
  const work = join(tmpDir(home), id);
  const settingsFile = join(tmpDir(home), id + ".settings.json");
  // 실행 전 원본 지문. 실행 중 원본이 바뀌면 계획을 만들지 않는다 (방어선)
  const guard = [...new Set([...scopes, ...targets])];
  const guardBefore = guard.map((g) => hashPath(g));
  try {
    mkdirSync(work, { recursive: true });
    // 복사: 허용 폴더 전체와 대상 파일. 같은 상대 경로(.claude 기준)로
    const orig = new Map<string, Buffer>(); // rel -> 복사한 원본 내용
    const knownDirs = new Map<string, string>(); // 복사 때 이미 있던 폴더 (새 파일은 여기에만 허용). 값은 원래 대소문자 경로
    let skippedSecret = 0;
    const seen = new Set<string>();
    const files = [...scopes.flatMap((d) => walkFiles(d, [], knownDirs)), ...targets];
    for (const t of targets) knownDirs.set(norm(dirname(t)), dirname(t));
    for (const abs of files) {
      const rel = relOf(home, abs);
      if (rel === null || seen.has(rel.toLowerCase())) continue;
      seen.add(rel.toLowerCase());
      if (isSecretName(abs)) {
        skippedSecret++; // 이름이 비밀 꼴이면 열지 않는다
        continue;
      }
      let buf: Buffer;
      try {
        if (!lstatSync(abs).isFile()) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isSecretBody(buf)) {
        skippedSecret++;
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) continue;
      const dest = join(work, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      orig.set(rel, buf);
    }
    // 빈 폴더도 작업 폴더에 만들어 둔다 (새 파일을 둘 수 있는 곳)
    for (const d of knownDirs.values()) {
      const rel = relOf(home, join(d, "x"));
      if (rel) mkdirSync(join(work, ...rel.split("/").slice(0, -1)), { recursive: true });
    }
    if (skippedSecret) warnings.push(`비밀값이 있어 Claude에게 보내지 않은 파일 ${skippedSecret}개`);

    const prompt = redactSecrets(opts.prompt);
    if (prompt !== opts.prompt) warnings.push("요청문에 비밀값 모양이 있어 가려서 보냈어요");
    writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true }));

    // 안전 장치는 모두 명령줄에 둔다. 요청문은 표준 입력으로 보낸다.
    // --restricted: 코드 실행 도구 제거, 사용자 설정 무시, 파일 도구를 작업 폴더 안으로 가둔다
    const args = [
      "-p",
      "--restricted",
      "--strict-mcp-config",
      "--tools",
      "Read,Edit,Write,Glob,Grep",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "--disallowedTools",
      "Bash",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--max-turns",
      "30",
      "--settings",
      settingsFile,
    ];
    let ran: Ran;
    try {
      // 윈도우 8.3 짧은 이름(WISEBI~1) 경로로 띄우면 claude 가 작업 폴더 안 파일도 폴더 밖으로 보고 거부한다. 실제 경로로 띄운다
      ran = await runProcess(cmd, args, { cwd: realpathSync.native(work), timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, input: "현재 폴더 안의 파일만 읽고 고치세요. 다른 곳은 건드리지 마세요.\n\n" + prompt });
    } catch {
      throw new Error("Claude Code 를 실행하지 못했어요. 설치를 확인해 주세요");
    }
    if (ran.timedOut) throw new Error("Claude가 정해진 시간 안에 끝내지 못했어요. 잠시 뒤에 다시 해 보거나 맡길 말을 복사해 쓰세요");
    let out: any = null;
    try {
      out = JSON.parse(ran.stdout.trim().split("\n").filter(Boolean).pop() ?? "");
    } catch {
      /* 아래에서 실패로 본다 */
    }
    if (ran.code !== 0 || !out || out.is_error) throw new Error("Claude가 일을 마치지 못했어요. 로그인돼 있는지 확인하거나 맡길 말을 복사해 쓰세요");
    if (guard.some((g, i) => hashPath(g) !== guardBefore[i])) throw new Error("작업 중에 원본 파일이 바뀌었어요. 미리 보기를 다시 만들어 주세요");

    // 비교
    const writes: Planned["writes"] = [];
    const changes: FileChange[] = [];
    const hashes: Record<string, string> = {};
    const inScope = (abs: string) => scopes.some((d) => inside(abs, d)) || targets.some((t) => norm(t) === norm(abs));
    const after = new Map<string, Buffer>();
    for (const f of walkFiles(work)) after.set(f.slice(work.length + 1).split(sep).join("/"), readFileSync(f));

    for (const [rel] of orig) if (!after.has(rel)) warnings.push(`Claude가 지운 파일은 반영하지 않아요: ${rel}`);
    for (const [rel, buf] of [...after].sort((a, b) => a[0].localeCompare(b[0]))) {
      const abs = absOf(home, rel);
      const before = orig.get(rel);
      if (before && before.equals(buf)) continue;
      if (relOf(home, abs) === null || !inScope(abs)) {
        warnings.push(`허용된 곳 밖이라 반영하지 않아요: ${rel}`);
        continue;
      }
      if (!before) {
        if (!knownDirs.has(norm(dirname(abs)))) {
          warnings.push(`원래 없던 폴더라 반영하지 않아요: ${rel}`);
          continue;
        }
        if (isSecretName(abs) || existsSync(abs)) {
          warnings.push(`원래 있던 파일이거나 비밀 이름이라 반영하지 않아요: ${rel}`);
          continue;
        }
      }
      if (isSecretBody(buf)) {
        warnings.push(`비밀값 모양이 들어 있어 반영하지 않아요: ${rel}`);
        continue;
      }
      const text = buf.toString("utf8");
      const diff: DiffLine[] = lineDiff(before ? redactSecrets(before.toString("utf8")) : "", redactSecrets(text));
      writes.push({ abs, content: text });
      changes.push({ rel, kind: before ? "modified" : "added", diff });
      hashes[abs] = before ? sha(before) : "missing"; // 복사한 때의 원본 기준
    }
    // 대상 파일도 복사한 때의 내용으로 지문을 남긴다
    for (const t of targets) {
      const b = orig.get(relOf(home, t)!);
      if (!(t in hashes) && b) hashes[t] = sha(b);
    }

    const u = out.usage;
    const usage: FixPreview["usage"] | undefined =
      u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
        ? {
            inputTokens: u.input_tokens + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
            outputTokens: u.output_tokens,
            ...(typeof out.total_cost_usd === "number" ? { costUsd: out.total_cost_usd } : {}),
          }
        : undefined;
    return { overlay: overlayFrom(writes.map((w): [string, string | null] => [w.abs, w.content])), changes, writes, moves: [], pluginKeys: [], hashes, usage, warnings, resultText: typeof out.result === "string" ? out.result : "" };
  } finally {
    await removeDir(work);
    await removeDir(settingsFile);
    await cleanProjectsDir(id);
  }
}
