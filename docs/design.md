# Claude 설정 점검 (claude-checkup) 설계

작성 2026-11-01.
브레인스토밍 시안: hearth-map-modal-v8, agents-drilldown-v9 (Hearth DS).

## 1. 왜 만드나

Claude Code에 스킬·에이전트·메모리·훅·플러그인을 몇 달 쌓으면 세 가지를 알 수 없게 된다.

1. 만든 것이 실제로 의도대로 쓰이는가.
2. 같은 규칙이 여러 곳에 겹치거나, 길어서 잘려 동작하지 않는 곳이 있는가.
3. 쓰지 않는데 매 대화 컨텍스트를 차지하는 것이 있는가.

이 서비스는 그 PC 안의 기록만으로 위 세 가지를 한 화면에서 보여 주고 진단한다.
대상은 AI에 익숙하지 않은 Claude Code 사용자다.

## 2. 목표와 비목표

목표
- 전체 현황: 설정 묶음을 노드와 선으로 그린 지도, 맨 위 요약(대화마다 미리 채워지는 양과 그중 안 쓴 양).
- 세부: 묶음 노드를 누르면 개별 항목이 출처(플러그인·개인·기본 제공)별로 펼쳐진다. 항목을 누르면 모달(요약·연결·원문·사용)이 열린다.
- 진단 결과: 문제를 심각한 순서로 모아 무엇이, 왜, 어떻게 고치나를 쉬운 말로 보여 준다.
- 검색: 이름으로 바로 항목 모달을 연다.
- 실행: 단일 실행 파일을 더블클릭하면 로컬 서버가 뜨고 브라우저가 열린다.

비목표 (1차)
- 설정을 자동으로 고치거나 지우기. 진단과 제안까지만 한다.
- Codex, Cursor 등 다른 도구. 2차.
- 사용자 고유 하네스(triggers.json 등) 해석. 2차. 1차는 Claude Code 표준 구조만 읽는다.
- 라우팅 시험("AI가 제때 골라 쓰나요?"). 2차. 화면에는 자리와 설명만 둔다.

반목표 (이러면 실패)
- 설정·대화 기록을 PC 밖으로 보낸다.
- 비밀값(토큰, API 키, 환경변수 값)을 읽거나 화면에 보여 준다.
- 근거 없는 숫자를 단정한다. 추정치는 "약", "추정"으로 표시한다.

## 3. 용어 (화면 표기)

그대로 쓰는 말: 에이전트, 메모리, 하네스, 컨텍스트, .claude, CLAUDE.md, MEMORY.md, 플러그인.
바꿔 쓰는 말: 스킬 = 작업 설명서, 훅 = 자동 실행 규칙, MCP 서버 = 연결된 서비스, 토큰 = A4 몇 쪽(추정), 슬래시 명령 = 직접 부르는 명령.
모달 위쪽에 "원래 이름: 스킬(Skill)"처럼 원래 용어를 작게 남긴다.
어투는 해요체.

## 4. 데이터 출처 (읽기 전용)

`HOME` = 사용자 홈. `C` = `HOME/.claude`.

