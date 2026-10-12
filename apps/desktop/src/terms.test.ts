import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Guard for docs/glossary.md: agent runs are sessions and agent-written files are artifacts, in
 * code too. It reads identifiers, and text between JSX tags, so UI copy there needs an allowlist
 * entry. Comments and regex literals are skipped; string literals are read only for the retired
 * wire names and kinds, which migration code and its tests may name with an allowlist entry.
 */

const REPO = path.resolve(__dirname, "../../..");

/** Where `conversation` may not name anything: all Rust and TypeScript source. */
const SOURCE_ROOTS = ["crates", "apps/desktop/src", "apps/desktop/src-tauri/src", "apps/desktop/e2e", "packages"];
/** Where `doc` may not name anything: app code. The crates keep `doc` for generic HTML documents (inject.rs). */
const APP_ROOTS = ["apps/desktop/src", "apps/desktop/src-tauri/src", "apps/desktop/e2e", "packages/plugin-sdk/src", "packages/protocol-ts/src"];
const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git"]);

/** Wire paths, events and file names from before the rename, found anywhere in a string literal. */
const RETIRED_NAMES = ["/v1/conversations", "conversation.moved", "conversations.json"];
/** Scope and tab kinds from before the rename, as a whole string literal. `doc` only in app code. */
const RETIRED_KIND = /^(["'`])(conversation|doc)\1$/;

type Allowed = { file: string; word: string; why: string };

/** Each entry allows one word in one file: an identifier, a retired name, or a kind as `"doc"`. */
const ALLOWED: Allowed[] = [
  { file: "apps/desktop/src/ask/ThreadSheet.tsx", word: "conversation", why: "ask-chat UI copy: the conversation got long, Couldn't load the conversation" },
  { file: "apps/desktop/src/ask/Turn.tsx", word: "Conversation", why: "ask-chat UI copy: Conversation summarized" },
  { file: "apps/desktop/src/ask/Turn.tsx", word: "conversation", why: "ask-chat UI copy: New conversation" },
  { file: "crates/rooms-core/src/sessions.rs", word: "conversations", why: "migration: the map key in conversations.json" },
  { file: "crates/rooms-core/src/sessions.rs", word: "conversations.json", why: "migration: the store's old file name" },
  { file: "crates/roomsd/tests/api.rs", word: "/v1/conversations", why: "test: the old routes are gone" },
  { file: "apps/desktop/src/data/viewerStore.ts", word: '"doc"', why: "migration: saved tabs of the old kind" },
  { file: "apps/desktop/src/data/viewerStore.ts", word: '"conversation"', why: "migration: saved tabs of the old kind" },
  { file: "apps/desktop/src/data/viewerStore.test.ts", word: '"doc"', why: "test: saved tabs of the old kind" },
  { file: "apps/desktop/src/data/viewerStore.test.ts", word: '"conversation"', why: "test: saved tabs of the old kind" },
  { file: "apps/desktop/src/surfaces/surfaceHub.ts", word: '"doc"', why: "SDK 0.5 surface scopes, sent and accepted until 0.7" },
  { file: "apps/desktop/src/surfaces/surfaceHub.ts", word: '"conversation"', why: "SDK 0.5 surface scopes, sent and accepted until 0.7" },
  { file: "apps/desktop/src/surfaces/surfaceHub.test.ts", word: '"doc"', why: "test: SDK 0.5 surface scopes" },
  { file: "apps/desktop/src/surfaces/surfaceHub.test.ts", word: '"conversation"', why: "test: SDK 0.5 surface scopes" },
  { file: "packages/plugin-sdk/src/surfaces.ts", word: '"doc"', why: "legacySurfacePath: the 0.5 storage path" },
  { file: "packages/plugin-sdk/src/surfaces.ts", word: '"conversation"', why: "legacySurfacePath: the 0.5 storage path" },
];

type Segment = { kind: "code" | "string" | "comment" | "regex"; text: string; start: number };

/** A `/` in TypeScript at `i` starts a regex literal when what comes before cannot end an operand. */
function startsRegex(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0 || "(,=:[!&|?;{+-*%~^".includes(src[k]) || (src[k] === ">" && src[k - 1] === "=")) return true;
  return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|new|throw)$/.test(src.slice(Math.max(0, k - 10), k + 1));
}

/** Where the regex literal starting at `i` ends (after its flags), or -1 when the line has no closing `/`. */
function regexEnd(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) {
      let end = j + 1;
      while (/[a-z]/.test(src[end] ?? "")) end++;
      return end;
    }
  }
  return -1;
}

