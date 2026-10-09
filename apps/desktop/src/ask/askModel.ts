/*
 * The model picked in the ask bar: how it reads, and the choice remembered per agent; and the
 * unsent draft per doc.
 * `null` is the agent's own default.
 */

const CLAUDE_ALIASES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

export function modelLabel(model: string | null): string {
  if (!model) return "Default";
  return CLAUDE_ALIASES[model] ?? model;
}

const key = (agent: string) => `alto-rooms.askModel.${agent}`;

/** The model last picked for `agent`, if it is still one of `models`. */
export function loadModel(agent: string, models: string[]): string | null {
  try {
    const v = localStorage.getItem(key(agent));
    return v && models.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveModel(agent: string, model: string | null): void {
  try {
    if (model) localStorage.setItem(key(agent), model);
    else localStorage.removeItem(key(agent));
  } catch {
    // storage unavailable: the choice lasts until the bar shows another doc
  }
}

const draftKey = (fileKey: string) => `alto-rooms.askDraft.${fileKey}`;

/** The unsent question typed under a doc, kept across tabs and restarts. */
export function loadDraft(fileKey: string): string {
  try {
    return localStorage.getItem(draftKey(fileKey)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(fileKey: string, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(fileKey), text);
    else localStorage.removeItem(draftKey(fileKey));
  } catch {
    // storage unavailable: the draft lasts while the bar shows this doc
  }
}
