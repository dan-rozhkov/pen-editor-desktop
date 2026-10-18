import { describe, expect, it } from "vitest";
import { FixtureOwners } from "../src/main/fixtureOwners";

const ok = (token?: string) => ({ ok: true, fixtureToken: token });

describe("FixtureOwners", () => {
  it("a successful apply is owned; takeOwnedBy releases it once", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    expect(o.finishApply(t, 1, ok("a"))).toBeNull();
    expect(o.takeOwnedBy(2)).toBeNull();
    expect(o.takeOwnedBy(1)).toEqual({ token: "a" });
    expect(o.takeOwnedBy(1)).toBeNull();
  });

  it("a failed apply owns nothing", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    expect(o.finishApply(t, 1, { ok: false })).toBeNull();
    expect(o.takeOwnedBy(1)).toBeNull();
  });

  it("owner goes away DURING the apply: finishApply returns the release", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    expect(o.takeOwnedBy(1)).toBeNull(); // token unknown yet; marked
    expect(o.finishApply(t, 1, ok("a"))).toEqual({ token: "a" });
    expect(o.takeOwnedBy(1)).toBeNull(); // nothing left owned
  });

  it("owner no longer alive when the apply ends (closed, no release event seen): released at once", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    expect(o.finishApply(t, 1, ok("a"), false)).toEqual({ token: "a" });
    expect(o.takeOwnedBy(1)).toBeNull();
  });

  it("a failed apply of a departed owner releases nothing", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    o.takeOwnedBy(1);
    expect(o.finishApply(t, 1, { ok: false })).toBeNull();
  });

  it("another sender going away during the apply does not touch it", () => {
    const o = new FixtureOwners();
    const t = o.beginApply(1);
    expect(o.takeOwnedBy(2)).toBeNull();
    expect(o.finishApply(t, 1, ok("a"))).toBeNull();
    expect(o.takeOwnedBy(1)).toEqual({ token: "a" });
  });

  it("a superseded apply does not claim ownership", () => {
    const o = new FixtureOwners();
    const t1 = o.beginApply(1);
    const t2 = o.beginApply(2);
    expect(o.finishApply(t1, 1, ok("a"))).toBeNull();
    expect(o.finishApply(t2, 2, ok("b"))).toBeNull();
    expect(o.takeOwnedBy(1)).toBeNull();
    expect(o.takeOwnedBy(2)).toEqual({ token: "b" });
  });

  it("released(token) drops only a matching fixture; no token drops any (not an in-flight apply)", () => {
    const o = new FixtureOwners();
    o.finishApply(o.beginApply(1), 1, ok("a"));
    o.released("x");
    expect(o.takeOwnedBy(1)).toEqual({ token: "a" });
    o.finishApply(o.beginApply(1), 1, ok("a"));
    o.released();
    expect(o.takeOwnedBy(1)).toBeNull();
    const t = o.beginApply(1);
    o.released();
    expect(o.finishApply(t, 1, ok("c"))).toBeNull();
    expect(o.takeOwnedBy(1)).toEqual({ token: "c" });
  });
});