/** Splits Rust or TypeScript source into code, string literals and comments. */
function segments(src: string, ts: boolean): Segment[] {
  const out: Segment[] = [];
  let code = "";
  let codeStart = 0;
  let i = 0;
  const push = (kind: Segment["kind"], end: number) => {
    if (code) out.push({ kind: "code", text: code, start: codeStart });
    out.push({ kind, text: src.slice(i, end), start: i });
    i = end;
    code = "";
    codeStart = i;
  };
  const templates: number[] = [];
  while (i < src.length) {
    const c = src[i];
    const rest = c === "/" ? src.slice(i, i + 2) : "";
    if (rest === "//") {
      const nl = src.indexOf("\n", i);
      push("comment", nl < 0 ? src.length : nl);
      continue;
    }
    if (rest === "/*") {
      const end = src.indexOf("*/", i + 2);
      push("comment", end < 0 ? src.length : end + 2);
      continue;
    }
    const prev = src[i - 1] ?? " ";
    if (ts && c === "/") {
      const end = startsRegex(src, i) ? regexEnd(src, i) : -1;
      if (end > 0) {
        push("regex", end);
        continue;
      }
    }
    if (!ts && (c === "r" || c === "b") && /^b?r#*"/.test(src.slice(i, i + 130)) && !/[A-Za-z0-9_]/.test(prev)) {
      const m = /^b?r(#*)"/.exec(src.slice(i))!;
      const end = src.indexOf(`"${m[1]}`, i + m[0].length);
      push("string", end < 0 ? src.length : end + 1 + m[1].length);
      continue;
    }
    if (!ts && c === "'") {
      const m = /^'(\\.|[^\\'])'|^'\\u\{[0-9a-fA-F]+\}'|^'\\x[0-9a-fA-F]{2}'/.exec(src.slice(i, i + 12));
      if (m) {
        push("string", i + m[0].length);
        continue;
      }
    }
    // An apostrophe right after a letter is JSX text (`Couldn't`), never the start of a string.
    if (c === '"' || (ts && ((c === "'" && !/[A-Za-z0-9]/.test(prev)) || c === "`"))) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c === "`" && src.startsWith("${", j)) break;
        else if (c !== "`" && ts && src[j] === "\n") break;
        j++;
      }
      if (c === "`" && src.startsWith("${", j)) {
        push("string", j + 2);
        templates.push(0);
        continue;
      }
      push("string", Math.min(j + 1, src.length));
      continue;
    }
    if (ts && templates.length) {
      if (c === "{") templates[templates.length - 1]++;
      else if (c === "}") {
        if (templates[templates.length - 1] === 0) {
          templates.pop();
          // The rest of the template, up to its end or its next `${`.
          let j = i + 1;
          while (j < src.length && src[j] !== "`" && !src.startsWith("${", j)) j += src[j] === "\\" ? 2 : 1;
          const opens = src.startsWith("${", j);
          push("string", opens ? j + 2 : j + 1);
          if (opens) templates.push(0);
          continue;
        }
        templates[templates.length - 1]--;
      }
    }
    code += c;
    i++;
  }
  if (code) out.push({ kind: "code", text: code, start: codeStart });
  return out;
}

/** The identifiers (and JSX words) in a file's code, with where they start. */
function identifiers(src: string, ts: boolean): { word: string; at: number }[] {
  const found: { word: string; at: number }[] = [];
  for (const s of segments(src, ts)) {
    if (s.kind !== "code") continue;
    for (const m of s.text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) found.push({ word: m[0], at: s.start + m.index });
  }
  return found;
}

/** `openDoc` → open, doc; `DOC_ORIGINAL` → doc, original; `document` stays one word. */
const wordParts = (id: string) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((p) => p.toLowerCase());

const namesConversation = (id: string) => /conversation/i.test(id);
const namesDoc = (id: string) => wordParts(id).some((p) => p === "doc" || p === "docs");

/** The retired wire names in a file's string literals, and string literals that are a retired kind (as `"doc"`). */
function retiredStrings(src: string, ts: boolean, app: boolean): { word: string; at: number }[] {
  const found: { word: string; at: number }[] = [];
  for (const s of segments(src, ts)) {
    if (s.kind !== "string") continue;
    for (const name of RETIRED_NAMES) {
      const at = s.text.indexOf(name);
      if (at >= 0) found.push({ word: name, at: s.start + at });
    }
    const kind = RETIRED_KIND.exec(s.text)?.[2];
    if (kind === "conversation" || (app && kind === "doc")) found.push({ word: `"${kind}"`, at: s.start });
  }
  return found;
}

/** Everything in `file` that breaks the glossary, before the allowlist. */
function breaches(file: string, src: string): { word: string; at: number }[] {
  const ts = /\.(ts|tsx|mts|mjs|js)$/.test(file);
  const app = APP_ROOTS.some((r) => file.startsWith(`${r}/`));
  const named = identifiers(src, ts).filter(({ word }) => namesConversation(word) || (app && namesDoc(word)));
  return [...named, ...retiredStrings(src, ts, app)].sort((a, b) => a.at - b.at);
}

/** Every breach the allowlist does not cover, as `file:line word`. */
function offending(file: string, src: string, allowed: readonly Allowed[] = ALLOWED): string[] {
  const ok = (word: string) => allowed.some((a) => a.file === file && a.word === word);
  return breaches(file, src)
    .filter(({ word }) => !ok(word))
    .map(({ word, at }) => `${file}:${src.slice(0, at).split("\n").length} ${word}`);
}

