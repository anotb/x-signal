const SECRET_KEY = /authorization|cookie|csrf|password|secret|token|storage/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIEISH = /(?:auth_token|ct0|guest_id|twid|kdt)=[^;\s]+/gi;

export function redactText(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(COOKIEISH, "[REDACTED]");
}

export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]" as T;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, seen);
  return result as T;
}

export function safeLog(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify(redact({ level: "info", event, at: new Date().toISOString(), ...details }))}\n`);
}
