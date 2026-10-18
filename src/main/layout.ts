// Pure window geometry. window.ts only feeds it sizes and applies the result.
//
// Flag off (`panelWidth` null): the layout is exactly the historical one — tab
// bar across the full width at the top, tab views below it, no panel.
// Flag on: the tab bar (and the macOS rim) still span the FULL window width, so
// the traffic lights stay put; an agent chat panel sits below the tab bar on
// the left, and the tab views fill the area right of it.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const AGENT_PANEL_DEFAULT_WIDTH = 380;
export const AGENT_PANEL_MIN_WIDTH = 300;
/** The panel never takes more than this share of the window width. */
export const AGENT_PANEL_MAX_FRACTION = 0.5;

/**
 * Clamp a requested panel width to [MIN, 50% of the window]. In a window
 * narrower than 2 * MIN the 50% cap wins over the minimum (the tab area must
 * keep at least half the window). Non-finite requests fall back to the default.
 */
export function clampAgentPanelWidth(requested: number, windowWidth: number): number {
  const cap = Math.max(0, Math.floor(Math.max(0, windowWidth) * AGENT_PANEL_MAX_FRACTION));
  const wanted = Number.isFinite(requested) ? Math.round(requested) : AGENT_PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(wanted, AGENT_PANEL_MIN_WIDTH), cap);
}

export interface WindowLayoutInput {
  /** Window content size. */
  width: number;
  height: number;
  /** Tab bar height including the browser address row, when shown. */
  tabbarHeight: number;
  /** 1px rim on macOS, else 0. */
  edge: number;
  /** Requested panel width, or null for no panel (flag off). */
  panelWidth: number | null;
}

export interface WindowLayout {
  /** Null when there is no panel. Below the tab bar, inset by `edge` left and bottom. */
  panel: Rect | null;
  /** Always the full window width at the top. */
  tabbar: Rect;
  /** The backing view that paints the macOS rim, below the tab bar, full width. */
  rim: Rect;
  /** Where tab views go: right of the panel, below the tab bar, inset by `edge` left/right/bottom. */
  tabArea: Rect;
  /** Window x where the tab strip starts inside the tab bar (the panel's right edge; 0 without a panel). */
  tabStripLeft: number;
}

export function computeWindowLayout(input: WindowLayoutInput): WindowLayout {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const panelW = input.panelWidth === null ? 0 : clampAgentPanelWidth(input.panelWidth, width);
  const tabbarHeight = Math.min(Math.max(0, input.tabbarHeight), height);
  const edge = Math.max(0, input.edge);
  const belowBar = Math.max(0, height - tabbarHeight);
  const bodyHeight = Math.max(0, belowBar - edge);
  // The panel's own left inset is the rim; its right side ends at `panelW`.
  const panelX = Math.min(edge, panelW);
  // Tab views start one rim-width right of the panel (the gap shows the rim
  // colour as a divider); with no panel that is just the left inset.
  const tabX = Math.min(width, panelW + edge);
  return {
    panel:
      input.panelWidth === null
        ? null
        : { x: panelX, y: tabbarHeight, width: Math.max(0, panelW - panelX), height: bodyHeight },
    tabbar: { x: 0, y: 0, width, height: tabbarHeight },
    rim: { x: 0, y: tabbarHeight, width, height: belowBar },
    tabArea: { x: tabX, y: tabbarHeight, width: Math.max(0, width - tabX - edge), height: bodyHeight },
    tabStripLeft: panelW,
  };
}
