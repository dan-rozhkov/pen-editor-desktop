import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { parseTabMenuPayload, revealInFolder, revealMenuLabel, revealTargetFor, type RevealPorts } from "../src/main/revealInFolder";

const dirs = { canvases: "/u/canvases", documents: "/u/documents", traces: "/u/browse-traces" };

describe("revealMenuLabel", () => {
  it("is per platform", () => {
    expect(revealMenuLabel("darwin")).toBe("Reveal in Finder");
    expect(revealMenuLabel("win32")).toBe("Show in Explorer");
    expect(revealMenuLabel("linux")).toBe("Show in Folder");
  });
});

describe("revealTargetFor", () => {
  it("builds the canvas, doc and trace paths", () => {
    expect(revealTargetFor({ kind: "canvas", id: "cv_1" }, dirs)).toEqual({ file: path.join("/u/canvases", "cv_1.pen.json"), dir: "/u/canvases" });
    expect(revealTargetFor({ kind: "doc", id: "d-1" }, dirs)).toEqual({ file: path.join("/u/documents", "d-1.json"), dir: "/u/documents" });
    expect(revealTargetFor({ kind: "trace", id: "t1" }, dirs)).toEqual({
      file: path.join("/u/browse-traces", "t1", "trace.json"),
      dir: path.join("/u/browse-traces", "t1"),
    });
  });
  it("returns null for an invalid id", () => {
    for (const kind of ["canvas", "doc", "trace"] as const) {
      expect(revealTargetFor({ kind, id: "../x" }, dirs)).toBeNull();
      expect(revealTargetFor({ kind, id: "" }, dirs)).toBeNull();
      expect(revealTargetFor({ kind, id: "a/b" }, dirs)).toBeNull();
    }
  });
});

describe("revealInFolder", () => {
  function ports(existing: string[]) {
    return {
      exists: vi.fn(async (p: string) => existing.includes(p)),
      showItemInFolder: vi.fn((_p: string) => {}),
      openPath: vi.fn(async (_p: string) => ""),
      warn: vi.fn((_m: string) => {}),
    } satisfies RevealPorts;
  }
  const file = path.join("/u/canvases", "cv_1.pen.json");

  it("shows the file when it exists", async () => {
    const p = ports([file, "/u/canvases"]);
    await revealInFolder({ kind: "canvas", id: "cv_1" }, dirs, p);
    expect(p.showItemInFolder).toHaveBeenCalledWith(file);
    expect(p.openPath).not.toHaveBeenCalled();
  });
  it("opens the directory when the file is missing", async () => {
    const p = ports(["/u/canvases"]);
    await revealInFolder({ kind: "canvas", id: "cv_1" }, dirs, p);
    expect(p.showItemInFolder).not.toHaveBeenCalled();
    expect(p.openPath).toHaveBeenCalledWith("/u/canvases");
  });
  it("warns when openPath reports an error", async () => {
    const p = ports(["/u/canvases"]);
    p.openPath.mockResolvedValue("boom");
    await revealInFolder({ kind: "canvas", id: "cv_1" }, dirs, p);
    expect(p.warn).toHaveBeenCalled();
  });
  it("does nothing, with a warning, when neither exists", async () => {
    const p = ports([]);
    await revealInFolder({ kind: "doc", id: "d1" }, dirs, p);
    expect(p.showItemInFolder).not.toHaveBeenCalled();
    expect(p.openPath).not.toHaveBeenCalled();
    expect(p.warn).toHaveBeenCalledTimes(1);
  });
  it("does nothing for an invalid id", async () => {
    const p = ports(["/u/canvases"]);
    await revealInFolder({ kind: "canvas", id: "../etc" }, dirs, p);
    expect(p.exists).not.toHaveBeenCalled();
    expect(p.warn).toHaveBeenCalled();
  });
  it("never throws", async () => {
    const p = ports([]);
    p.exists.mockRejectedValue(new Error("io"));
    p.warn.mockImplementation(() => {
      throw new Error("log");
    });
    await expect(revealInFolder({ kind: "trace", id: "t1" }, dirs, p)).resolves.toBeUndefined();
    const q = ports([file]);
    q.showItemInFolder.mockImplementation(() => {
      throw new Error("shell");
    });
    await expect(revealInFolder({ kind: "canvas", id: "cv_1" }, dirs, q)).resolves.toBeUndefined();
  });
});

describe("parseTabMenuPayload", () => {
  it("accepts an id with finite coordinates and rounds them", () => {
    expect(parseTabMenuPayload({ id: 3, x: 10.4, y: 20.6 })).toEqual({ id: 3, x: 10, y: 21 });
  });
  it("rejects anything else", () => {
    for (const bad of [null, undefined, 5, "x", {}, { id: "3", x: 1, y: 1 }, { id: 1.5, x: 1, y: 1 }, { id: 1, x: NaN, y: 1 }, { id: 1, x: 1, y: Infinity }, { id: 1, x: 1 }]) {
      expect(parseTabMenuPayload(bad)).toBeNull();
    }
  });
});
