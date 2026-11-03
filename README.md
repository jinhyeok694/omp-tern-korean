# omp-tern-korean

[omp](https://github.com/can1357/oh-my-pi)(oh-my-pi)와 [Tern](https://stencil.so/tern)의 화면 문구를 자연스러운 한국어로 바꾸는 플러그인입니다. 설치한 뒤에는 손댈 일이 없도록 만들었습니다. omp가 업데이트되어도 대부분의 번역이 그대로 동작하고, 새로 추가된 번역은 하루에 한 번 자동으로 받아 옵니다.

*Korean localization for the omp coding agent and the Tern terminal.*

## 설치

```sh
omp plugin marketplace add jinhyeok694/omp-tern-korean
omp plugin install omp-tern-korean@omp-tern-korean
```

omp를 다시 시작하면 바로 적용됩니다. Tern 안에서 omp를 실행하면 Tern 쪽 플러그인(`ko-kr`)도 자동으로 연결됩니다. Tern 쪽만 따로 쓰려면 다음 명령으로 설치합니다.

```sh
tern plugin install github.com/jinhyeok694/omp-tern-korean/tern-plugin
```

omp 18.11.0 이상이 필요합니다. omp 18.15–18.16, Tern 0.9.9(Windows)에서 확인했습니다.

## 무엇이 바뀌나

| 화면 | Tern 안의 omp | 일반 터미널의 omp |
|---|---|---|
| 입력창 안내문, 상태 줄, 단축키 창, 모델 선택 창, 각종 대화상자와 알림 | ✓ | – |
| `/settings`의 항목 이름과 설명 | ✓ | ✓ |
| 슬래시 명령 설명 | ✓ | ✓ |
| 대화 내용, 코드, 도구 출력, 입력한 글 | 바꾸지 않음 | 바꾸지 않음 |
| omp가 만드는 세션 제목, 자리 비운 뒤 요약 | 한국어로 요청 | 한국어로 요청 |
| Tern 명령 팔레트 | 한국어 명령 행 추가, 범위 탭과 탭 막대 글자 교체 | – |
| Tern 화면 글꼴 | Pretendard (설치되어 있을 때) | – |

- **대화 내용은 건드리지 않습니다.** 모델이 쓴 글, 코드, 도구 출력, 입력창에 쓴 글은 그대로 둡니다. 화면에 표시할 때만 바꾸고, 세션 기록과 모델에게 보내는 내용은 영어 그대로입니다.
- **영어로 두는 것:** 도구 이름(`Read`, `Bash`), 역할 이름(`default`, `slow`, `smol`), 모델 이름, 슬래시 명령, 설정 키, 단축키처럼 사용자가 그대로 입력하는 값은 영어로 둡니다.
- **세션 제목과 요약:** omp가 첫 응답에서 갈라 만드는 세션 제목과, 자리를 비웠다 돌아왔을 때 보여 주는 요약을 한국어로 써 달라고 모델에게 요청합니다. 그 요청에만 한 줄을 더하고, 대화와 다른 요청은 건드리지 않습니다. 첫 응답에서 제목을 만들지 못해 작은 제목 전용 모델로 넘어가는 경우에는 영어로 나올 수 있습니다.
- **글꼴:** Tern 화면의 UI 글꼴을 [Pretendard](https://github.com/orioncactus/pretendard)로 바꿉니다(Pretendard, Pretendard Variable, Pretendard GOV, Pretendard JP 중 설치된 것). Tern 플러그인은 글꼴 파일을 불러올 수 없어서 시스템에 설치되어 있어야 하고, 없으면 원래 글꼴로 그립니다. 터미널 격자와 코드에 쓰는 고정폭 글꼴은 바꾸지 않습니다. 팔레트의 `Pretendard 글꼴 켜기/끄기`로 끌 수 있습니다.
- **Tern 명령 팔레트:** Tern에는 내장 명령의 이름을 바꾸는 방법이 없어서, 같은 명령을 실행하는 한국어 행을 "한국어" 묶음에 더합니다. 한국어로 검색하면 한국어 행만, 영어로 검색하면 원래 행만 나옵니다. 팔레트에서 `한국어 명령 행 켜기/끄기`로 끌 수 있습니다.

## 사용

| 명령 | 하는 일 |
|---|---|
| `/ko` | 번역 상태, 카탈로그 revision, 업데이트와 Tern 연결 상태를 보여 줍니다 |
| `/ko on`, `/ko off`, `Ctrl+Alt+K` | 번역을 켜고 끕니다 |
| `/ko update` | 새 번역을 바로 받습니다 |
| Tern 팔레트 `한국어 번역: 새 번역 받기` | Tern 쪽 번역을 바로 받습니다 |

## 업데이트

- **번역:** omp 쪽과 Tern 쪽이 각각 하루에 한 번 이 저장소의 `catalog/ko.json`, `tern-plugin/ko.json`을 받습니다(`If-None-Match`로 바뀐 경우에만 내려받습니다). 받은 번역표의 `revision`이 플러그인에 들어 있는 것보다 높을 때만 씁니다. 저장 위치는 `~/.omp/agent/cache/omp-tern-korean/`와 Tern 플러그인 데이터 폴더입니다.
- **코드:** omp 설정 `marketplace.autoUpdate: auto`를 켜 두면 omp가 시작할 때 플러그인도 업그레이드합니다. 업그레이드로 플러그인 폴더가 바뀌면 다음 실행 때 Tern 쪽 연결을 새 폴더로 옮깁니다.

## 환경 변수

| 변수 | 뜻 |
|---|---|
| `OMP_KO_UPDATE=0` | 번역 자동 업데이트를 끕니다 |
| `OMP_KO_CATALOG_URL` | 번역표를 받을 주소를 바꿉니다 |
| `OMP_KO_TERN=0` | Tern 쪽 플러그인을 자동으로 연결하지 않습니다 |
| `OMP_KO_PROMPTS=0` | 세션 제목과 요약을 한국어로 요청하지 않습니다 |
| `OMP_KO_CAPTURE=<파일>` | 번역이 없는 화면 문구를 모아 JSON 배열로 씁니다(번역표를 만들 때) |
| `OMP_KO_DUMP=<파일>` | omp가 Tern에 보낸 원본 화면 프레임을 기록합니다(디버깅용) |

## 한계

- **Tern 자체 화면:** Tern의 설정 화면, 대화상자, 토스트, 툴팁, 내장 명령 이름은 Tern 바이너리에 들어 있어 플러그인으로 바꿀 수 없습니다([tern-sdk#54](https://github.com/stencil-hq/tern-sdk/issues/54)).
- **일반 터미널:** omp가 화면을 직접 그리므로 설정과 슬래시 명령 설명만 번역합니다.
- **`omp --help`와 하위 명령 출력:** 확장이 불러와지기 전에 출력되므로 영어로 나옵니다.
- **조각난 문장:** omp가 여러 조각을 이어 붙여 만드는 문장은 조각마다 번역하므로 어순이 어색할 수 있습니다. 런타임 값(예: `enabled`)이 들어가는 문장은 일부가 영어로 남을 수 있습니다.
- **동작 방식:** omp에는 공식 번역 기능이 없어서, omp가 Tern에 보내는 화면 데이터(Tern Surface Protocol)를 omp 내부의 `ProcessTerminal.prototype.write`에서 받아 바꿉니다. 이 지점이 사라지면 번역은 스스로 꺼지고 영어로 보입니다.

## 번역에 참여하기

번역 원칙은 [`catalog/STYLE.md`](catalog/STYLE.md), 용어는 [`catalog/glossary.json`](catalog/glossary.json)에 있습니다. [Bun](https://bun.sh)이 필요합니다. Bun이 없으면 `BUN_BE_BUN=1 omp`를 `bun` 대신 쓸 수 있습니다.

```sh
bun install
bun tools/extract-omp.ts           # 최신 omp에서 화면 문구를 뽑아 catalog/source.json에 씁니다
bun tools/extract-tern.ts          # Tern 팔레트 명령을 tern-plugin/source.json에 씁니다
bun tools/catalog.ts coverage      # 번역이 없는 문구를 셉니다
bun tools/catalog.ts slice --count 4 --out work   # 번역할 문구를 나눕니다
bun tools/catalog.ts check work/slice-01.out.json # 번역을 검사합니다
bun tools/catalog.ts merge work/*.out.json        # catalog/ko.json에 합치고 revision을 올립니다
bun test
```

- 번역 파일 형식은 `{ "translations": { "<영어>": "<한국어>" }, "skip": ["<영어>"] }`입니다. `skip`에는 화면에 나오지 않는 문구를 넣습니다(`catalog/skip.json`에 모입니다).
- 번역표를 바꾸면 `revision`을 올려야 합니다(`merge`가 올려 주고, 직접 고쳤다면 `bun tools/catalog.ts bump`). CI가 검사합니다.
- omp 새 버전이 나오면 GitHub Actions가 문구를 다시 뽑아, 번역이 없는 문구 목록을 담은 PR을 엽니다.

## 라이선스

[MIT](LICENSE). 번역의 원문인 omp의 화면 문구는 [oh-my-pi](https://github.com/can1357/oh-my-pi)(MIT)에서 가져왔습니다.
