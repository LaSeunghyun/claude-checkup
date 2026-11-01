// 진단마다 "그래서 뭘 하면 되나"를 붙인다: 순서대로 할 일, Claude Code에 붙여 넣을 요청문, 터미널 명령(있으면).
// 비전문가용이라 메뉴 이름과 파일 위치를 그대로 적고, 지우는 일은 늘 백업이나 확인을 먼저 하게 한다.
import type { Finding } from "../shared/types";
import type { DiagnoseCtx } from "./findings";
import { a4 } from "./findings";
import { secretLineNumbers } from "./fsutil";
import type { Entry } from "./inventory";
import { MEMORY_INDEX_LINES } from "./inventory";

export interface Todo {
  steps: string[];
  prompt: string;
  command?: string;
}

const KIND_WORD: Record<string, string> = { skill: "작업 설명서", command: "명령", agent: "에이전트", hook: "자동 실행 규칙", mcp: "연결된 서비스" };
const PLUGIN_FILE_NOTE = "이 파일은 플러그인 안에 있어서 직접 고치면 다음 업데이트 때 원래대로 덮어써져요.";
const RESTART = "Claude Code를 다시 시작하면 적용돼요.";

const list = (xs: string[], n = 5) => xs.slice(0, n).join(", ") + (xs.length > n ? ` 외 ${xs.length - n}개` : "");
const dirOf = (p?: string) => (p ? p.replace(/[\\/][^\\/]*$/, "") : "메모리 폴더");
const sec = (ms: number) => (ms / 1000).toFixed(1);

function disableSteps(name: string): string[] {
  return [
    "Claude Code 입력창에 /plugin 을 입력해요.",
    `설치된 목록(Installed)에서 ${name} 을 골라요.`,
    "끄기(Disable)를 눌러요. 지우는 게 아니라서 필요하면 같은 곳에서 다시 켤 수 있어요.",
    RESTART,
  ];
}

