# 번역 문체 지침

`catalog/ko.json`의 모든 항목은 이 지침과 `catalog/glossary.json`을 따릅니다. `bun tools/catalog.ts check`가 기계적으로 잡을 수 있는 규칙은 검사합니다.

## 문체

| 종류 | 형태 | 예 |
|---|---|---|
| 버튼, 메뉴, 탭, 표 머리글, 설정 이름, 칩 | 명사형, 짧게 | `Close` → `닫기`, `Dark Theme` → `어두운 테마` |
| 켜고 끄는 동작 | `… 켜기/끄기` | `Toggle plan mode` → `계획 모드 켜기/끄기` |
| 설명(설정 설명, 슬래시 명령 설명, 도움말) | 합니다체 서술문 | `Start a new session` → `새 세션을 시작합니다` |
| 완료 알림 | 합니다체 과거형 | `Session saved.` → `세션을 저장했습니다.` |
| 오류 | `…할 수 없습니다`, `…하지 못했습니다` | `Failed to read clipboard` → `클립보드를 읽지 못했습니다` |
| 진행 중 | `…하는 중…` | `Loading…` → `불러오는 중…` |
| 질문 | `…하시겠습니까?` | `Discard changes?` → `변경 사항을 버리시겠습니까?` |
| 입력창 안내문 | 명사형 또는 합니다체 질문 | `Search models…` → `모델 검색…` |

- 해요체(`…해요`)와 해라체(`…한다.`)는 쓰지 않습니다.
- 마침표는 원문을 따릅니다. 원문 끝에 `.`이 있으면 붙이고, 없으면 붙이지 않습니다. 말줄임표는 `…` 한 글자로 씁니다.
- 직역투를 피합니다: `…에 의해`, `…를 가지고 있습니다`, `…하는 것을 허용합니다`(→ `…할 수 있습니다`), 불필요한 피동(`…되어집니다`).
- 띄어쓰기는 표준 맞춤법을 따릅니다(`할 수 있습니다`, `다시 시도`, `불러오는 중`).

## 영어로 두는 것

- 고유명사와 약어: `glossary.json`의 `keep` 목록(omp, Tern, Git, MCP, LSP, API, JSON …).
- 도구 이름과 역할 이름: `Read`, `Bash`, `Edit`, `default`, `slow`, `smol` 같은 값은 카탈로그에 넣지 않습니다(`untranslated` 목록).
- 사용자가 그대로 입력하는 것: 슬래시 명령(`/plan`), 플래그(`--model`), 설정 키(`statusLine.preset`), 환경 변수(`$EDITOR`), 파일 이름과 경로, 단축키(`Ctrl+P`, `esc`), 모델 이름, 단위(`ms`, `tok/s`, `K`).
- 백틱으로 감싼 코드(`` `omp -c` ``)는 글자 그대로 둡니다.

## 자리표시자

- 템플릿의 `{0}`, `{1}` …은 모두 그대로 옮기되, 한국어 어순에 맞게 자리를 바꿔도 됩니다.
- 영어 복수형 꼬리(`file{1}`의 `{1}` = `s`)처럼 한국어에 필요 없는 자리표시자는 빼도 됩니다.
- 자리표시자 바로 뒤에 조사를 붙이지 않도록 문장을 바꿉니다(`Deleted {0}` → `삭제함: {0}` 또는 `{0} 삭제를 마쳤습니다`). 피할 수 없으면 `을(를)`, `이(가)`, `은(는)`, `(으)로`를 씁니다.
- 새 자리표시자를 만들지 않습니다.

## 폭

한글은 터미널에서 두 칸을 차지합니다. 상태 줄 조각, 키 힌트, 표 머리글, 칩처럼 좁은 자리에 들어가는 짧은 문구는 원문보다 눈에 띄게 길어지지 않게 줄입니다.

## 용어

`glossary.json`의 `terms`를 따릅니다. 자주 쓰는 것:

| 영어 | 한국어 |
|---|---|
| session / model / context | 세션 / 모델 / 컨텍스트 |
| compaction, compact | 압축 |
| agent / subagent / advisor | 에이전트 / 서브에이전트 / 어드바이저 |
| plugin / extension / skill | 플러그인 / 확장 / 스킬 |
| provider | 제공자 |
| thinking level, reasoning effort | 추론 강도 |
| thinking (블록) | 생각 |
| tool / tool call | 도구 / 도구 호출 |
| transcript / composer / status line | 대화 기록 / 입력창 / 상태 줄 |
| steer / follow-up / queue | 중간 지시 / 후속 메시지 / 대기열 |
| job, task | 작업 |
| usage / quota / limit | 사용량 / 할당량 / 한도 |
| workspace / directory | 작업 영역 / 디렉터리 |
| pane / block / tab / window | 패널 / 블록 / 탭 / 창 |
| enable / disable (동작) | 켜기 / 끄기 |
| enabled / disabled (상태) | 켜짐 / 꺼짐 |
| retry (버튼) | 다시 시도 |
| resume (세션) | 이어서 하기 |
