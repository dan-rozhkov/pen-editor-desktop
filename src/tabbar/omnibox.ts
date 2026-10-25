// Pure keyboard and inline-completion logic of the address-bar suggestion popover. Its own
// plain global script, loaded before renderer.js in tabbar.html, like urlNormalization.ts: no
// top-level import/export, so tsc emits it as a plain script. The guarded assignment at the
// bottom only lets vitest (Node/CommonJS) import the functions.
type OmniboxKeyState = { open: boolean; count: number; selected: number };
type OmniboxKeyAction =
  | { type: "move"; selected: number }
  | { type: "pick" }
  | { type: "remove" }
  | { type: "close" }
  | { type: "none" };

/** What a key press in the address field does while the popover is `open`. `selected` -1 = no row
 * selected (the typed text); the arrows wrap through it: last row -> -1 -> first row. */
function omniboxKeyAction(key: string, shiftKey: boolean, state: OmniboxKeyState): OmniboxKeyAction {
  if (!state.open) return { type: "none" };
  if (key === "Escape") return { type: "close" };
  if (state.count <= 0) return { type: "none" };
  if (key === "ArrowDown") {
    return { type: "move", selected: state.selected + 1 >= state.count ? -1 : state.selected + 1 };
  }
  if (key === "ArrowUp") {
    return { type: "move", selected: state.selected < 0 ? state.count - 1 : state.selected - 1 };
  }
  if (key === "Enter") return state.selected >= 0 ? { type: "pick" } : { type: "none" };
  if (shiftKey && (key === "Delete" || key === "Backspace")) {
    return state.selected >= 0 ? { type: "remove" } : { type: "none" };
  }
  return { type: "none" };
}

/** The field value after inline completion: the typed text plus the completed tail, the tail
 * selected so the next keystroke replaces it. Null = leave the field alone (a deletion never
 * completes, nor does a caret that is not at the end of the field, an empty field or an `inline` that does not extend what was typed). */
function applyInlineCompletion(
  typed: string,
  inline: string | null,
  wasDeletion: boolean,
  caretAtEnd = true,
): { value: string; selectionStart: number; selectionEnd: number } | null {
  if (wasDeletion || !caretAtEnd || !inline || !typed) return null;
  if (inline.length <= typed.length) return null;
  if (inline.slice(0, typed.length).toLowerCase() !== typed.toLowerCase()) return null;
  return { value: typed + inline.slice(typed.length), selectionStart: typed.length, selectionEnd: inline.length };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports.omniboxKeyAction = omniboxKeyAction;
  module.exports.applyInlineCompletion = applyInlineCompletion;
}