export function todoFor(f: Finding, ctx: DiagnoseCtx, byId: Map<string, Entry>): Todo {
  const es = f.items.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
  const e = es[0];
  const path = e?.item.path ?? "";
  const pluginOf = (x?: Entry) => (x?.pluginKey ? ctx.plugins.find((p) => p.key === x.pluginKey) : undefined);

  switch (f.rule) {
    case "memory-index-truncated":
    case "memory-index-near-limit": {
      const target = f.rule === "memory-index-truncated" ? MEMORY_INDEX_LINES : 150;
      return {
        steps: [
          `${path} 파일을 열어요.`,
          "오래됐거나 이제 안 쓰는 줄을 지워요.",
          "설명이 긴 줄은 내용을 같은 폴더의 메모리 파일로 옮기고, 목차에는 한 줄 요약과 파일 링크만 남겨요.",
          `줄 수가 ${target}줄 아래가 됐는지 확인해요.`,
        ],
        prompt: `${path} 가 ${e?.item.size.lines ?? "많은"}줄이에요. AI는 앞 ${MEMORY_INDEX_LINES}줄까지만 읽어요. 내용을 지우지 말고, 긴 줄의 자세한 내용은 같은 폴더의 메모리 파일로 옮긴 뒤 MEMORY.md 에는 한 줄 요약과 링크만 남겨서 ${target}줄 아래로 줄여 줘. 바꾸기 전에 원본을 백업해 줘.`,
      };
    }

    case "broken-link": {
      const bad = ctx.broken.get(e?.item.id ?? "") ?? [];
      return {
        steps: [
          `${path} 파일을 열어요.`,
          `없는 파일을 가리키는 링크를 찾아요: ${list(bad)}`,
          "같은 폴더에 이름만 바뀐 파일이 있으면 링크를 그 이름으로 고쳐요.",
          "더 필요 없는 내용이면 그 링크 줄을 지워요.",
        ],
        prompt: `${path} 안의 링크 중 ${list(bad, 20)} 는 없는 파일을 가리켜요. 같은 폴더에 이름이 바뀐 파일이 있으면 링크를 고치고, 없으면 어떤 줄을 지울지 먼저 보여 준 다음 지워 줘.`,
      };
    }

    case "unreachable-md": {
      const dir = dirOf(path);
      const names = es.map((x) => x.item.name);
      const noIndex = !ctx.entries.some((x) => x.item.kind === "memory-index" && x.memDir === e?.memDir);
      const line = "`- [제목](파일이름.md) - 한 줄 설명`";
      return {
        steps: noIndex
          ? [
              `${dir} 폴더에는 MEMORY.md 가 없어요. 같은 폴더에 새로 만들어요.`,
              `이어지지 않은 파일 ${names.length}개를 확인해요: ${list(names)}`,
              `계속 쓸 파일은 MEMORY.md 에 ${line} 형식으로 한 줄씩 적어요.`,
              "더 필요 없는 파일은 지우지 말고 다른 폴더로 옮겨 둬요.",
            ]
          : [
              `${dir}/MEMORY.md 를 열어요.`,
              `목차에 이어지지 않은 파일 ${names.length}개를 확인해요: ${list(names)}`,
              `계속 쓸 파일은 MEMORY.md 에 ${line} 형식으로 한 줄씩 추가해요.`,
              `MEMORY.md 는 ${MEMORY_INDEX_LINES}줄까지만 읽혀요. 180줄을 넘길 것 같으면 주제별 하위 목차 파일을 새로 만들고, MEMORY.md 에는 그 파일로 가는 한 줄만 넣어요.`,
              "더 필요 없는 파일은 지우지 말고 다른 폴더로 옮겨 둬요.",
            ],
        prompt: `${dir} 메모리 폴더에서 ${noIndex ? "MEMORY.md 가 없어서" : "MEMORY.md 에"} 이어지지 않은 파일 ${names.length}개(${list(names, 30)})를 하나씩 읽어 줘. 1) 오래됐거나 다른 파일과 겹치는 것은 '보관 후보'로 목록에만 적고 고치지 마. 2) 계속 쓸 만한 것은 ${noIndex ? "같은 폴더에 MEMORY.md 를 새로 만들어" : `MEMORY.md 가 180줄을 넘지 않는 범위에서`} 한 줄씩 적어 줘. 3) 줄이 모자라면 주제별 하위 목차 파일 하나를 같은 폴더에 새로 만들고 MEMORY.md 에는 그 파일로 가는 한 줄만 넣어 줘. 파일은 지우지 마.`,
      };
    }

    case "unread-md": {
      const dir = dirOf(path);
      const names = es.map((x) => x.item.name);
      return {
        steps: [
          `안 읽힌 파일 ${names.length}개를 확인해요: ${list(names)}`,
          "파일을 하나씩 열어 아직 쓸모 있는 내용인지 훑어봐요.",
          "필요 없는 파일은 지우지 말고 ~/.claude-checkup/off/ 아래로 옮겨요. Claude Code 가 읽지 않는 곳이라 목록에서 빠져요.",
          `${dir}/MEMORY.md 에 그 파일을 가리키는 줄이 있으면 함께 지워요.`,
        ],
        prompt: `${dir} 메모리 폴더의 파일 ${names.length}개(${list(names, 30)})는 목차나 다른 메모리를 따라 닿을 수 있지만 한 달 동안 한 번도 안 읽혔어요. 파일마다 아직 쓸모 있는지 한 줄로 판단해 알려 줘. 지우지 말고, 필요 없어 보이는 것만 ~/.claude-checkup/off/ 아래로 옮길 후보 목록으로 보여 줘. MEMORY.md 에서 지울 줄도 함께 알려 줘.`,
      };
    }

    case "secret-in-file": {
      // 값은 어디에도 싣지 않는다. 줄 번호만 다시 센다
      const lines = secretLineNumbers(e?.text ?? "");
      const at = `${lines.slice(0, 10).join(", ")}번째 줄${lines.length > 10 ? ` 외 ${lines.length - 10}줄` : ""}`;
      return {
        steps: [
          `${path} 파일을 열어요.`,
          `토큰이나 키로 보이는 값이 있는 곳: ${at}`,
          "그 값을 지워요. 꼭 필요한 값이면 파일 밖의 안전한 곳(환경 변수나 비밀번호 관리자)으로 옮겨요.",
          "이미 대화나 다른 곳에 올렸을 수 있으니, 그 키는 발급처에서 새로 만들고 예전 키는 폐기해요.",
          "이 앱에서 다시 점검을 눌러 사라졌는지 확인해요.",
        ],
        prompt: `${path} 의 ${at}에 토큰이나 키로 보이는 값이 있어요. 값은 이 요청에 적지 않았어요. 그 파일을 읽지 말고, 값을 안전하게 치우는 순서(지우기, 키 새로 발급받기, 이미 새어 나갔는지 확인하기)만 짧게 알려 줘.`,
      };
    }

    case "duplicate-rule": {
      const paths = es.map((x) => x.item.path ?? x.item.name);
      return {
        steps: [
          `같은 줄이 있는 파일들을 열어요: ${list(paths)}`,
          "그 규칙을 남길 곳 하나를 정해요. 모든 작업에 해당하는 규칙이면 전역 CLAUDE.md 가 좋아요.",
          "나머지 파일에서는 그 줄을 지우거나 '어디를 보라'는 한 줄로 바꿔요.",
        ],
        prompt: `${list(paths, 10)} 에 같은 규칙이 겹쳐 적혀 있어요(${f.evidence}). 한 곳에만 남기고 나머지는 지우거나 그곳을 가리키는 한 줄로 바꿔 줘. 고치기 전에 어느 파일에 남길지 먼저 제안해 줘.`,
      };
    }

    case "duplicate-name": {
      const where = es.map((x) => (x.item.source.type === "plugin" ? `플러그인 ${x.item.source.plugin}` : (x.item.path ?? "개인 설정")));
      const kind = KIND_WORD[e?.item.kind ?? "skill"];
      return {
        steps: [
          `같은 이름 "${e?.item.name}" 이 있는 곳을 확인해요: ${list(where)}`,
          "이 앱에서 각 항목을 눌러 어느 쪽이 실제로 쓰였는지 사용 횟수를 봐요.",
          "안 쓰는 쪽이 플러그인 것이면 /plugin 에서 그 플러그인을 끄고, 개인 것이면 폴더나 파일 이름을 바꿔요.",
        ],
        prompt: `${kind} "${e?.item.name}" 이 ${list(where, 10)} 여러 곳에 있어서 부를 때 헷갈릴 수 있어요. 두 파일 내용을 비교해 주고, 안 쓰는 쪽을 끄거나 이름을 바꾸는 방법을 제안해 줘.`,
      };
    }

    case "similar-description": {
      const [A, B] = es;
      const plugin = A?.item.source.type === "plugin" && B?.item.source.type === "plugin";
      if (plugin) {
        return {
          steps: [
            `비슷한 두 작업 설명서: ${A.item.name}, ${B.item.name}`,
            PLUGIN_FILE_NOTE,
            `둘 다 잘 안 쓰면 그대로 둬도 돼요. 자주 헷갈린다면 플러그인 ${A.item.source.plugin} 을 만든 사람에게 알려요.`,
          ],
          prompt: `플러그인 ${A.item.source.plugin} 의 작업 설명서 ${A.item.name}(${A.item.path}) 와 ${B.item.name}(${B.item.path}) 의 설명이 거의 같아서 AI가 잘못 고를 수 있어요. 두 파일을 읽고, 만든 사람에게 보낼 짧은 개선 제안(각 설명에 언제 쓰는지 차이를 어떻게 적으면 좋을지)을 써 줘. 파일은 고치지 마.`,
        };
      }
      return {
        steps: [
          `두 작업 설명서의 설명을 나란히 봐요: ${A?.item.path}, ${B?.item.path}`,
          "각 파일 맨 위 description 첫 문장에 '언제 쓰는지'를 적어 둘의 차이가 드러나게 해요.",
        ],
        prompt: `작업 설명서 ${A?.item.path} 와 ${B?.item.path} 의 설명(description)이 거의 같아서 AI가 잘못 고를 수 있어요. 두 파일을 읽고 언제 어느 쪽을 쓰는지 차이가 드러나게 description 을 고쳐 줘.`,
      };
    }

    case "missing-description": {
      const paths = es.map((x) => x.item.path ?? x.item.name);
      const plugin = e?.item.source.type === "plugin";
      return {
        steps: [
          `설명이 없는 파일: ${list(paths)}`,
          ...(plugin ? [PLUGIN_FILE_NOTE, "플러그인을 만든 사람에게 알려요."] : ["각 파일 맨 위 --- 사이에 `description: 언제 쓰는지 한 문장` 줄을 넣어요."]),
        ],
        prompt: plugin
          ? `플러그인 ${e?.item.source.plugin} 의 ${list(paths, 10)} 에 description 이 없어요. 만든 사람에게 보낼 짧은 제보 문구를 써 줘. 파일은 고치지 마.`
          : `${list(paths, 20)} 파일 맨 위 frontmatter 에 description 이 없어요. 본문을 읽고 언제 쓰는지 한 문장으로 description 을 넣어 줘.`,
      };
    }

    case "unused-plugin": {
      const p = ctx.plugins.find((x) => x.item.id === e?.item.id);
      const name = p?.name ?? e?.item.name ?? "";
      const key = p?.key ?? name;
      return {
        steps: disableSteps(name),
        command: `claude plugin disable ${key}`,
        prompt: `Claude Code 플러그인 ${key} 를 꺼 줘. 지우지 말고 끄기만 하고, 다시 켜는 방법도 알려 줘.`,
      };
    }

    case "unused-items": {
      const src = e?.item.source;
      const names = es.map((x) => x.item.name);
      if (src?.type === "plugin") {
        const p = pluginOf(e);
        const total = ctx.entries.filter((x) => x.pluginKey === e?.pluginKey && x.item.enabled && ["skill", "agent", "command"].includes(x.item.kind)).length;
        const mostly = total > 0 && names.length / total >= 0.8;
        return {
          steps: [
            `안 쓴 항목: ${list(names)}`,
            "플러그인 안의 작업 설명서나 에이전트는 하나씩 끌 수 없어요.",
            mostly
              ? `${total}개 중 ${names.length}개를 안 써서, 거의 안 쓰는 플러그인이에요. 꺼 두면 대화마다 차지하는 양이 줄어요: /plugin → Installed → ${p?.name ?? src.plugin} → Disable`
              : "자주 쓰는 것이 섞여 있으니 그대로 둬도 괜찮아요.",
          ],
          ...(mostly && p ? { command: `claude plugin disable ${p.key}` } : {}),
          prompt: `플러그인 ${p?.key ?? src.plugin} 에서 한 달 동안 안 쓴 항목이 ${names.length}/${total}개예요(${list(names, 30)}). 이 플러그인을 계속 켜 둘지 판단할 수 있게 각 항목이 무슨 일을 하는지 한 줄씩 정리해 줘.`,
        };
      }
      const paths = es.map((x) => x.item.path ?? x.item.name);
      return {
        steps: [
          `안 쓴 항목: ${list(paths)}`,
          "지우지 말고 ~/.claude 안의 보관 폴더(예: ~/.claude/off/)로 옮기면 목록에서 빠져요.",
          "다시 쓰고 싶으면 원래 자리로 옮기면 돼요.",
          RESTART,
        ],
        prompt: `한 달 동안 안 쓴 개인 항목 ${list(paths, 30)} 를 지우지 말고 ~/.claude/off/ 아래로 같은 폴더 구조로 옮겨서 꺼 줘. 옮긴 목록과 되돌리는 방법을 알려 줘.`,
      };
    }

    case "long-skill": {
      const chars = e?.body?.length ?? e?.item.size.chars ?? 0;
      const pages = a4(e?.item.size.tokens ?? 0);
      if (e?.item.source.type === "plugin") {
        return {
          steps: [
            PLUGIN_FILE_NOTE,
            `잘 안 쓰는 작업 설명서라면 그대로 둬도 돼요. 부를 때만 읽기 때문이에요.`,
            `자주 쓰는데 느리다면 플러그인 ${e.item.source.plugin} 을 만든 사람에게 알려요.`,
          ],
          prompt: `플러그인 ${e.item.source.plugin} 의 작업 설명서 ${path} 가 ${chars.toLocaleString("en-US")}자로 길어서 부를 때마다 A4 약 ${pages}쪽을 읽어요. 파일을 읽고, 만든 사람에게 보낼 개선 제안(어떤 부분을 별도 파일로 빼면 좋은지)을 짧게 써 줘. 파일은 고치지 마.`,
        };
      }
      return {
        steps: [
          `${path} 파일을 열어요.`,
          "자주 쓰지 않는 상세 규칙이나 예시를 같은 폴더의 references/ 아래 별도 파일로 옮겨요.",
          "본문에는 핵심 순서와 '자세한 건 references/파일.md 를 읽어라'는 한 줄만 남겨요.",
        ],
        prompt: `${path} 작업 설명서가 ${chars.toLocaleString("en-US")}자로 길어서 부를 때마다 A4 약 ${pages}쪽을 읽어요. 규칙은 하나도 빼지 말고, 상세 내용과 예시는 같은 폴더 references/ 의 별도 파일로 옮기고 본문에는 핵심 순서와 그 파일을 읽으라는 안내만 남겨 줘. 바꾸기 전에 백업해 줘.`,
      };
    }

    case "slow-hook":
    case "failing-hook": {
      const h = e?.item.hook;
      const cmd = h?.command ?? "";
      const p = pluginOf(e);
      const slow = f.rule === "slow-hook";
      if (p) {
        return {
          steps: [
            `플러그인 ${p.name} 에 들어 있는 규칙이에요. ${PLUGIN_FILE_NOTE}`,
            slow ? "자주 안 쓰는 플러그인이면 꺼서 기다림을 없애요." : "한 번만 실패했고 지금 잘 돈다면 그냥 둬도 돼요.",
            ...disableSteps(p.name).slice(0, 3),
          ],
          command: `claude plugin disable ${p.key}`,
          prompt: slow
            ? `플러그인 ${p.key} 의 자동 실행 규칙(훅) "${cmd}" 이 평균 ${sec(h?.avgMs ?? 0)}초, 최대 ${sec(h?.maxMs ?? 0)}초 걸려요. 이 플러그인을 끄면 어떤 기능이 없어지는지 알려 주고, 만든 사람에게 보낼 짧은 제보 문구를 써 줘.`
            : `플러그인 ${p.key} 의 자동 실행 규칙(훅) "${cmd}" 이 최근 ${h?.failures30 ?? 0}번 실패했어요. 원인을 찾아 주고, 만든 사람에게 보낼 짧은 제보 문구를 써 줘. 플러그인 파일은 고치지 마.`,
        };
      }
      const runnable = cmd && !cmd.includes("${");
      return {
        steps: slow
          ? [
              `이 규칙은 ${path} 의 hooks 에 들어 있어요.`,
              `실행 명령: ${cmd}`,
              "필요 없는 규칙이면 그 항목을 지우고, 필요하면 오래 걸리는 부분을 줄여요.",
              RESTART,
            ]
          : [
              "터미널을 열어요. Windows는 PowerShell, Mac은 터미널 앱이에요.",
              runnable ? "아래 명령을 붙여 넣고 실행해서 어떤 오류가 나오는지 봐요." : `실행 명령(${cmd})에 Claude Code가 채우는 값이 들어 있어서 직접 실행하기 어려워요. 아래 요청문으로 Claude에게 맡겨요.`,
              "파일이 없다는 오류면 경로를, 명령을 못 찾는다는 오류면 bun이나 node 설치를 확인해요.",
              "한 번만 실패했고 지금 잘 돈다면 그냥 둬도 돼요.",
            ],
        ...(runnable && !slow ? { command: cmd } : {}),
        prompt: slow
          ? `Claude Code 자동 실행 규칙(훅) "${cmd}" 이 평균 ${sec(h?.avgMs ?? 0)}초, 최대 ${sec(h?.maxMs ?? 0)}초 걸려요. 설정은 ${path} 에 있어요. 무엇이 오래 걸리는지 찾아서 빠르게 하는 방법을 제안해 줘. 고치기 전에 먼저 보여 줘.`
          : `Claude Code 자동 실행 규칙(훅) "${cmd}" 이 최근 ${h?.failures30 ?? 0}번 실패했어요. 설정은 ${path} 에 있어요. 명령을 직접 실행해 보고 원인을 찾아 줘. 고치기 전에 원인부터 알려 줘.`,
      };
    }
  }
  return { steps: [f.fix], prompt: `${f.title}. ${f.fix}` };
}