| 대상 | 위치 |
|---|---|
| 전역 지시문 | `C/CLAUDE.md` 와 그 안의 `@경로` import |
| 프로젝트 지시문 | `HOME/.claude.json` 의 `projects` 키 경로 중 실제 있는 폴더의 `CLAUDE.md`, `AGENTS.md` |
| 메모리 | `C/projects/*/memory/MEMORY.md` 와 같은 폴더 `*.md`, `C/memory/*.md` |
| 개인 스킬 | `C/skills/*/SKILL.md` |
| 개인 명령 | `C/commands/*.md` |
| 개인 에이전트 | `C/agents/*.md` |
| 플러그인 | `C/plugins/installed_plugins.json` 의 `installPath`, 켜짐 여부는 `C/settings.json` 의 `enabledPlugins`. 플러그인 안 `skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json` |
| 훅 | `C/settings.json` 의 `hooks`, 플러그인 `hooks/hooks.json` |
| 연결된 서비스 | `HOME/.claude.json` 의 `mcpServers`(전역)와 `projects.*.mcpServers`, 플러그인 `.mcp.json`. 이름만 읽고 `env`, `headers`, `args` 값은 읽지 않는다 |
| 기본 제공 에이전트 | 고정 목록: general-purpose, Explore, Plan, statusline-setup, claude-code-guide |
| 기록에만 있는 항목 | 최근 30일 대화 기록에 쓰인 작업 설명서·에이전트 이름 중 위 어디에도 파일이 없는 것. 출처 `history`("기록에만 있음"). Claude Code 기본 내장, 지운 항목, 이름이 바뀐 항목을 가르지 않는다. `플러그인:이름` 꼴은 만들지 않는다 |
| 대화 기록 | `C/projects/**/*.jsonl` (하위 `subagents/` 포함) |

읽지 않는 파일: 이름에 `credential`, `token`, `secret`, `auth`, `.env`, `.pem`, `.key` 가 들어간 파일 전부.

## 5. 측정 정의

기간: 실행 시점 기준 최근 30일(`window`). 대화 기록 줄의 `timestamp` 로 거른다.

대화 기록 한 줄은 JSON이다.
먼저 부분 문자열로 거른 뒤(`"tool_use"`, `<command-name>`, `"hook_success"`, `"hook_additional_context"`, `"type":"user"`) 해당 줄만 `JSON.parse` 한다.
줄이 수 MB일 수 있어 스트리밍으로 읽는다.

| 지표 | 정의 |
|---|---|
| 스킬 사용 | `message.content[]` 중 `type=tool_use`, `name=Skill` 의 `input.skill`. `플러그인:이름` 이면 그 플러그인 스킬, 아니면 개인 스킬 → 플러그인 순으로 이름 매칭. `via.model` |
| 직접 부름 | 사용자 메시지 안 `<command-name>/이름</command-name>`. 스킬·명령 이름과 매칭되면 `via.user` |
| 에이전트 사용 | `name` 이 `Agent` 또는 `Task` 인 tool_use 의 `input.subagent_type`(없으면 general-purpose) |
| 연결된 서비스 사용 | `name` 이 `mcp__<서버>__<도구>` 인 tool_use. 서버 이름으로 매칭(플러그인 서버는 `plugin_<플러그인>_<서버>`) |
| 파일 읽힘 | `name=Read` 의 `input.file_path`. 경로를 소문자·슬래시로 맞추고 `/.claude/` 뒤 부분으로 매칭(8.3 짧은 이름 차이 무시) |
| 훅 실행 | `attachment.type=hook_success` (또는 이름에 hook 과 error 가 든 type). `command`, `durationMs`, `exitCode`. 설정의 훅 command 와 문자열 매칭 |
| 훅이 넣은 양 | `attachment.type=hook_additional_context` 의 `content` 글자 수, `hookEvent` 별 평균 |
| 대화 수 | 30일 안에 줄이 있는 jsonl 파일 수(subagents 제외) |
| 요청 수 | `type=user` 이고 tool_result 가 아닌 사용자 메시지 수 |

캐시: 파일 경로별 `mtime`·`size` 가 같으면 지난 집계를 다시 쓴다. 위치 `HOME/.claude-checkup/cache.json`. 첫 실행은 진행률을 보여 준다.

### 컨텍스트 추정

토큰 추정 = `ceil(ASCII 글자 수 / 4 + 비ASCII 글자 수 / 1.5)`. 화면에는 "약"을 붙인다.
A4 1쪽 = 1,500 토큰으로 환산한다(추정).
컨텍스트 전체 = 200,000 토큰.

대화마다 미리 채워지는 것(`alwaysLoaded`)
- 전역 CLAUDE.md 본문 + import 본문.
- MEMORY.md 앞 200줄(Claude Code가 그 이상은 읽지 않음).
- 켜진 스킬·명령마다 목록 한 줄 `- 이름: 설명`.
- 켜진 에이전트마다 목록 한 줄 `- 이름: 설명`.
- SessionStart 훅이 넣은 글자 수 평균(기록이 있을 때).

