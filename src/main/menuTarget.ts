import type { TabKind } from "./tabManager";

/**
 * File-menu items forward pen-editor command-palette ids (file-open, file-export-*,
 * token import/export). Those exist only in the canvas editor, so only an editor
 * tab receives them; a document or browser tab is a no-op.
 */
export function shouldForwardMenuCommand(activeKind: TabKind | null): boolean {
  return activeKind === "editor";
}
