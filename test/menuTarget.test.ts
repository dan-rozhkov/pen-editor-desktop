import { describe, it, expect } from "vitest";
import { shouldForwardMenuCommand } from "../src/main/menuTarget";

describe("shouldForwardMenuCommand", () => {
  it("forwards to editor tabs only", () => {
    expect(shouldForwardMenuCommand("editor")).toBe(true);
    expect(shouldForwardMenuCommand("doc")).toBe(false);
    expect(shouldForwardMenuCommand("browser")).toBe(false);
    expect(shouldForwardMenuCommand(null)).toBe(false);
  });
});
