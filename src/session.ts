import { createHash } from "node:crypto";
import { z } from "zod";

const SameSiteSchema = z.enum(["no_restriction", "lax", "strict", "unspecified"]);

export const SessionCookieSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(255),
  path: z.string().min(1).max(2_048).default("/"),
  expirationDate: z.number().finite().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: SameSiteSchema.optional(),
}).strict();

export const SessionSyncRequestSchema = z.object({
  version: z.literal(1),
  reason: z.enum(["startup", "periodic", "cookie-change", "manual", "recovery"]),
  cookies: z.array(SessionCookieSchema).max(512),
  source: z.object({
    id: z.string().uuid(),
    label: z.string().min(1).max(80),
  }).optional(),
  activate: z.boolean().optional(),
}).strict();

export type SessionCookieInput = z.infer<typeof SessionCookieSchema>;

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export function normalizeSessionCookies(input: SessionCookieInput[]): BrowserCookie[] {
  const normalized = input
    .filter((cookie) => isXDomain(cookie.domain))
    .map((cookie): BrowserCookie => {
      const result: BrowserCookie = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain.toLowerCase(),
        path: cookie.path || "/",
        httpOnly: cookie.httpOnly ?? false,
        secure: cookie.secure ?? true,
        sameSite: cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "lax" ? "Lax" : "None",
      };
      if (cookie.expirationDate && cookie.expirationDate > 0) result.expires = cookie.expirationDate;
      return result;
    });
  return [...new Map(normalized.map((cookie) => [`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`, cookie])).values()]
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

export function sessionDigest(cookies: BrowserCookie[]): string {
  const hash = createHash("sha256");
  for (const cookie of cookies) {
    hash.update(cookie.domain).update("\0").update(cookie.path).update("\0").update(cookie.name).update("\0").update(cookie.value).update("\0");
    hash.update(String(cookie.expires ?? -1)).update("\0").update(String(cookie.secure)).update("\0").update(String(cookie.httpOnly)).update("\0").update(cookie.sameSite).update("\0");
  }
  return hash.digest("hex");
}

function isXDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return normalized === "x.com" || normalized.endsWith(".x.com") || normalized === "twitter.com" || normalized.endsWith(".twitter.com");
}
