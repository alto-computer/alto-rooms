<!-- rooms-onboarding v1 -->
# Rooms 온보딩 (에이전트용)

Rooms는 HTML 아티팩트를 주제별 방(폴더)에 모아 보여주는 앱이다. 방은 Home 아래의 폴더 하나이고, 원본을 옮기지 않고 원본을 가리키는 파일 링크(심볼릭 링크)로 넣는다.

## 0. Home 정하기

- 이 파일(`ONBOARD.md`)이 있는 폴더가 Home이다. 기본은 `~/rooms`.
- 아래 명령의 `~/rooms`는 모두 실제 Home 경로로 바꿔 쓴다.

## 1. 스킬 설치

내가 어떤 에이전트인지 확인하고, 해당하는 명령 하나만 실행한다.

- Claude Code:

  ```sh
  mkdir -p ~/.claude/skills
  cp -R ~/rooms/.rooms/onboarding/skill/rooms ~/.claude/skills/rooms
  ```

- Codex:

  ```sh
  mkdir -p ~/.codex/skills
  cp -R ~/rooms/.rooms/onboarding/skill/rooms ~/.codex/skills/rooms
  ```

- 그 밖의 에이전트: 사용자에게 스킬 폴더 위치를 묻고 같은 방식으로 복사한다. 스킬 기능이 없으면 복사하지 말고 `~/rooms/.rooms/onboarding/skill/rooms/SKILL.md`를 직접 읽고 따른다.

## 2. 이미 설치된 스킬이 있을 때

복사하기 전에 대상 폴더(예: `~/.claude/skills/rooms`)가 이미 있는지 확인한다. 있으면 표시를 본다.

```sh
grep -m1 'rooms-onboarding v' ~/.claude/skills/rooms/SKILL.md
grep -m1 'rooms-onboarding v' ~/rooms/.rooms/onboarding/skill/rooms/SKILL.md
```

- 표시가 없다: 사용자가 만든 다른 스킬일 수 있다. **바꾸지 말고 먼저 묻는다.** "예"일 때만 교체한다.
- 표시가 있고 버전이 원본보다 낮거나 같다: 묻지 않고 교체한다.
- 표시의 버전이 원본보다 높다: 그대로 둔다.

교체는 지우고 다시 복사한다 (`cp -R`은 이미 있는 폴더 안에 한 겹 더 만들기 때문).

```sh
rm -rf ~/.claude/skills/rooms
cp -R ~/rooms/.rooms/onboarding/skill/rooms ~/.claude/skills/rooms
```

## 3. 정리 시작

설치한 `SKILL.md`의 "처음 정리 / 다시 정리" 절을 따른다. `find_html.py`에는 반드시 `--home <Home 경로>`를 넘긴다.

## 지킬 것

- 원본 파일은 옮기지도, 고치지도, 지우지도 않는다.
- `~/rooms/.rooms` 안은 스킬 원본을 읽는 것 말고는 건드리지 않는다.
