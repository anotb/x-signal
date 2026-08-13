import type { ErrorCode } from "./contracts.js";

export class XSignalError extends Error {
  readonly code: ErrorCode;
  readonly remediation?: string;
  readonly retryAfterMs?: number;
  readonly retryAt?: string;

  constructor(code: ErrorCode, message: string, options: { remediation?: string; retryAfterMs?: number; retryAt?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "XSignalError";
    this.code = code;
    if (options.remediation !== undefined) this.remediation = options.remediation;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
  }
}

export function toXSignalError(error: unknown): XSignalError {
  if (error instanceof XSignalError) return error;
  const message = error instanceof Error ? error.message : "Unknown internal failure";
  if (/401|403|login|sign.?in|not authenticated/i.test(message)) {
    return new XSignalError("NOT_AUTHENTICATED", "The persistent X browser is not signed in.", {
      remediation: "Open http://127.0.0.1:6080/vnc.html, enter the browser volume's VNC password, and sign into X.",
      cause: error,
    });
  }
  if (/429|rate.?limit/i.test(message)) return new XSignalError("RATE_LIMITED", "X rate-limited the conservative browser read.", { cause: error });
  if (/challenge|captcha|verify your identity/i.test(message)) return new XSignalError("UPSTREAM_CHALLENGE", "X presented an interactive account challenge.", { cause: error });
  if (/ECONNREFUSED|connectOverCDP|browser.*closed|fetch failed/i.test(message)) {
    return new XSignalError("CAPABILITY_UNAVAILABLE", "The persistent browser sidecar is unavailable.", {
      remediation: "Check `docker compose ps` and the browser health/logs, then retry once it is healthy.",
      cause: error,
    });
  }
  return new XSignalError("INTERNAL", message, { cause: error });
}
