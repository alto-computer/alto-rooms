import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "./fixtures";

/**
 * The default agent for room and day asks: one Read of the first listed doc for a second, then
 * "<label> answer to <question> (<n> docs)" in deltas, n being how many docs the prompt lists.
 * Its argv carries the scope settings, so roomsd reports its reads as scoped.
 */
export function installStreamingAgent(daemon: Daemon, label: string) {
  const bin = join(daemon.home, "fake-stream.sh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `doc=$(printf %s "$1" | grep '^- "' | head -n 1 | cut -d '"' -f 2)`,
      `n=$(printf %s "$1" | grep '^Documents (' | head -n 1 | sed 's/^Documents (\\([0-9]*\\)):$/\\1/')`,
      `q=$(printf %s "$1" | tail -n 1 | sed 's/^Question: //')`,
      `printf '{"t":"act","p":"%s"}\\n' "$doc"; sleep 1`,
      `printf '{"t":"d","x":"${label} answer to "}\\n'; sleep 0.4`,
      `printf '{"t":"d","x":"%s (%s docs)"}\\n' "$q" "$n"`,
    ].join("\n") + "\n",
  );
  chmodSync(bin, 0o755);
  mkdirSync(join(daemon.home, ".rooms"), { recursive: true });
  writeFileSync(
    join(daemon.home, ".rooms/agents.toml"),
    [
      'default = "fake-stream"',
      "[agents.fake-stream]",
      `new = ["${bin}", "{prompt}", "--settings", "{scope_settings}"]`,
      "[[agents.fake-stream.events]]",
      'match = { "/t" = "act" }',
      'label = "Read"',
      'activity = ["/p"]',
      "[[agents.fake-stream.events]]",
      'match = { "/t" = "d" }',
      'delta = "/x"',
      "",
    ].join("\n"),
  );
}
