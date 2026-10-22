// Screenshot of a never-shown view (an isolated-session tab) can come back
// empty when the view has not produced a compositor frame yet (on Linux it may
// paint late). One retry after asking for a frame fixes the common case.

export interface MaybeEmpty {
  isEmpty(): boolean;
}

/**
 * Captures; if the image is empty, runs `waitForFrame` once and captures
 * again. Returns the second result (still possibly empty). `waitForFrame` must
 * settle by itself (window.ts: invalidate + a fixed timer); a throw or a
 * rejection is ignored and the retry still happens.
 */
export async function captureWithRetry<T extends MaybeEmpty>(
  capture: () => Promise<T>,
  waitForFrame: () => Promise<unknown>,
): Promise<T> {
  const first = await capture();
  if (!first.isEmpty()) return first;
  try {
    await waitForFrame();
  } catch {
    // The retry capture below is the only thing that matters.
  }
  return capture();
}
