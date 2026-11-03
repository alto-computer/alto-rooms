import type { KeyboardEvent } from "react";
import type { StudyRoomSummary, StudyVolumeSummary } from "@alto-rooms/protocol-ts";

/**
 * Enter outside of an IME composition. Korean input commits its syllable with the same Enter; WebKit
 * reports that one with isComposing false but keyCode 229.
 */
export const isSubmit = (e: KeyboardEvent<HTMLInputElement>): boolean => e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;

/** How a volume is named on screen: `v0.3` for volume 3. */
export const versionOf = (n: number): string => `0.${n}`;

/** The cloths a room's books are bound in, muted and dark (study.css draws them, light and dark). */
export const CLOTHS = ["umber", "oxblood", "navy", "moss", "teal", "plum"] as const;
export type Cloth = (typeof CLOTHS)[number];

/** A room keeps its cloth for life: picked from its id, so every view and every run agrees. */
export function clothOf(roomId: string): Cloth {
  let h = 0x811c9dc5;
  for (const c of roomId) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CLOTHS[h % CLOTHS.length];
}

/** The volume the library and the room page lead with: the newest published one, else the draft. */
export function latestVolume(room: StudyRoomSummary): StudyVolumeSummary | undefined {
  return room.volumes.filter((v) => v.status === "published").at(-1) ?? room.volumes.at(-1);
}

/** A fresh id for a card, edge, memo or todo: 32 of `[0-9a-f]`, inside roomsd's 1–64 of `[A-Za-z0-9_-]`. */
export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `11.02` for `2026-11-02`. */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-");
  return `${m}.${d}`;
}

/** `2026.11.02` for an ISO instant, in local time. */
export function dottedDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** `Monday` for a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The month grid for `month` (`YYYY-MM`): whole weeks from Sunday, each day as `YYYY-MM-DD` with
 * whether it falls in that month.
 */
export function monthGrid(month: string): { date: string; inMonth: boolean }[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const start = Date.UTC(y, m - 1, 1 - first.getUTCDay());
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = Math.ceil((first.getUTCDay() + days) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, inMonth: d.getUTCMonth() === m - 1 };
  });
}

/** The month `n` months from `month` (`YYYY-MM`). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
