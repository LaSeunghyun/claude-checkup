// 개발용 서버(dev-server.ts)의 가짜 고치기 API. src/shared/types.ts 아래쪽 규격을 흉내 낸다.
// 실제 파일은 건드리지 않는다. 상태는 주소의 ?mock= 으로 고른다 (dev-server.ts 머리말 참고).
import type { FileChange, FixJob, FixPreview, FixRequest, HistorySummary, Settings, Snapshot } from "../shared/types";

const FIX_MS = 1500;

interface FakeJob {
  job: FixJob;
  startedAt: number;
  mock: string | null;
}

interface Deps {
  fixture: Snapshot;
  getSettings: () => Settings;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const mockOf = (req: Request) => new URL(req.url).searchParams.get("mock");

export function createFixRoutes({ fixture, getSettings }: Deps) {
  const jobs = new Map<string, FakeJob>();

  function previewFor(req: FixRequest, claude: boolean, mock: string | null): FixPreview {
    const f = fixture.findings.find((x) => x.id === req.findingId)!;
    const ids = req.itemIds ?? f.items;
    const names = ids.map((id) => fixture.items.find((i) => i.id === id)?.name ?? id);
    const blocked =
      mock === "fix-blocked"
        ? { blocked: claude ? "이 변경안으로는 끊긴 링크 1곳이 새로 생겨요. 다른 안을 만들어 보세요." : "이 변경으로 고장 진단이 새로 1건 생겨요. 적용하면 오히려 나빠져서 막았어요." }
        : {};
    if (!claude) {
      const changes: FileChange[] = names.slice(0, 4).map((n) => ({
        rel: `settings.json (${n})`,
        kind: "plugin-off",
        diff: [
          { op: "-", text: `  "${n}": true,` },
          { op: "+", text: `  "${n}": false,` },
        ],
        note: "enabledPlugins 값을 바꿔요.",
      }));
      return {
        changes,
        effects: [
          { label: "대화를 시작할 때마다 미리 채워지는 양이 줄어요.", before: "A4 16쪽", after: "11쪽", tone: "good" },
          { label: "아래 기능은 다시 켜기 전까지 쓸 수 없어요. 모두 한 달 동안 0번 썼어요.", before: "0번 사용", after: `${ids.length}개 끔`, tone: "cost" },
        ],
        turnsOff: names.map((n) => ({ name: n, uses30: 0, detail: "작업 설명서와 에이전트를 쓸 수 없게 돼요." })),
        candidates: [],
        warnings: [],
        ...blocked,
      };
    }
    const added = Array.from({ length: 25 }, (_, i) => ({ op: "+" as const, text: `- [예시 메모리 ${i + 1}](example_${i + 1}.md) - 개발용 가짜 한 줄 설명이에요` }));
    return {
      changes: [{ rel: "projects/C--lash/memory/MEMORY.md", kind: "modified", diff: [{ op: " ", text: "# 메모리 목차" }, ...added] }],
      effects: [
        { label: "AI가 찾아갈 수 없던 메모리가 목차에 들어가, 필요할 때 읽을 수 있게 돼요.", before: "길 없음 52", after: "27개", tone: "good" },
        { label: "MEMORY.md 가 길어지지만 아직 200줄 한도 안이에요.", before: "151줄", after: "176줄", tone: "neutral" },
        { label: "목차는 대화마다 실리므로, 대화마다 읽는 양이 조금 늘어요.", before: "A4 16쪽", after: "16.6쪽", tone: "cost" },
      ],
      turnsOff: [],
      candidates: names.slice(0, 3).map((n, i) => ({
        itemId: ids[i]!,
        rel: `projects/C--lash/memory/${n}`,
        reason: i === 0 ? "90일 넘게 안 읽혔고 다른 파일과 내용이 겹쳐요" : "한 달 동안 한 번도 안 읽혔어요",
      })),
      usage: { inputTokens: 9400, outputTokens: 2600, costUsd: 0.12 },
      warnings: mock === "fix-blocked" ? [] : ["Claude가 허용된 폴더 밖의 파일도 고치려 해서 그 변경은 버렸어요."],
      ...blocked,
    };
  }

  function view(fj: FakeJob): FixJob {
    const { job, startedAt, mock } = fj;
    if (job.status !== "running") return job;
    if (Date.now() - startedAt < FIX_MS) return { ...job, message: "변경안을 만들고 있어요..." };
    if (mock === "fix-failed") {
      return (fj.job = { ...job, status: "failed", message: "Claude가 답하기 전에 멈췄어요. 잠시 뒤 다시 시도하거나 아래 방법으로 직접 해 주세요." });
    }
    return (fj.job = { ...job, status: "ready", preview: previewFor(job.request, job.kind === "claude", mock) });
  }

  return {
    "/api/fix/env": (req: Request) =>
      json(mockOf(req) === "fix-nocli" ? { available: false, reason: "이 컴퓨터에서 claude 를 찾지 못했어요." } : { available: true }),

    "/api/fix/preview": async (req: Request) => {
      const body = (await req.json().catch(() => null)) as FixRequest | null;
      const f = fixture.findings.find((x) => x.id === body?.findingId);
      if (!body || !f || f.fixKind === "manual") return json({ error: "이 진단은 앱이 고치지 않아요." }, 400);
      const mock = mockOf(req);
      if (f.fixKind === "claude") {
        if (mock === "fix-nocli") {
          return json({ error: "이 컴퓨터에서 claude 를 찾지 못했어요. 맡길 말을 복사해서 Claude Code에 붙여 넣어 주세요.", fallback: "copy" }, 400);
        }
        if (mock === "fix-consent" && getSettings().claudeFix !== "agreed") {
          return json({ error: "Claude 고치기 안내에 먼저 동의해 주세요.", needConsent: true }, 409);
        }
      }
      const job: FixJob = { id: crypto.randomUUID(), request: body, kind: f.fixKind, status: "running" };
      jobs.set(job.id, { job, startedAt: Date.now(), mock });
      return json(job);
    },

    "/api/fix/job": (req: Request) => {
      const fj = jobs.get(new URL(req.url).searchParams.get("id") ?? "");
      return fj ? json(view(fj)) : json({ error: "없는 작업이에요." }, 404);
    },

    "/api/fix/apply": async (req: Request) => {
      const body = (await req.json().catch(() => null)) as { jobId?: string; archive?: string[] } | null;
      const fj = jobs.get(body?.jobId ?? "");
      if (!fj) return json({ error: "없는 작업이에요." }, 404);
      if (fj.job.status !== "ready") return json({ error: "미리 보기가 아직 준비되지 않았어요." }, 409);
      if (mockOf(req) === "fix-stale") return json({ error: "파일이 그사이 바뀌었어요, 미리 보기를 다시 만들어 주세요." }, 409);
      const before = fixture.summary;
      const after: HistorySummary = {
        ...before,
        at: new Date().toISOString(),
        totalTokens: Math.round(before.totalTokens * 0.7),
        unusedTokens: Math.max(0, before.unusedTokens - 4000),
        byCategory: { ...before.byCategory, waste: Math.max(0, before.byCategory.waste - 2) },
      };
      fj.job = { ...fj.job, status: "applied", backupId: `bk-${fj.job.id.slice(0, 8)}`, result: { before, after } };
      return json(fj.job);
    },

    "/api/fix/undo": async (req: Request) => {
      const body = (await req.json().catch(() => null)) as { backupId?: string } | null;
      if (!body?.backupId) return json({ error: "되돌릴 백업을 알려 주세요." }, 400);
      if (mockOf(req) === "fix-undo-fail") {
        return json({ ok: false, message: "적용한 뒤에 파일을 다시 고치셨어요. 덮어쓰지 않았어요. 백업은 ~/.claude-checkup/backups/11-01-1312/ 에 있어요." });
      }
      return json({ ok: true, message: "원래대로 되돌렸어요. 다시 점검한 결과를 반영했어요." });
    },

    "/api/fix/backups": () =>
      json([
        { id: "20261101-120000-000", at: new Date(Date.now() - 3600_000).toISOString(), findingId: "f1", status: "applied", files: ["settings.json"], moves: [], plugins: ["plugin-unused@mkt"] },
        { id: "20261031-090000-000", at: new Date(Date.now() - 86400_000).toISOString(), findingId: "f2", status: "undone", files: [], moves: ["skills/unused-one"], plugins: [] },
      ]),
  };
}
