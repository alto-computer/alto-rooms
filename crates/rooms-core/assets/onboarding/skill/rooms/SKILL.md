---
name: rooms
description: "Rooms(HTML 아티팩트를 주제별 방 폴더에 모아 보는 앱)에 아티팩트를 정리한다. 트리거: \"rooms 정리해줘\", \"rooms 다시 정리해줘\", \"~/rooms/ONBOARD.md\" 읽기·따르기, \"방에 정리\", \"방에 넣어줘\", \"Rooms에 넣어줘\", \"inbox에 넣어줘\", 최근 HTML을 방으로 분류, 그리고 HTML 아티팩트를 만들었을 때(.html/.htm 파일을 새로 썼을 때) 알맞은 방에 링크하기. 원본은 옮기지 않고 심볼릭 링크만 만든다."
---
<!-- rooms-onboarding v1 -->

# rooms 스킬

Rooms Home(기본 `~/rooms`)의 폴더 하나가 방 하나다. 아티팩트는 원본을 가리키는 파일 심볼릭 링크로 방에 넣는다. 원본은 그대로 둔다.

## 경로

- `<skill>` = 이 `SKILL.md`가 있는 폴더.
- `<home>` = Rooms Home. 정하는 순서:
  1. `ONBOARD.md`를 읽고 왔다면 그 파일이 있는 폴더.
  2. 사용자가 알려준 경로.
  3. `~/rooms` (안에 `.rooms/`가 있을 때만). 없으면 사용자에게 묻는다.
- 아래 `~/rooms`는 모두 `<home>`으로 바꿔 쓴다.

## 방 이름 규칙

- 짧은 한국어 또는 영어 주제 이름 (예: `브라우저 하네스`, `pricing`).
- 폴더 이름(slug) = 이름을 NFC로 정규화하고 공백을 `-`로 바꾼 것. 예: `브라우저 하네스` → `브라우저-하네스`.
- 금지: `journal`, `inbox`, `.`으로 시작하는 이름, `/`가 든 이름.
- 같은 slug의 폴더 `~/rooms/<slug>`가 이미 있으면 새로 만들지 말고 그 방을 쓴다.
- 단, 연결된 폴더(linked) 방에는 절대 넣지 않는다. 판별: `~/rooms/.rooms/state.json`의 `rooms[]` 중 `"kind": "linked"`인 항목의 `path`. 이 파일은 읽기만 한다.

```sh
python3 -c 'import json,sys; [print(r["name"], r["path"]) for r in json.load(open(sys.argv[1]))["rooms"] if r["kind"]=="linked"]' ~/rooms/.rooms/state.json
```

## 링크 만들기

```sh
mkdir -p ~/rooms/<slug>
ln -s "<원본 절대 경로>" ~/rooms/<slug>/<원본 파일 이름>
```

- 링크 이름 = 원본 파일 이름 그대로.
- 같은 이름이 이미 있으면 확장자 앞에 ` (2)`, ` (3)` …을 붙인다. 예: `plan.html` → `plan (2).html`.
- 원본 경로는 `find_html.py`가 준 `path`(절대 경로)를 쓴다.
- 확신이 없으면 방 대신 `~/rooms/inbox/`에 링크한다.

## 처음 정리 / 다시 정리

1. 후보를 찾는다. 사용자가 더 넓게 원하면 `--days 30`.

   ```sh
   python3 <skill>/scripts/find_html.py --home <home> --days 14
   ```

   출력은 JSON 하나다: `candidates[]`(최근 쓴 순), 각 항목은 `path`, `title`, `agent`, `last_written`, `repo_key`, `rel_in_repo`, `linked`, `linked_at`. `skipped`는 걸러낸 개수.
   - `linked: true`인 후보는 이미 방에 있다. 건너뛴다 (다시 정리할 때도 같다).
   - 같은 `repo_key` + `rel_in_repo`가 여럿이면(워크트리 복사본) `last_written`이 가장 최근인 하나만 쓴다.
   - 후보가 0개이고 대화 기록도 없으면, 아티팩트가 있는 폴더를 사용자에게 직접 묻는다.
2. 각 후보의 `title`과 파일 앞부분(약 40줄)을 읽고 주제별 방을 정한다. 방 하나에 파일이 1개뿐이거나 주제가 애매하면 inbox로 보낸다.
3. 사용자에게 **한 번에** 아래 표를 보여준다.

   ```text
   후보 (linked 제외)
   | repo_key        | 개수 | 주요 폴더                  |
   |-----------------|------|----------------------------|
   | alto-rooms      | 12   | docs/superpowers/specs     |
   | astack          | 4    | tests/fixtures             |

   제안
   | 방 (폴더)        | 새로/기존 | 파일                          |
   |------------------|-----------|-------------------------------|
   | 브라우저-하네스  | 새로      | pi-plan.html, benchmark.html  |
   | pricing          | 기존      | plans.html                    |
   | inbox            | 기존      | misc.html                     |
   ```

   그리고 한 번만 묻는다: "이대로 만들까요?"
4. "예"일 때만 진행한다. 사용자가 이름을 바꾸거나 파일을 옮기라고 하면 고친 안으로 진행한다 (다시 묻지 않아도 된다). "아니오"면 아무것도 만들지 않는다.
5. 방마다 `mkdir -p ~/rooms/<slug>`, 파일마다 `ln -s` (위 "링크 만들기" 규칙).
6. 보고한다: 만든 방, 방별 링크 개수, inbox 개수. 그리고 "원본 파일은 옮기지 않았어요. 링크만 만들었어요."라고 알린다.
7. 처음 정리였다면 "한 줄 추가" 절을 한다.

## 만들 때마다 (습관)

`.html` / `.htm` 아티팩트를 새로 쓰면, 복사하지 말고 가장 알맞은 방에 링크한다.

```sh
ln -s "<방금 쓴 파일 절대 경로>" ~/rooms/<slug>/<파일 이름>
```

- 알맞은 방이 없거나 확신이 없으면 `~/rooms/inbox/`에 링크한다.
- 이미 `~/rooms` 아래에 직접 쓴 파일은 링크하지 않는다.
- 같은 원본을 가리키는 링크가 이미 있으면 또 만들지 않는다.

## 한 줄 추가 (묻고 나서만)

처음 정리를 마치면 사용자에게 묻는다: 아래 한 줄을 `~/.claude/CLAUDE.md`(Claude Code) 또는 `~/.codex/AGENTS.md`(Codex)에 추가할까요? "예"일 때만, 파일 끝에 한 번만 추가한다 (이미 있으면 추가하지 않는다).

```text
- HTML 아티팩트를 만들면 rooms 스킬로 알맞은 방에 링크한다.
```

## 하지 말 것

- 원본 파일을 옮기거나, 고치거나, 지우지 않는다.
- linked(연결된 폴더) 방 안에는 아무것도 쓰지 않는다.
- `journal`, `inbox`라는 방을 새로 만들지 않는다 (`inbox`에 링크하는 것은 된다).
- `~/rooms/.rooms`는 건드리지 않는다. 스킬 원본과 `state.json`을 읽는 것만 된다.
- 토큰(`~/rooms/.rooms/token`)을 읽거나, 출력하거나, 명령에 넣지 않는다.
