// Untrusted-arg validation for the checkpoint journal commands. The args come
// from an editor tab over IPC; anything malformed is never thrown, so the
// controller sees either a well-formed value or `undefined`.

const MAX_ORIGINS = 20;
const MAX_STRING = 512;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type OriginsResult = { ok: true; origins: string[] | undefined } | { ok: false };

/**
 * `args.origins`: absent => `{ok:true, origins: undefined}` (defaults); an
 * array of at most 20 strings of at most 512 chars (`[]` included) => those;
 * anything else => `{ok:false}` (the start must fail, not fall back).
 */
export function parseJournalOrigins(args: unknown): OriginsResult {
  if (!isRecord(args) || args.origins === undefined) return { ok: true, origins: undefined };
  const origins = args.origins;
  if (!Array.isArray(origins) || origins.length > MAX_ORIGINS) return { ok: false };
  if (!origins.every((o) => typeof o === "string" && o.length <= MAX_STRING)) return { ok: false };
  return { ok: true, origins: origins as string[] };
}

/** `args.token`: a string of at most 512 chars (journal ownership lookups). */
export function parseToken(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const token = args.token;
  return typeof token === "string" && token.length <= MAX_STRING ? token : undefined;
}

/** `args.token` as is (any length): a string passes through, else `undefined`. */
export function rawToken(args: unknown): string | undefined {
  return isRecord(args) && typeof args.token === "string" ? args.token : undefined;
}
