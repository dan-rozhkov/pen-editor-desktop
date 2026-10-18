import type { TabsSnapshot, UITheme } from "./tabManager";

/** The empty-state placeholder shows while no tab is active (agent layout). */
export function emptyViewVisible(snapshot: Pick<TabsSnapshot, "activeId">): boolean {
  return snapshot.activeId === null;
}

/** A window that opens with zero tabs emits nothing from TabManager: push the first snapshot by hand. */
export function shouldPushInitialSnapshot(initialTabCount: number): boolean {
  return initialTabCount === 0;
}

export interface EmptyViewState {
  visible: boolean;
  theme: UITheme;
}

export interface EmptyViewUpdate {
  /** Set only when the theme changed. */
  theme?: UITheme;
  /** Set only when visibility changed. */
  visible?: boolean;
  /** The view just appeared: move keyboard focus to it. */
  focus: boolean;
}

/** Diffs the view's last applied state against the wanted one, so each side effect runs only on change. */
export function planEmptyViewUpdate(prev: EmptyViewState, next: EmptyViewState): EmptyViewUpdate {
  const update: EmptyViewUpdate = { focus: next.visible && !prev.visible };
  if (prev.theme !== next.theme) update.theme = next.theme;
  if (prev.visible !== next.visible) update.visible = next.visible;
  return update;
}

/** `tabbar:new` / `tabbar:new-browser` come from the tab bar or the empty-state view of the same window. */
export function isTabCreationSender(senderId: number, tabbarId: number, emptyId: number | undefined): boolean {
  return senderId === tabbarId || (emptyId !== undefined && senderId === emptyId);
}
