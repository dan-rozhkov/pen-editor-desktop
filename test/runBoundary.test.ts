import { describe, expect, it } from "vitest";
import { createRunBoundary } from "../src/main/runBoundary";

describe("run boundary", () => {
  it("the first command of a scope starts a run", () => {
    const b = createRunBoundary(1000);
    expect(b.commandStart("a", 0)).toBe(true);
  });
  it("commands inside the gap continue the run", () => {
    const b = createRunBoundary(1000);
    b.commandStart("a", 0);
    b.commandEnd("a", 100);
    expect(b.commandStart("a", 900)).toBe(false);
    b.commandEnd("a", 950);
  });
  it("a command after an idle gap starts a new run", () => {
    const b = createRunBoundary(1000);
    b.commandStart("a", 0);
    b.commandEnd("a", 100);
    expect(b.commandStart("a", 1100)).toBe(true);
  });
  it("a command overlapping a running one never starts a run", () => {
    const b = createRunBoundary(1000);
    b.commandStart("a", 0);
    expect(b.commandStart("a", 5000)).toBe(false);
  });
  it("scopes are independent and forget resets", () => {
    const b = createRunBoundary(1000);
    b.commandStart("a", 0);
    expect(b.commandStart("b", 1)).toBe(true);
    b.commandEnd("a", 2);
    b.forget("a");
    expect(b.commandStart("a", 3)).toBe(true);
  });
});