"안 쓴 양" = 30일 사용 0회인 항목의 `alwaysLoaded` 합.

## 6. 진단 규칙

심각도: 높음(동작이 깨짐), 중간(헷갈리거나 낭비가 큼), 낮음(정리하면 좋음).

| 규칙 | 조건 | 심각도 |
|---|---|---|
| memory-index-truncated | MEMORY.md 가 200줄 초과. 201줄 이후는 AI가 읽지 못함 | 높음 |
| memory-index-near-limit | MEMORY.md 180~200줄 | 낮음 |
| broken-link | MEMORY.md·메모리 파일의 `[제목](파일.md)` 대상이 없음. `[[이름]]` 은 아직 없는 메모리를 미리 가리켜도 되는 표시라 세지 않고, 있으면 대소문자·`-`/`_` 차이와 frontmatter `name` 으로 찾아 잇기만 한다 | 중간 |
| orphan-memory | 메모리 파일이 MEMORY.md 에 링크로도 이름으로도 없고 다른 메모리에서도 연결 안 됨 | 낮음 |
| duplicate-rule | 정규화한 같은 줄(25자 이상)이 지시문·MEMORY.md 2곳 이상에 있음 | 중간 |
| duplicate-name | 같은 이름의 스킬·에이전트가 출처 2곳 이상에 켜져 있음 | 중간 |
| similar-description | 켜진 스킬 두 개의 설명 단어 집합 Jaccard 0.5 이상 | 낮음 |
| missing-description | 설명이 없는 스킬·에이전트 (AI가 고를 근거가 없음) | 중간 |
| unused-plugin | 켜진 플러그인의 스킬·에이전트·서비스를 30일 동안 하나도 안 썼고 자동 실행 규칙도 안 돌았음 | 중간 |
| unused-items | 켜진 스킬·에이전트 중 30일 0회. 플러그인 단위로 묶어 1건 | 낮음 |
| long-skill | SKILL.md 본문 20,000자 초과 (부를 때마다 많이 읽음) | 낮음 |
| slow-hook | 훅 평균 실행 3초 이상 또는 최대 10초 이상 | 중간 |
| failing-hook | 훅 종료 코드 0이 아닌 실행이 30일 기록에 1회 이상. 3회 이상이면 높음, 그 아래는 중간. Claude Code 는 성공한 실행을 다 기록하지 않아 실패율은 내지 않는다 | 높음·중간 |

진단 결과 화면은 같은 규칙의 진단을 카드 하나로 묶는다. 카드에는 규칙 제목, 걸린 항목 목록(항목별 근거), 왜 중요한가요, 이렇게 고쳐요를 한 번씩 둔다. 항목 모달에서는 그 항목의 진단만 따로 보여 준다.

각 진단은 `title`(무엇이), `why`(왜 중요한지), `fix`(어떻게 고치나), 관련 항목 id, `evidence`(숫자 근거)를 쉬운 말로 가진다.
문구는 기준이지 정답이 아니다. 단정 대신 "~일 수 있어요"를 쓴다.

## 7. 화면

Hearth DS(`~/.claude/skills/my-design`)를 따른다. 토큰·base.css·app.css 를 `src/ui/styles/` 로 복사해 쓴다.

1. 홈
   - 위: 제목, 측정 기간, 다시 점검 버튼, 테마 전환.
   - 요약 카드: "대화를 시작할 때마다 컨텍스트에 A4 약 N쪽이 미리 채워져요. 그중 M쪽은 한 달 동안 안 썼어요." 막대, 진단 배지(높음·중간·낮음 개수), 주 버튼 "진단 결과 보기".
   - 지도: 대화 시작 → 미리 채워지는 묶음(CLAUDE.md, MEMORY.md, 작업 설명서 목록, 에이전트 목록) → 내 요청 → AI가 골라 쓴 것(작업 설명서, 에이전트, 자동 실행 규칙) → AI가 한 일(도구, 연결된 서비스, 메모리 파일). 선 굵기 = 30일 이용량.
