<!-- rooms-onboarding v7 -->
# Rooms onboarding (for agents)

Rooms is an app that shows HTML artifacts grouped into topic rooms. A room is one folder under Home. Artifacts go into a room as file symlinks that point to the original. The original never moves.

## 0. Paths

- Home is the folder that holds this file (`ONBOARD.md`). The default is `~/rooms`.
- In the commands below, replace `<home>` with the **absolute path** of Home (for example `/Users/me/rooms`). Do not use `~`: it does not expand inside quotes.
- `<skill dir>` is where the skill gets installed. Check which agent you are and pick one:
  - Claude Code: `$HOME/.claude/skills/rooms`
  - Codex: `$HOME/.codex/skills/rooms`
  - Any other agent: ask the user where skills go. If you have no skill support, do not install anything. Go to §2 and read and follow `<home>/.rooms/onboarding/skill/rooms/SKILL.md` directly.
- `$HOME` does expand inside quotes.

## 1. Install the skill

Go in order. Do not copy anything until you have finished 1-1 and 1-2.

### 1-1. Check what is there

```sh
if [ -e "<skill dir>" ] || [ -L "<skill dir>" ]; then echo present; else echo absent; fi
grep -m1 -o 'rooms-onboarding v[0-9]*' "<skill dir>/SKILL.md"
grep -m1 -o 'rooms-onboarding v[0-9]*' "<home>/.rooms/onboarding/skill/rooms/SKILL.md"
```

The second line prints the marker of the installed skill. The third prints the marker of the source.

### 1-2. Decide

- **absent**: "Fresh install" in 1-3.
- **present, no marker** (the second line prints nothing): this may be a skill the user wrote. **Do not replace it. Ask first.** Only on "yes", do "Replace" in 1-3. Otherwise do not install. Read and follow the source `SKILL.md` directly in §2.
- **present, installed version is lower than or equal to the source**: do "Replace" in 1-3 without asking.
- **present, installed version is higher than the source**: leave it and go to §2.

### 1-3. Copy

Fresh install:

```sh
mkdir -p "$(dirname "<skill dir>")"
cp -R "<home>/.rooms/onboarding/skill/rooms" "<skill dir>"
```

Replace (delete first, because `cp -R` into an existing folder nests one level deeper):

```sh
rm -rf "<skill dir>"
cp -R "<home>/.rooms/onboarding/skill/rooms" "<skill dir>"
```

## 2. Start sorting

Follow the "First sort / re-sort" section of the installed `SKILL.md` (or the source `SKILL.md` if you did not install). Always pass `--home "<home>"` to `find_html.py`.

## Rules

- Never move, edit, or delete original files.
- Never touch `<home>/.rooms` by hand. Exceptions: reading the skill source, and `find_html.py --record-sources`, which writes only `<home>/.rooms/sources.json`.
