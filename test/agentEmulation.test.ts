import { describe, expect, it } from "vitest";
import { createAgentEmulationTracker } from "../src/main/agentEmulation";

const M = "Emulation.setDeviceMetricsOverride";
const UA = "Emulation.setUserAgentOverride";
const MEDIA = "Emulation.setEmulatedMedia";

describe("agent emulation tracker", () => {
  it("resets only the tabs the fixture overrode, on a matching release", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    t.note(1, M);
    t.note(2, UA);
    t.note(3, MEDIA);
    expect(t.finishApply({ ok: true, fixtureToken: "fixture-1" })).toEqual([]);
    expect(t.release("fixture-1").sort()).toEqual([1, 2]);
    expect(t.release("fixture-1")).toEqual([]);
  });

  it("a colour-scheme-only emulate never resets anything", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    t.note(1, MEDIA);
    t.note(1, "Emulation.setLocaleOverride");
    t.finishApply({ ok: true, fixtureToken: "fixture-1" });
    expect(t.release()).toEqual([]);
  });

  it("a stale token does not reset; a tokenless release does", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    t.note(1, M);
    t.finishApply({ ok: true, fixtureToken: "fixture-2" });
    expect(t.release("fixture-1")).toEqual([]);
    expect(t.release()).toEqual([1]);
  });

  it("ignores CDP calls outside an apply window", () => {
    const t = createAgentEmulationTracker();
    t.note(1, M);
    t.beginApply();
    t.finishApply({ ok: true, fixtureToken: "fixture-1" });
    expect(t.release()).toEqual([]);
  });

  it("a new apply returns the previous fixture's tabs (the controller releases it first)", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    t.note(1, M);
    t.finishApply({ ok: true, fixtureToken: "fixture-1" });
    expect(t.beginApply()).toEqual([1]);
    t.note(2, M);
    t.finishApply({ ok: true, fixtureToken: "fixture-2" });
    expect(t.release("fixture-1")).toEqual([]);
    expect(t.release("fixture-2")).toEqual([2]);
  });

  it("a failed apply does not become active; tabs it touched are returned once", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    t.note(1, M);
    expect(t.finishApply({ ok: false, stage: "emulate", error: "x" })).toEqual([1]);
    expect(t.release()).toEqual([]);
  });

  it("a failed apply that set nothing returns nothing", () => {
    const t = createAgentEmulationTracker();
    t.beginApply();
    expect(t.finishApply({ ok: false, stage: "validate", error: "x" })).toEqual([]);
  });
});
