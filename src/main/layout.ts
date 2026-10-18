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
/** Glass + islands: gap between the islands and to the window edges, and their corner radius (px). */
export const ISLAND_GAP = 8;
export const ISLAND_RADIUS = 12;

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
  /**
   * Islands mode: height of the tab row alone (without the browser address row).
   * The panel island starts here; only the tab area starts at `tabbarHeight`.
   * Defaults to `tabbarHeight`.
   */
  tabRowHeight?: number;
  /** 1px rim on macOS, else 0. */
  edge: number;
  /** Requested panel width, or null for no panel (flag off). */
  panelWidth: number | null;
  /**
   * Glass + islands (agent layout): the panel and the tab area become rounded
   * "islands" on the translucent window, `gap` px apart and `gap` px from the
   * left/right/bottom window edges. Ignored without a panel. `edge` is not
   * used in this mode (no rim).
   */
  islands?: { gap: number; radius: number } | null;
}

export interface WindowLayout {
  /** Null when there is no panel. Below the tab bar, inset by `edge` left and bottom. */
  panel: Rect | null;
  /** Always the full window width at the top. */
  tabbar: Rect;
  /** The backing view that paints the macOS rim, below the tab bar, full width. */
  rim: Rect | null;
  /** False when the panel is collapsed (islands mode, panelWidth 0): the panel view must be hidden. */
  panelVisible: boolean;
  /** Corner radius of the panel / tab-area islands; 0 when not in glass mode. */
  radius: number;
  /** Where tab views go: right of the panel, below the tab bar, inset by `edge` left/right/bottom. */
  tabArea: Rect;
  /** What `TabManager.layout` applies: `tabArea`, plus `radius` px upward under the address row in islands mode. */
  tabView: Rect;
  /** Window x where the tab strip starts inside the tab bar (the panel's right edge; 0 without a panel). */
  tabStripLeft: number;
}

function computeIslandLayout(input: WindowLayoutInput, gapIn: number, radiusIn: number): WindowLayout {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const gap = Math.max(0, gapIn);
  const radius = Math.max(0, radiusIn);
  const tabbarHeight = Math.min(Math.max(0, input.tabbarHeight), height);
  const rowHeight = Math.min(Math.max(0, input.tabRowHeight ?? tabbarHeight), tabbarHeight);
  // Collapsed panel: width 0 (the view is hidden, not destroyed); the tab island then keeps only the left gap.
  const collapsed = input.panelWidth === 0;
  const avail = Math.max(0, width - 3 * gap);
  const panelW = collapsed ? 0 : Math.min(clampAgentPanelWidth(input.panelWidth as number, width), avail);
  const panelX = Math.min(gap, width);
  const tabX = collapsed ? panelX : Math.min(width, panelX + panelW + gap);
  const tabW = Math.max(0, width - tabX - gap);
  const tabBodyH = Math.max(0, height - tabbarHeight - gap);
  // With an address row the tab VIEW starts `radius` px higher, under the row (the row,
  // in the tab bar view above it, is the top of the island and hides the view's rounded
  // top corners); the visible island content still starts at `tabbarHeight`.
  const overlap = tabbarHeight > rowHeight ? Math.min(radius, tabbarHeight - rowHeight) : 0;
  return {
    panel: { x: panelX, y: rowHeight, width: panelW, height: Math.max(0, height - rowHeight - gap) },
    panelVisible: panelW > 0,
    tabbar: { x: 0, y: 0, width, height: tabbarHeight },
    rim: null,
    radius,
    tabArea: { x: tabX, y: tabbarHeight, width: tabW, height: tabBodyH },
    tabView: { x: tabX, y: tabbarHeight - overlap, width: tabW, height: tabBodyH + overlap },
    tabStripLeft: tabX,
  };
}

export function computeWindowLayout(input: WindowLayoutInput): WindowLayout {
  if (input.panelWidth !== null && input.islands) return computeIslandLayout(input, input.islands.gap, input.islands.radius);
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
  const tabArea = { x: tabX, y: tabbarHeight, width: Math.max(0, width - tabX - edge), height: bodyHeight };
  return {
    panel:
      input.panelWidth === null
        ? null
        : { x: panelX, y: tabbarHeight, width: Math.max(0, panelW - panelX), height: bodyHeight },
    tabbar: { x: 0, y: 0, width, height: tabbarHeight },
    panelVisible: input.panelWidth !== null,
    rim: { x: 0, y: tabbarHeight, width, height: belowBar },
    radius: 0,
    tabArea: tabArea,
    tabView: tabArea,
    tabStripLeft: panelW,
  };
}

/** Value of the tab bar's `data-layout` attribute (carried by the `tabbar:state` snapshot); absent with the flag off. */
export function tabbarLayoutKind(agentLayout: boolean): "agent" | undefined {
  return agentLayout ? "agent" : undefined;
}

/**
 * Agent panel collapsed state -> the width fed to `computeWindowLayout`:
 * 0 when collapsed (islands mode: the panel view is hidden, the tab island takes the width),
 * else the default width.
 */
export function agentPanelWidthFor(collapsed: boolean): number {
  return collapsed ? 0 : AGENT_PANEL_DEFAULT_WIDTH;
}
