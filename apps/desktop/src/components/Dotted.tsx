import { Fragment, type ReactNode } from "react";

/** Inline parts joined by middle dots, as in "New · claude-code · 12 min"; empty parts are left out. */
export function Dotted({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  return shown.map((p, i) => (
    <Fragment key={i}>
      {i > 0 ? <span aria-hidden>·</span> : null}
      {typeof p === "string" ? <span>{p}</span> : p}
    </Fragment>
  ));
}