2. 묶음 펼침: 묶음 노드를 누르면 열린다. 출처별 카드 묶음, "묶음별 / 많이 쓴 순 / 안 쓴 것만" 전환.
3. 항목 모달: 요약, 사용(30일 막대, 직접/AI 선택), 대화마다 차지하는 양, 연결(부르는 것, 읽는 것, 나를 부르는 곳, 칩 클릭 시 그 항목으로 이동), 원문(서버에서 요청 시 받음), 이 항목의 진단.
4. 진단 결과: 심각도 순 카드 목록. 필터(전체·높음·중간·낮음).
5. 상태: 첫 점검 중(진행률), 실패(원인과 다시 점검), 빈(.claude 폴더 없음 안내).
6. 동의·설정: 첫 실행 동의 화면(8-1절), 설정 모달(통계 켜고 끄기, 보내는 내용 보기).

## 8. 구조

- 런타임: Bun. 언어 TypeScript.
- `src/shared/types.ts`: 스냅샷 규격(유일한 계약).
- `src/scan/`: 순수 함수 스캐너. 입력은 `home` 경로, 출력은 `Snapshot`. 파일시스템만 읽는다.
- `src/server/`: `Bun.serve`, `127.0.0.1` 임의 포트, 시작할 때 만든 무작위 키를 URL 쿼리로 요구. API: `GET /api/snapshot`, `POST /api/rescan`, `GET /api/progress`, `GET /api/item-body?id=`. 정적 UI 제공. 시작하면 기본 브라우저를 연다.
- `src/ui/`: React 19 + TSX, Bun 번들러. Hearth CSS.
- 화면 묶기: 서버가 `import index from "../ui/index.html"` 로 HTML을 가져와 `Bun.serve({ routes })` 에 넣는다. Bun이 번들링하고 `--compile` 때 실행 파일 안에 넣는다.
- 배포: 소스는 GitHub 공개. 사용자는 GitHub Releases 의 운영체제별 단일 실행 파일(`bun build --compile`)을 받는다. 코드 서명은 2차.
- 테스트: `bun test`. 스캐너는 `test/fixtures/home/` 가짜 홈으로 검증(결함 심은 픽스처 포함).

## 8-1. 익명 사용 통계

목적: 다운로드 이후 실제 설치 수, 주간·월간 활성 사용자, 버전·OS 분포, 화면별 사용을 안다.

- 첫 실행 때 동의 화면을 띄운다. "보내기"와 "보내지 않기"는 같은 크기의 버튼이다. 기본 선택은 없다.
- 설정 화면에서 언제든 바꿀 수 있고, "보내는 내용 보기"로 실제 보낼 JSON을 그대로 보여 준다.
- 저장: `HOME/.claude-checkup/settings.json` 의 `telemetry`(`"on" | "off" | null`), `installId`(무작위 UUID, 동의했을 때만 만든다).
- 보내는 것: `installId`, 앱 버전, OS, 이벤트 이름(`launch`, `scan_done`, `view_open`), 화면 이름, 스캔 소요 시간 구간, 항목 수 구간(예: `100-199`).
- 보내지 않는 것: 파일 이름, 경로, 설정 내용, 진단 결과 세부, 대화 기록, 홈 폴더 이름.
- 받는 주소는 빌드 때 상수(`TELEMETRY_URL`)로 넣는다. 비어 있으면 동의와 상관없이 아무것도 보내지 않는다. 받는 서버는 별도 작업이다.
- 전송 실패는 조용히 버린다. 재시도·큐는 두지 않는다.

## 9. 빌더에게 맡기는 것

- 지도 노드 좌표와 선 그리기 방식.
- 진단 문구의 세부 표현(해요체, 짧게).
- 캐시 파일 형식.
