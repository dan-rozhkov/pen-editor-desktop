import { describe, it, expect } from "vitest";

// Plain global script loaded through its guarded module.exports, like urlNormalization.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const omnibox = require("../src/tabbar/omnibox.ts") as {
  omniboxKeyAction: (
    key: string,
    shiftKey: boolean,
    state: { open: boolean; count: number; selected: number },
  ) => { type: string; selected?: number };
  applyInlineCompletion: (
    typed: string,
    inline: string | null,
    wasDeletion: boolean,
    caretAtEnd?: boolean,
  ) => { value: string; selectionStart: number; selectionEnd: number } | null;
};
const { omniboxKeyAction: act, applyInlineCompletion } = omnibox;
const open = (count: number, selected: number) => ({ open: true, count, selected });

describe("omniboxKeyAction", () => {
  it("moves down and wraps through -1", () => {
    expect(act("ArrowDown", false, open(3, -1))).toEqual({ type: "move", selected: 0 });
    expect(act("ArrowDown", false, open(3, 1))).toEqual({ type: "move", selected: 2 });
    expect(act("ArrowDown", false, open(3, 2))).toEqual({ type: "move", selected: -1 });
  });
  it("moves up and wraps through -1", () => {
    expect(act("ArrowUp", false, open(3, 2))).toEqual({ type: "move", selected: 1 });
    expect(act("ArrowUp", false, open(3, 0))).toEqual({ type: "move", selected: -1 });
    expect(act("ArrowUp", false, open(3, -1))).toEqual({ type: "move", selected: 2 });
  });
  it("Enter picks only a selected row", () => {
    expect(act("Enter", false, open(3, 1))).toEqual({ type: "pick" });
    expect(act("Enter", false, open(3, -1))).toEqual({ type: "none" });
  });
  it("Escape closes an open popover only", () => {
    expect(act("Escape", false, open(3, -1))).toEqual({ type: "close" });
    expect(act("Escape", false, { open: false, count: 0, selected: -1 })).toEqual({ type: "none" });
  });
  it("Shift+Delete and Shift+Backspace remove the selected row", () => {
    expect(act("Delete", true, open(3, 0))).toEqual({ type: "remove" });
    expect(act("Backspace", true, open(3, 2))).toEqual({ type: "remove" });
    expect(act("Delete", true, open(3, -1))).toEqual({ type: "none" });
    expect(act("Delete", false, open(3, 0))).toEqual({ type: "none" });
  });
  it("does nothing while closed or without rows, and ignores other keys", () => {
    expect(act("ArrowDown", false, { open: false, count: 3, selected: -1 })).toEqual({ type: "none" });
    expect(act("ArrowDown", false, open(0, -1))).toEqual({ type: "none" });
    expect(act("a", false, open(3, 0))).toEqual({ type: "none" });
  });
});

describe("applyInlineCompletion", () => {
  it("completes the typed prefix and selects the tail", () => {
    expect(applyInlineCompletion("git", "github.com/", false)).toEqual({ value: "github.com/", selectionStart: 3, selectionEnd: 11 });
  });
  it("keeps the typed casing", () => {
    expect(applyInlineCompletion("GIT", "github.com/", false)).toEqual({ value: "GIThub.com/", selectionStart: 3, selectionEnd: 11 });
  });
  it("does not complete when the caret is not at the end of the field", () => {
    expect(applyInlineCompletion("git", "github.com/", false, false)).toBeNull();
    expect(applyInlineCompletion("git", "github.com/", false, true)).not.toBeNull();
  });
  it("does not complete after a deletion, an empty field or a null answer", () => {
    expect(applyInlineCompletion("git", "github.com/", true)).toBeNull();
    expect(applyInlineCompletion("", "github.com/", false)).toBeNull();
    expect(applyInlineCompletion("git", null, false)).toBeNull();
  });
  it("ignores an answer that does not extend the typed text", () => {
    expect(applyInlineCompletion("git", "gitlab.com/", false)?.value).toBe("gitlab.com/");
    expect(applyInlineCompletion("git", "example.com/", false)).toBeNull();
    expect(applyInlineCompletion("github.com/", "github.com/", false)).toBeNull();
  });
});
