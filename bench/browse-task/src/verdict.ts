import type { Verdict } from "./scenarios.ts";

export function verdict(checks: Record<string, boolean>, detail?: unknown): Verdict {
  const values = Object.values(checks);
  return {
    success: values.every(Boolean),
    score: values.filter(Boolean).length / values.length,
    checks,
    detail,
  };
}
