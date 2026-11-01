// `claude -p` 로 고치기 계획 만들기. 대상 파일을 임시 폴더에 복사해 거기서만 고치게 하고, 끝나면 원본과 비교한다.
// 비밀값이 든 파일은 복사하지 않고, 허용 폴더 밖 변경은 버린다. 원본은 이 파일에서 한 번도 쓰지 않는다.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

async function runProcess(cmd: string[], args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Ran> {
  const proc = Bun.spawn([...spawnable(cmd), ...args], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : null;
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, timedOut };
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

// 폴더 안 일반 파일 절대경로 (링크는 따라가지 않는다)
function walkFiles(root: string, out: string[] = []): string[] {
  let ents;
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// 윈도우는 방금 끝난 프로세스가 작업 폴더를 잠깐 붙들고 있을 수 있어서(EBUSY) 몇 번 다시 시도하고, 끝내 안 되면 결과를 막지 않는다
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export interface PlanOpts {
  targets: string[]; // 절대경로, .claude 안
  scopeDirs: string[]; // 쓰기 허용 폴더 절대경로
  prompt: string;
  timeoutMs?: number;
  cmd?: string[];
}

// 사용자 훅이 임시 폴더 실행에 끼지 않게 하는 설정 (Task 7 실측으로 결정, 아래 HOOK_ARGS)
const HOOK_ARGS: string[] = ["--settings", "{\"disableAllHooks\":true}"];

export async function planWithClaude(home: string, opts: PlanOpts): Promise<Planned & { usage?: FixPreview["usage"]; warnings: string[] }> {
  const cmd = opts.cmd ?? resolveClaude();
  if (!cmd) throw new Error("이 컴퓨터에서 Claude Code 를 찾지 못했어요");
  // 쓰는 곳은 .claude 안뿐이다
  const scopes = opts.scopeDirs.map((d) => resolve(d));
  for (const d of scopes) if (relOf(home, join(d, "x")) === null) throw new Error("Claude에게 맡길 수 없는 폴더예요: " + redactSecrets(d));
  const targets = opts.targets.map((t) => resolve(t));
  for (const t of targets) if (relOf(home, t) === null) throw new Error("Claude에게 맡길 수 없는 파일이에요: " + redactSecrets(t));
  const warnings: string[] = [];

  // 고칠 대상에 비밀값이 있으면 실행하지 않는다
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
  try {
    mkdirSync(work, { recursive: true });
    // 복사: 허용 폴더 전체와 대상 파일. 같은 상대 경로(.claude 기준)로
    const orig = new Map<string, Buffer>(); // rel -> 복사한 원본 내용
    let skippedSecret = 0;
    const seen = new Set<string>();
    for (const abs of [...scopes.flatMap((d) => walkFiles(d)), ...targets]) {
      const rel = relOf(home, abs);
      if (rel === null || seen.has(rel.toLowerCase())) continue;
      seen.add(rel.toLowerCase());
      let buf: Buffer;
      try {
        if (!lstatSync(abs).isFile()) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (isSecretName(abs) || isSecretBody(buf)) {
        skippedSecret++;
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) continue;
      const dest = join(work, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      orig.set(rel, buf);
    }
    if (skippedSecret) warnings.push(`비밀값이 있어 Claude에게 보내지 않은 파일 ${skippedSecret}개`);

    const prompt = redactSecrets(opts.prompt);
    if (prompt !== opts.prompt) warnings.push("요청문에 비밀값 모양이 있어 가려서 보냈어요");

    const args = [
      "-p",
      prompt,
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
      ...HOOK_ARGS,
    ];
    let ran: Ran;
    try {
      ran = await runProcess(cmd, args, { cwd: work, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
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

    // 비교
    const writes: Planned["writes"] = [];
    const changes: FileChange[] = [];
    const hashes: Record<string, string> = {};
    const inScope = (abs: string) => scopes.some((d) => inside(abs, d)) || targets.some((t) => t.toLowerCase() === abs.toLowerCase());
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
        if (isSecretName(abs) || existsSync(abs)) {
          warnings.push(`원래 있던 파일이거나 비밀 이름이라 반영하지 않아요: ${rel}`);
          continue;
        }
        if (isSecretBody(buf)) {
          warnings.push(`비밀값 모양이 들어 있어 반영하지 않아요: ${rel}`);
          continue;
        }
      } else if (isSecretBody(buf)) {
        warnings.push(`비밀값 모양이 들어 있어 반영하지 않아요: ${rel}`);
        continue;
      }
      const text = buf.toString("utf8");
      const diff: DiffLine[] = lineDiff(before ? redactSecrets(before.toString("utf8")) : "", redactSecrets(text));
      writes.push({ abs, content: text });
      changes.push({ rel, kind: before ? "modified" : "added", diff });
      hashes[abs] = hashPath(abs);
    }
    for (const t of targets) if (!(t in hashes)) hashes[t] = hashPath(t);

    const u = out.usage;
    const usage: FixPreview["usage"] | undefined =
      u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
        ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, ...(typeof out.total_cost_usd === "number" ? { costUsd: out.total_cost_usd } : {}) }
        : undefined;
    return { overlay: overlayFrom(writes.map((w): [string, string | null] => [w.abs, w.content])), changes, writes, moves: [], pluginKeys: [], hashes, usage, warnings };
  } finally {
    await removeDir(work);
  }
}
