import { useState } from "react";
import type { AskScope, AskTurn } from "@alto-rooms/protocol-ts";
import { RoomsApiError, scopeKey } from "@alto-rooms/protocol-ts";
import { useAsks, useAsksStore } from "@/data/hooks";
import { GENERIC_ERROR } from "@/lib/errors";
import type { Outgoing, Queued } from "./asksStore";
import { useAttachments } from "./attachments";
import { commandText, exactCommand, matchCommands, type CommandKind } from "./commands";
import { splitQuotes, withQuotes } from "./quotes";
import { useDraft } from "./useDraft";

/** A question on its way to roomsd, shown in the thread before roomsd answers with its turn. */
export type Pending = { question: string; images: string[] };

const isQuestion = (t: AskTurn) => (t.kind ?? "question") === "question";

/**
 * What the input holds for a scope (draft, quotes, images, queued questions) and the ways it goes
 * out. Sending is optimistic: the input empties at once, and a question roomsd refuses comes back.
 */
export function useComposer(scope: AskScope, model: string | null) {
  const store = useAsksStore();
  const { quotes: allQuotes, queues } = useAsks();
  const key = scopeKey(scope);
  const quotes = allQuotes[key] ?? [];
  const queue = queues[key] ?? [];
  const [draft, setDraft] = useDraft(scope);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const attachments = useAttachments(setError);

  /** True once roomsd has it (or it's queued); false after showing why not. */
  const deliver = async (q: Outgoing, now = false): Promise<boolean> => {
    setError(null);
    if (q.kind === "question") setPending({ question: q.text, images: q.images });
    try {
      await store.submit(scope, q, now);
      return true;
    } catch (e) {
      setError(e instanceof RoomsApiError ? e.message : GENERIC_ERROR);
      return false;
    } finally {
      setPending(null);
    }
  };

  const runCommand = (kind: CommandKind) => {
    setDraft((d) => (exactCommand(d) || matchCommands(d).length ? "" : d));
    void deliver({ text: commandText(kind), model, images: [], kind });
  };

  /** Sends the input: a command, or the question with the quotes and images waiting above it. `now` stops the running answer first. */
  const submit = async (now = false) => {
    const text = draft.trim();
    if (!text) return;
    const command = exactCommand(text);
    if (command) return runCommand(command.kind);
    if (attachments.uploading || attachments.failed) {
      setError(attachments.failed ? "Remove the images that couldn't be attached" : "Wait for the images to finish uploading");
      return;
    }
    const sentQuotes = quotes;
    const images = attachments.items.map((a) => a.id!);
    setDraft("");
    attachments.clear(attachments.items.map((a) => a.key));
    store.clearQuotes(scope, sentQuotes);
    const sent = await deliver({ text: withQuotes(sentQuotes, text), model, images, kind: "question" }, now);
    if (!sent) restore(text, sentQuotes, images);
  };

  /** Puts a question back in the input: its text (unless something new was typed), quotes and images. */
  const restore = (text: string, qs: string[], images: string[]) => {
    setDraft((d) => d || text);
    qs.forEach((x) => store.addQuote(scope, x));
    attachments.restore(images);
  };

  /** Asks `t` again as it was, with `withModel`. */
  const retry = (t: AskTurn, withModel: string | null) =>
    void deliver({ text: t.question, model: withModel, images: t.images ?? [], kind: t.kind ?? "question" });

  /** A queued question back in the input, out of the queue. */
  const edit = (q: Queued) => {
    const item = store.unqueue(scope, q.id);
    if (!item) return;
    const { quotes: qs, text } = splitQuotes(item.text);
    setDraft(text);
    qs.forEach((x) => store.addQuote(scope, x));
    attachments.restore(item.images);
  };

  /** ↑ in an empty input: the last queued question to edit, else the last question asked. False when there's neither. */
  const recall = (turns: AskTurn[]): boolean => {
    const queued = queue.at(-1);
    if (queued) {
      edit(queued);
      return true;
    }
    const asked = turns.filter(isQuestion).at(-1);
    if (!asked) return false;
    setDraft(splitQuotes(asked.question).text);
    return true;
  };

  return {
    draft, setDraft, quotes, queue, attachments, pending, error,
    submit, runCommand, retry, edit, recall,
    removeQuote: (i: number) => store.removeQuote(scope, i),
    sendNow: (q: Queued) => store.sendNow(scope, q.id),
    unqueue: (q: Queued) => void store.unqueue(scope, q.id),
  };
}

export type ComposerState = ReturnType<typeof useComposer>;
