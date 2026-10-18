// Pure window geometry. window.ts only feeds it sizes and applies the result.
//
// The tab bar spans the FULL window width, so the traffic lights stay put; the
// agent chat panel and the tab area are rounded "islands" on the translucent
// window glass below it (panel on the left, tab views right of it).

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
  /** Requested panel width; 0 = collapsed. */
  panelWidth: number;
  /**
   * The panel and the tab area are rounded "islands" on the translucent
   * window, `gap` px apart and `gap` px from the left/right/bottom window edges.
   */
  islands: { gap: number; radius: number };
}

export interface WindowLayout {
  /** Below the tab row, inset by `gap` left and bottom. */
  panel: Rect;
  /** Always the full window width at the top. */
  tabbar: Rect;
  /** False when the panel is collapsed (islands mode, panelWidth 0): the panel view must be hidden. */
  panelVisible: boolean;
  /** Island gap (px). Sent to the tab bar (CSS `--island-gap`). */
  gap: number;
  /** Height of the island-colour tail the tab bar page paints under the address row (0 without a row). */
  tabTail: number;
  /** Corner radius of the panel / tab-area islands. */
  radius: number;
  /** Where tab views go: right of the panel, below the tab bar, inset by `gap` left/right/bottom. */
  tabArea: Rect;
  /** Window x where the tab strip starts inside the tab bar (the panel's right edge). */
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
  const panelW = collapsed ? 0 : Math.min(clampAgentPanelWidth(input.panelWidth, width), avail);
  const panelX = Math.min(gap, width);
  const tabX = collapsed ? panelX : Math.min(width, panelX + panelW + gap);
  const tabW = Math.max(0, width - tabX - gap);
  const tabBodyH = Math.max(0, height - tabbarHeight - gap);
  // With an address row the tab bar view reaches `radius` px below the row: the row is the top
  // of the tab island and that tail (island colour, drawn by the tab bar page) fills the notches
  // under the tab view's rounded top corners. The tab view itself starts exactly below the row
  // (`tabArea`): no page content is ever hidden.
  const tail = tabbarHeight > rowHeight ? Math.min(radius, Math.max(0, height - tabbarHeight)) : 0;
  return {
    panel: { x: panelX, y: rowHeight, width: panelW, height: Math.max(0, height - rowHeight - gap) },
    panelVisible: panelW > 0,
    tabbar: { x: 0, y: 0, width, height: tabbarHeight + tail },
    radius,
    gap,
    tabTail: tail,
    tabArea: { x: tabX, y: tabbarHeight, width: tabW, height: tabBodyH },
    tabStripLeft: tabX,
  };
}

export function computeWindowLayout(input: WindowLayoutInput): WindowLayout {
  return computeIslandLayout(input, input.islands.gap, input.islands.radius);
}

/**
 * Agent panel collapsed state -> the width fed to `computeWindowLayout`:
 * 0 when collapsed (islands mode: the panel view is hidden, the tab island takes the width),
 * else the default width.
 */
export function agentPanelWidthFor(collapsed: boolean): number {
  return collapsed ? 0 : AGENT_PANEL_DEFAULT_WIDTH;
}
