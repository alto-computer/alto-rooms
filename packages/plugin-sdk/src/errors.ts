/** Why a call to the app failed: the `code` of every rejection the SDK makes. */
export type PluginErrorCode =
  | "permission_denied"
  | "invalid_path"
  | "too_large"
  | "not_found"
  | "write_failed"
  | "unknown_method"
  | "rate_limited"
  | "timeout";

export class PluginError extends Error {
  code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string = code) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}
