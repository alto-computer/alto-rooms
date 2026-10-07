#!/bin/sh
# Fake agent for ask tests. Behaviour comes from the question text (last argv element).
last=""; for a in "$@"; do last="$a"; done
case "$last" in
  *SLEEP*) echo "partial"; sleep 30 ;;
  *FAIL*) echo "bad thing happened" >&2; exit 7 ;;
  *) printf 'ARGV:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\nCWD: %s\n' "$(pwd)" ;;
esac