function sources(rel: string): string[] {
  return readdirSync(path.join(REPO, rel), { withFileTypes: true }).flatMap((e) => {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : sources(p);
    return /\.(rs|ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

describe("terms (docs/glossary.md)", () => {
  it("no Rust or TypeScript identifier says conversation, and no app identifier says doc", () => {
    const files = SOURCE_ROOTS.flatMap(sources).filter((f) => f !== "apps/desktop/src/terms.test.ts");
    expect(files.length).toBeGreaterThan(300);
    expect(files.flatMap((f) => offending(f, readFileSync(path.join(REPO, f), "utf8")))).toEqual([]);
  });

  it("every allowlist entry still matches something, so the list never outlives its reason", () => {
    const unused = ALLOWED.filter((a) => !breaches(a.file, readFileSync(path.join(REPO, a.file), "utf8")).some((x) => x.word === a.word));
    expect(unused).toEqual([]);
  });

  it("flags identifiers and JSX text, not words inside strings or comments", () => {
    const ts = [
      "const conversationId = 1;",
      'const label = "New conversation"; // a conversation',
      "const t = `conversation:${conversationKey(x)}`;",
      "<Divider>New conversation</Divider>",
      "const openDoc = () => document.body;",
      "/* DocView */ const dir = \"docs\";",
    ].join("\n");
    expect(offending("apps/desktop/src/x.tsx", ts, [])).toEqual([
      "apps/desktop/src/x.tsx:1 conversationId",
      "apps/desktop/src/x.tsx:3 conversationKey",
      "apps/desktop/src/x.tsx:4 conversation",
      "apps/desktop/src/x.tsx:5 openDoc",
    ]);
    const rs = ['fn get_conversation() {}', 'let s = "conversation-"; // ConversationId', 'let r = r#"conversation"#;', "let doc = 1;"].join("\n");
    expect(offending("crates/x/src/lib.rs", rs, [])).toEqual(["crates/x/src/lib.rs:1 get_conversation"]);
    expect(offending("apps/desktop/src-tauri/src/x.rs", "fn doc_original() {}", [])).toEqual(["apps/desktop/src-tauri/src/x.rs:1 doc_original"]);
  });

  it("flags retired wire names and scope or tab kinds in string literals", () => {
    const ts = [
      "fetch(`${base}/v1/conversations/${id}`);",
      'if (e.type === "conversation.moved") return;',
      'const store = ".rooms/conversations.json";',
      'const tab = { kind: "conversation" };',
      "const scope = { kind: 'doc' };",
      'const fine = ["Open the doc", "document", "conversation-", `${name}`];',
    ].join("\n");
    expect(offending("apps/desktop/src/x.ts", ts, [])).toEqual([
      "apps/desktop/src/x.ts:1 /v1/conversations",
      "apps/desktop/src/x.ts:2 conversation.moved",
      "apps/desktop/src/x.ts:3 conversations.json",
      'apps/desktop/src/x.ts:4 "conversation"',
      'apps/desktop/src/x.ts:5 "doc"',
    ]);
    const rs = ['let kind = "conversation";', 'let input = json!({"doc": key});', 'let p = r"conversations.json";'].join("\n");
    expect(offending("crates/x/src/lib.rs", rs, [])).toEqual(['crates/x/src/lib.rs:1 "conversation"', "crates/x/src/lib.rs:3 conversations.json"]);
    expect(offending("apps/desktop/src/x.ts", 'const kind = "doc";', [{ file: "apps/desktop/src/x.ts", word: '"doc"', why: "migration" }])).toEqual([]);
  });

  it("reads JSX text with an apostrophe to the end of the line", () => {
    const tsx = ["<ErrorText>Couldn't load the conversation</ErrorText>", "<p>It's {conversationCount} items</p>", "const s = 'conversation';"].join("\n");
    expect(offending("apps/desktop/src/x.tsx", tsx, [])).toEqual([
      "apps/desktop/src/x.tsx:1 conversation",
      "apps/desktop/src/x.tsx:2 conversationCount",
      'apps/desktop/src/x.tsx:3 "conversation"',
    ]);
  });

  it("skips regex literals, and keeps reading code after one that holds a quote", () => {
    const ts = [
      "const re = /conversation-(\\w+)\\.jsonl$/;",
      "if (/docs?/i.test(name)) return /[/]doc/.exec(name);",
      'const quote = /"/g; const conversationId = 1;',
      "const half = total / 2 / docCount;",
      "<p>a / b</p>",
    ].join("\n");
    expect(offending("apps/desktop/src/x.tsx", ts, [])).toEqual(["apps/desktop/src/x.tsx:3 conversationId", "apps/desktop/src/x.tsx:4 docCount"]);
  });

  it("splits words so document, docker or Doctor never count as doc", () => {
    expect(["document", "ownerDocument", "docker", "Doctor", "artifact"].filter(namesDoc)).toEqual([]);
    expect(["doc", "docs", "openDoc", "DocView", "doc_original", "MAX_DOCS", "useDocSelection"].filter(namesDoc)).toHaveLength(7);
  });
});
