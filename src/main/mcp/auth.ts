// Copied verbatim from pen-editor-backend/src/mcp/auth.ts — 23 lines, not
// worth a shared package. Drops nothing (the backend file has no
// Config/resolveMcpAuth half to drop; that lives in autoToken.ts there).

import { timingSafeEqual } from "node:crypto";

// Constant-time string comparison for shared secrets — never replace with
// `===`, which short-circuits on the first mismatched byte and leaks timing
// information about how much of the token was guessed correctly.
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Extracts the token from an `Authorization: Bearer <token>` header. Returns
// null for a missing, empty, or non-Bearer header (a repeated header may
// arrive as an array; only the first value is honored).
export function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : null;
}
