import { describe, it, expect, vi } from "vitest";
import { decideNavigation, attachNavigationPolicy, attachOfflineFallback } from "../src/main/navigation";

const ORIGIN = "https://pen-editor.onrender.com";

describe("decideNavigation", () => {
  it("allows same-origin", () => {
    expect(decideNavigation(`${ORIGIN}/some/path?x=1`, ORIGIN)).toBe("allow");
  });
  it("sends other http(s) origins external", () => {
    expect(decideNavigation("https://example.com/docs", ORIGIN)).toBe("external");
    expect(decideNavigation("http://localhost:9999/", ORIGIN)).toBe("external");
  });
  it("denies non-http schemes and garbage", () => {
    expect(decideNavigation("file:///etc/passwd", ORIGIN)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", ORIGIN)).toBe("deny");
    expect(decideNavigation("%%%", ORIGIN)).toBe("deny");
  });
});

type Handler = (...args: unknown[]) => void;

function fakeContents() {
  const handlers = new Map<string, Handler>();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  return {
    on: vi.fn((event: string, cb: Handler) => handlers.set(event, cb)),
    setWindowOpenHandler: vi.fn((cb: (details: { url: string }) => { action: string }) => {
      openHandler = cb;
    }),
    loadFile: vi.fn(),
    getURL: vi.fn(() => `${ORIGIN}/`),
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args);
    },
    open(url: string) {
      return openHandler!({ url });
    },
  };
}

describe("attachNavigationPolicy", () => {
  it("prevents will-navigate to foreign origins and opens externally", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, "https://example.com/x");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
  });

  it("lets same-origin will-navigate through", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    const ev = { preventDefault: vi.fn() };
    contents.emit("will-navigate", ev, `${ORIGIN}/inner`);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("window.open goes external for http(s), denied otherwise, same-origin denied in-window", () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    attachNavigationPolicy(contents as never, ORIGIN, openExternal);
    expect(contents.open("https://example.com/x")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
    openExternal.mockClear();
    expect(contents.open("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("attachOfflineFallback", () => {
  it("loads the offline page on main-frame failure, with the failed url as target", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/app/dist/assets/offline.html");
    contents.emit("did-fail-load", {}, -106, "ERR_INTERNET_DISCONNECTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).toHaveBeenCalledWith("/app/dist/assets/offline.html", {
      query: { target: `${ORIGIN}/` },
    });
  });

  it("ignores subframe failures and ERR_ABORTED", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/x/offline.html");
    contents.emit("did-fail-load", {}, -106, "x", `${ORIGIN}/`, false);
    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", `${ORIGIN}/`, true);
    expect(contents.loadFile).not.toHaveBeenCalled();
  });

  it("ignores failures whose validatedURL is a file: URL, to avoid re-triggering itself", () => {
    const contents = fakeContents();
    attachOfflineFallback(contents as never, "/app/dist/assets/offline.html");
    contents.emit(
      "did-fail-load",
      {},
      -6,
      "ERR_FILE_NOT_FOUND",
      "file:///app/dist/assets/offline.html",
      true,
    );
    expect(contents.loadFile).not.toHaveBeenCalled();
  });
});
