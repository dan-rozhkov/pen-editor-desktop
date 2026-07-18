import { describe, it, expect } from "vitest";
import { resolveEditorUrl, DEFAULT_EDITOR_URL } from "../src/main/config";

describe("resolveEditorUrl", () => {
  it("defaults to the production URL", () => {
    expect(resolveEditorUrl({})).toBe(DEFAULT_EDITOR_URL);
    expect(DEFAULT_EDITOR_URL).toBe("https://pen-editor.onrender.com");
  });

  it("honors PEN_DESKTOP_URL", () => {
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "http://localhost:5173" })).toBe(
      "http://localhost:5173",
    );
  });

  it("ignores a non-http(s) or unparseable override", () => {
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "file:///etc/passwd" })).toBe(DEFAULT_EDITOR_URL);
    expect(resolveEditorUrl({ PEN_DESKTOP_URL: "not a url" })).toBe(DEFAULT_EDITOR_URL);
  });
});
