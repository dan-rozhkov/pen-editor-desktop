import { describe, expect, it } from "vitest";
import {
  getCookies,
  resetSession,
  setCookies,
  toElectronCookie,
  toFixtureCookie,
  type ElectronCookieLike,
  type SessionLike,
  type TabOps,
} from "../src/main/fixtureSession";

function fakeSession(initial: (ElectronCookieLike & { origin: string })[]) {
  const jar = [...initial];
  const cleared: { origin?: string; storages: string[] }[] = [];
  const set: unknown[] = [];
  const ses: SessionLike = {
    cookies: {
      get: async ({ url, domain }) =>
        url
          ? jar.filter((c) => new URL(url).origin === c.origin)
          : domain
            ? jar.filter((c) => new URL(c.origin).hostname === domain)
            : jar,
      set: async (d) => void set.push(d),
      remove: async (url, name) => {
        const u = new URL(url);
        const i = jar.findIndex((c) => c.name === name && u.hostname === new URL(c.origin).hostname && u.pathname === (c.path ?? "/"));
        if (i >= 0) jar.splice(i, 1);
      },
    },
    clearStorageData: async (o) => void cleared.push(o),
  };
  return { ses, jar, cleared, set };
}

describe("cookie mapping", () => {
  it("maps electron to fixture", () => {
    expect(
      toFixtureCookie({ name: "a", value: "1", domain: ".x.com", path: "/", expirationDate: 5, sameSite: "no_restriction", secure: true }),
    ).toMatchObject({ sameSite: "None", expires: 5, domain: ".x.com" });
    expect(toFixtureCookie({ name: "a", value: "1", sameSite: "lax" }).sameSite).toBe("Lax");
    expect(toFixtureCookie({ name: "a", value: "1", sameSite: "strict" }).sameSite).toBe("Strict");
    expect("sameSite" in toFixtureCookie({ name: "a", value: "1", sameSite: "unspecified" })).toBe(false);
  });

  it("maps fixture to electron, building a url from a domain-only cookie", () => {
    expect(toElectronCookie({ name: "a", value: "1", domain: ".x.com", path: "/p", sameSite: "None", expires: 9 })).toMatchObject({
      url: "http://x.com/p",
      sameSite: "no_restriction",
      expirationDate: 9,
    });
    expect(toElectronCookie({ name: "a", value: "1", domain: "x.com", secure: true }).url).toBe("https://x.com/");
    expect(toElectronCookie({ name: "a", value: "1", url: "http://localhost:3000/" }).url).toBe("http://localhost:3000/");
  });

  it("keeps a host-only cookie host-only in both directions", async () => {
    const fx = toFixtureCookie({ name: "a", value: "1", domain: "x.com", hostOnly: true, path: "/p", secure: true });
    expect(fx.domain).toBeUndefined();
    expect(fx.url).toBe("https://x.com/p");
    expect("domain" in toElectronCookie(fx)).toBe(false);
  });

  it("sets a __Host- cookie without a domain; an explicit domain is still passed", () => {
    expect("domain" in toElectronCookie({ name: "__Host-s", value: "1", domain: "x.com", url: "https://x.com/" })).toBe(false);
    expect(toElectronCookie({ name: "a", value: "1", domain: ".x.com", url: "https://x.com/" }).domain).toBe(".x.com");
  });

  it("getCookies dedupes across urls; setCookies sets each", async () => {
    const { ses, set } = fakeSession([{ name: "a", value: "1", domain: "x.com", path: "/", origin: "http://x.com" }]);
    expect(await getCookies(ses, ["http://x.com/a", "http://x.com/b"])).toHaveLength(1);
    await setCookies(ses, [{ name: "n", value: "v", url: "http://x.com/" }]);
    expect(set).toHaveLength(1);
  });
});

describe("resetSession", () => {
  const mkTabs = () => {
    const log: string[] = [];
    const tabs: TabOps = {
      listBrowserTabIds: () => [3, 4],
      closeTab: async (id) => void log.push(`close ${id}`),
      openBlankTab: async () => void log.push("open"),
    };
    return { tabs, log };
  };

  it("clears only the given origins; other sites survive", async () => {
    const { ses, jar, cleared } = fakeSession([
      { name: "mine", value: "1", domain: "app.test", path: "/", origin: "http://app.test" },
      { name: "bank", value: "2", domain: "bank.com", path: "/", secure: true, origin: "https://bank.com" },
    ]);
    const { tabs, log } = mkTabs();
    await resetSession(ses, tabs, ["http://app.test"]);
    expect(jar.map((c) => c.name)).toEqual(["bank"]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].origin).toBe("http://app.test");
    expect(log).toEqual(["close 3", "close 4", "open"]);
  });

  it("keeps parent-domain cookies; removes host and .host cookies", async () => {
    const o = "https://app.example.com";
    const { ses, jar } = fakeSession([
      { name: "hostonly", value: "1", domain: "app.example.com", path: "/", secure: true, origin: o },
      { name: "dothost", value: "2", domain: ".app.example.com", path: "/", secure: true, origin: o },
      { name: "parent", value: "3", domain: ".example.com", path: "/", secure: true, origin: o },
    ]);
    await resetSession(ses, mkTabs().tabs, [o]);
    expect(jar.map((c) => c.name)).toEqual(["parent"]);
  });

  it("removes path-scoped and Secure cookies of the origin", async () => {
    const o = "https://app.test";
    const { ses, jar } = fakeSession([
      { name: "scoped", value: "1", domain: "app.test", path: "/app", origin: o },
      { name: "sec", value: "2", domain: "app.test", path: "/", secure: true, origin: o },
      { name: "parent", value: "3", domain: ".test", path: "/", secure: true, origin: o },
    ]);
    await resetSession(ses, mkTabs().tabs, [o]);
    expect(jar.map((c) => c.name)).toEqual(["parent"]);
  });

  it("throws on an invalid origin before closing any tab", async () => {
    const { ses, cleared } = fakeSession([]);
    const { tabs, log } = mkTabs();
    await expect(resetSession(ses, tabs, ["http://ok.test", "not a url"])).rejects.toThrow(/invalid origin/);
    await expect(resetSession(ses, tabs, ["ftp://x.test"])).rejects.toThrow(/http/);
    expect(log).toEqual([]);
    expect(cleared).toHaveLength(0);
  });

  it("with no origins clears nothing but still resets tabs", async () => {
    const { ses, jar, cleared } = fakeSession([{ name: "k", value: "1", domain: "a.com", origin: "http://a.com" }]);
    const { tabs, log } = mkTabs();
    await resetSession(ses, tabs);
    await resetSession(ses, tabs, []);
    expect(jar).toHaveLength(1);
    expect(cleared).toHaveLength(0);
    expect(log).toContain("open");
  });

  it("never clears storage without an origin", async () => {
    const { ses, cleared } = fakeSession([]);
    await resetSession(ses, mkTabs().tabs, ["http://a.com", "http://b.com"]);
    expect(cleared.every((c) => typeof c.origin === "string")).toBe(true);
  });
});
