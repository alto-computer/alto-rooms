<!-- rooms-onboarding v2 -->
# Rooms 온보딩 (에이전트용)

Rooms는 HTML 아티팩트를 주제별 방(폴더)에 모아 보여주는 앱이다. 방은 Home 아래의 폴더 하나이고, 원본을 옮기지 않고 원본을 가리키는 파일 링크(심볼릭 링크)로 넣는다.

## 0. 경로 정하기

- 이 파일(`ONBOARD.md`)이 있는 폴더가 Home이다. 기본은 `~/rooms`.
- 아래 명령의 `<home>`은 Home의 **절대 경로**로 바꿔 쓴다 (예: `/Users/me/rooms`). `~`를 쓰지 않는다: 따옴표 안의 `~`는 펼쳐지지 않는다.
- `<스킬 폴더>` = 스킬을 설치할 곳. 내가 어떤 에이전트인지 확인하고 하나만 고른다.
  - Claude Code: `$HOME/.claude/skills/rooms`
  - Codex: `$HOME/.codex/skills/rooms`
  - 그 밖의 에이전트: 사용자에게 스킬 폴더 위치를 묻는다. 스킬 기능이 없으면 설치하지 말고 §2로 가서 `<home>/.rooms/onboarding/skill/rooms/SKILL.md`를 직접 읽고 따른다.
- `$HOME`은 따옴표 안에서도 펼쳐진다.

## 1. 스킬 설치

위에서 아래로 순서대로 한다. 1-1과 1-2를 마치기 전에는 아무것도 복사하지 않는다.

### 1-1. 이미 있는지 확인

```sh
if [ -e "<스킬 폴더>" ] || [ -L "<스킬 폴더>" ]; then echo 있음; else echo 없음; fi
grep -m1 -o 'rooms-onboarding v[0-9]*' "<스킬 폴더>/SKILL.md"
grep -m1 -o 'rooms-onboarding v[0-9]*' "<home>/.rooms/onboarding/skill/rooms/SKILL.md"
```

둘째 줄은 설치된 스킬의 표시, 셋째 줄은 원본의 표시다.

### 1-2. 정하기

- **없음**: 1-3의 "새로 설치".
- **있음, 표시 없음** (둘째 줄이 아무것도 출력하지 않는다): 사용자가 만든 다른 스킬일 수 있다. **바꾸지 말고 먼저 묻는다.** "예"일 때만 1-3의 "교체". 아니면 설치하지 않고 §2에서 원본 `SKILL.md`를 직접 읽고 따른다.
- **있음, 표시의 버전이 원본보다 낮거나 같다**: 묻지 않고 1-3의 "교체".
- **있음, 표시의 버전이 원본보다 높다**: 그대로 두고 §2로 간다.

### 1-3. 복사

새로 설치:

```sh
mkdir -p "$(dirname "<스킬 폴더>")"
cp -R "<home>/.rooms/onboarding/skill/rooms" "<스킬 폴더>"
```

교체 (`cp -R`은 이미 있는 폴더 안에 한 겹 더 만들기 때문에 먼저 지운다):

```sh
rm -rf "<스킬 폴더>"
cp -R "<home>/.rooms/onboarding/skill/rooms" "<스킬 폴더>"
```

## 2. 정리 시작

설치한 `SKILL.md`(설치하지 않았다면 원본 `SKILL.md`)의 "처음 정리 / 다시 정리" 절을 따른다. `find_html.py`에는 반드시 `--home "<home>"`을 넘긴다.

## 지킬 것

- 원본 파일은 옮기지도, 고치지도, 지우지도 않는다.
- `<home>/.rooms` 안은 스킬 원본을 읽는 것 말고는 건드리지 않는다.
