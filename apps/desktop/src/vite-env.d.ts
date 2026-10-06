/// <reference types="vite/client" />

/** Build-time: the quit-flush verification probe is compiled in (ALTO_FLUSH_PROBE=1). */
declare const __FLUSH_PROBE__: boolean;

/** Build-time: this app's version (package.json), for plugins' minAppVersion. */
declare const __APP_VERSION__: string;
