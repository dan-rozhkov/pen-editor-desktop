import type { LoginsCaller, LoginsPort } from "./loginsIpc";

/**
 * `docs:export-pdf` (invoke): the Markdown (doc) page saves itself as a PDF file. Kept out of window.ts so the rules
 * and the flow are unit-tested with injected ports.
 *
 * Same sender rule as `logins:*`: only the TOP frame of a doc tab that still shows the doc page may call.
 */

export type DocPdfResult = { ok: true; path: string } | { canceled: true } | { error: string };

export interface DocPdfDeps {
  /** The doc viewer check of this window (the same port `logins:*` uses). */
  port: Pick<LoginsPort, "isDocViewer">;
  /** Prints the sender page to PDF bytes. */
  printToPDF(): Promise<Uint8Array>;
  /** Native save dialog; resolves the chosen path, or undefined when the user cancelled. */
  showSaveDialog(defaultFileName: string): Promise<string | undefined>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

const MAX_NAME = 100;
const FALLBACK = "Untitled";

/**
 * A safe `.pdf` file name; same rules as the frontend's `docFilename`: reserved and control characters become a space,
 * spaces collapse, leading dots go (no hidden file), trailing dots and spaces go (Windows), at most 100 characters.
 */
export function sanitizePdfFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const withoutExt = cleaned.replace(/\.pdf$/i, "");
  const name = withoutExt.replace(/^[.\s]+/, "").slice(0, MAX_NAME).replace(/[. ]+$/, "").trim();
  return `${name || FALLBACK}.pdf`;
}

/** Sender ids with an export running. One export per page at a time. */
const busy = new Set<number>();

export async function handleDocExportPdf(deps: DocPdfDeps, caller: LoginsCaller, fileName: unknown): Promise<DocPdfResult> {
  if (!caller.topFrame || !deps.port.isDocViewer(caller.senderId, caller.frameUrl)) return { error: "Not allowed." };
  if (typeof fileName !== "string") return { error: "Malformed request." };
  if (busy.has(caller.senderId)) return { error: "A PDF export is already running." };
  busy.add(caller.senderId);
  try {
    const name = sanitizePdfFileName(fileName);
    const data = await deps.printToPDF();
    const target = await deps.showSaveDialog(name);
    if (target === undefined) return { canceled: true };
    await deps.writeFile(target, data);
    return { ok: true, path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    busy.delete(caller.senderId);
  }
}
