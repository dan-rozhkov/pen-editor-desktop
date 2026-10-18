import type { UITheme } from "./tabManager";

/** Where keyboard focus goes when the empty view appears (see `decideEmptyFocus`). */
export type EmptyFocusTarget = "empty" | "panel" | "none";

export interface EmptyViewState {
  visible: boolean;
  theme: UITheme;
  /**
   * Background isolated-session tabs still open while no tab is active. They are
   * never auto-activated, so "no active tab" does not mean "no tabs": the
   * placeholder must not claim otherwise.
   */
  sessionTabs: number;
}

export interface EmptyViewUpdate {
  /** Set only when the theme changed. */
  theme?: UITheme;
  /** Set only when visibility changed. */
  visible?: boolean;
  /** Set only when the session-tab count changed. */
  sessionTabs?: number;
  /** Where keyboard focus moves (only ever not "none" when the view just appeared). */
  focus: EmptyFocusTarget;
}

/**
 * Focus when the placeholder appears. Only the USER closing the last tab (close
 * button, Cmd/Ctrl+W, menu) hands focus to the placeholder's buttons. Agent
 * driven closes (browser tabs, fixture resets) and the window's first push
 * leave the person in the chat, so focus goes to the agent panel. Nothing
 * changes when the view was already visible or stays hidden.
 */
export function decideEmptyFocus(appeared: boolean, userClosedTab: boolean): EmptyFocusTarget {
  if (!appeared) return "none";
  return userClosedTab ? "empty" : "panel";
}

/**
 * Diffs the view's last applied state against the wanted one, so each side
 * effect runs only on change. Also the single place that turns "no active tab"
 * into visibility: the placeholder shows exactly while `activeId` is null.
 */
export function planEmptyViewUpdate(
  prev: EmptyViewState,
  next: EmptyViewState,
  userClosedTab: boolean,
): EmptyViewUpdate {
  const update: EmptyViewUpdate = { focus: decideEmptyFocus(next.visible && !prev.visible, userClosedTab) };
  if (prev.theme !== next.theme) update.theme = next.theme;
  if (prev.visible !== next.visible) update.visible = next.visible;
  if (prev.sessionTabs !== next.sessionTabs) update.sessionTabs = next.sessionTabs;
  return update;
}

/** `tabbar:new` / `tabbar:new-browser` come from the tab bar or the empty-state view of the same window. */
export function isTabCreationSender(senderId: number, tabbarId: number, emptyId: number | undefined): boolean {
  return senderId === tabbarId || (emptyId !== undefined && senderId === emptyId);
}

/** Where focus actually goes once the collapsed state of the agent panel is known. "tab" = the active tab view keeps/gets it. */
export type FocusTarget = "empty" | "panel" | "tab" | "none";

/** Never focus the hidden (collapsed) panel: use the placeholder when it is shown, else the active tab. */
export function resolveFocusTarget(desired: EmptyFocusTarget, panelCollapsed: boolean, emptyVisible: boolean): FocusTarget {
  if (desired === "none") return "none";
  if (desired === "panel" && panelCollapsed) return emptyVisible ? "empty" : "tab";
  return desired;
}

/** Focus after the panel was collapsed while it had focus. */
export function focusAfterCollapse(emptyVisible: boolean): "empty" | "tab" {
  return emptyVisible ? "empty" : "tab";
}
