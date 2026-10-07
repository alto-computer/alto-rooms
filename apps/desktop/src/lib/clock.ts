/** The timer functions a module schedules with; injectable so tests can drive time. */
export type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** The global timers, looked up at call time so fake timers installed later still apply. */
export const globalTimers: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
