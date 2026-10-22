import { describe, expect, it, vi } from "vitest";
import { handleDocExportPdf, sanitizePdfFileName, type DocPdfDeps } from "../src/main/docPdfExport";

const caller = { senderId: 7, topFrame: true, frameUrl: "https://app.test/doc" };

function deps(over: Partial<DocPdfDeps> = {}) {
  const d = {
    port: { isDocViewer: vi.fn(() => true) },
    printToPDF: vi.fn(async () => new Uint8Array([1, 2, 3])),
    showSaveDialog: vi.fn(async (_n: string) => "/tmp/out.pdf" as string | undefined),
    writeFile: vi.fn(async () => undefined),
    ...over,
  };
  return d as typeof d & DocPdfDeps;
}

describe("sanitizePdfFileName", () => {
  it("turns separators, reserved and control characters into one space", () => {
    expect(sanitizePdfFileName('a/b\\c:d*e?f"g<h>i|j\u0001k')).toBe("a b c d e f g h i j k.pdf");
    expect(sanitizePdfFileName("a/b")).toBe("a b.pdf");
    expect(sanitizePdfFileName("a  //  b")).toBe("a b.pdf");
  });
  it("drops leading dots and trailing dots and spaces", () => {
    expect(sanitizePdfFileName(".secret")).toBe("secret.pdf");
    expect(sanitizePdfFileName("name. . ")).toBe("name.pdf");
  });
  it("keeps one .pdf extension", () => {
    expect(sanitizePdfFileName("Report.PDF")).toBe("Report.pdf");
    expect(sanitizePdfFileName("Report")).toBe("Report.pdf");
  });
  it("falls back to Untitled", () => {
    expect(sanitizePdfFileName("")).toBe("Untitled.pdf");
    expect(sanitizePdfFileName("  /\\ ")).toBe("Untitled.pdf");
    expect(sanitizePdfFileName("..")).toBe("Untitled.pdf");
  });
  it("caps at 100 characters before the extension", () => {
    expect(sanitizePdfFileName("x".repeat(300))).toBe(`${"x".repeat(100)}.pdf`);
  });
});

describe("handleDocExportPdf", () => {
  it("refuses a non-doc sender and a subframe without printing", async () => {
    const d = deps({ port: { isDocViewer: vi.fn(() => false) } });
    expect(await handleDocExportPdf(d, caller, "a")).toEqual({ error: "Not allowed." });
    const e = deps();
    expect(await handleDocExportPdf(e, { ...caller, topFrame: false }, "a")).toEqual({ error: "Not allowed." });
    expect(d.printToPDF).not.toHaveBeenCalled();
    expect(e.printToPDF).not.toHaveBeenCalled();
  });
  it("passes sender id and frame url to the doc viewer check", async () => {
    const d = deps();
    await handleDocExportPdf(d, caller, "a");
    expect(d.port.isDocViewer).toHaveBeenCalledWith(7, "https://app.test/doc");
  });
  it("rejects a non-string name", async () => {
    expect(await handleDocExportPdf(deps(), caller, 5)).toEqual({ error: "Malformed request." });
  });
  it("returns canceled and writes nothing", async () => {
    const d = deps({ showSaveDialog: vi.fn(async () => undefined) });
    expect(await handleDocExportPdf(d, caller, "a")).toEqual({ canceled: true });
    expect(d.writeFile).not.toHaveBeenCalled();
  });
  it("writes the PDF bytes to the chosen path with a sanitized default name", async () => {
    const d = deps();
    expect(await handleDocExportPdf(d, caller, "my/doc")).toEqual({ ok: true, path: "/tmp/out.pdf" });
    expect(d.showSaveDialog).toHaveBeenCalledWith("my doc.pdf");
    expect(d.writeFile).toHaveBeenCalledWith("/tmp/out.pdf", new Uint8Array([1, 2, 3]));
  });
  it("turns a printToPDF failure into an error result", async () => {
    const d = deps({ printToPDF: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await handleDocExportPdf(d, caller, "a")).toEqual({ error: "boom" });
  });
  it("turns a write failure into an error result", async () => {
    const d = deps({ writeFile: vi.fn(async () => { throw new Error("disk full"); }) });
    expect(await handleDocExportPdf(d, caller, "a")).toEqual({ error: "disk full" });
  });
  it("refuses a second export from the same sender while one runs, then releases", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({ printToPDF: vi.fn(async () => { await gate; return new Uint8Array([1]); }) });
    const first = handleDocExportPdf(d, caller, "a");
    expect(await handleDocExportPdf(d, caller, "a")).toEqual({ error: "A PDF export is already running." });
    expect(d.printToPDF).toHaveBeenCalledTimes(1);
    // another sender is not blocked
    const other = deps();
    expect(await handleDocExportPdf(other, { ...caller, senderId: 8 }, "a")).toEqual({ ok: true, path: "/tmp/out.pdf" });
    release();
    expect(await first).toEqual({ ok: true, path: "/tmp/out.pdf" });
    expect(await handleDocExportPdf(deps(), caller, "a")).toEqual({ ok: true, path: "/tmp/out.pdf" });
  });
  it("releases the guard after a failure", async () => {
    const bad = deps({ printToPDF: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await handleDocExportPdf(bad, caller, "a")).toEqual({ error: "boom" });
    expect(await handleDocExportPdf(deps(), caller, "a")).toEqual({ ok: true, path: "/tmp/out.pdf" });
  });
});
