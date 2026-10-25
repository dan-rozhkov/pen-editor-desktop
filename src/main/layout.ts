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
/** Tab strip row height (the panel island starts here). */
export const TAB_ROW_HEIGHT = 38;
/**
 * Browser address row height = the agent chat header row of the frontend (ChatPanel `OpenChatHeader`:
 * `py-1.5` 6+6, a 28px `size-7` icon button, `border-b` 1) = 41. Both header rows start at the tab
 * row height, so their bottom borders sit on one line across the window.
 */
export const ADDRESS_ROW_HEIGHT = 41;

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
  /** Address row height (px) the tab bar page uses (CSS `--address-row-height`); 0 without a row. */
  addressRowHeight: number;
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
  const addressRowHeight = tabbarHeight - rowHeight;
  const tail = addressRowHeight > 0 ? Math.min(radius, Math.max(0, height - tabbarHeight)) : 0;
  return {
    panel: { x: panelX, y: rowHeight, width: panelW, height: Math.max(0, height - rowHeight - gap) },
    panelVisible: panelW > 0,
    tabbar: { x: 0, y: 0, width, height: tabbarHeight + tail },
    radius,
    gap,
    addressRowHeight,
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


/** Address-bar suggestion popover (its own WebContentsView, so it is not clipped to the tab bar's height). */
export const OMNIBOX_ROW_HEIGHT = 40;
/** Transparent margin around the popover card inside its view, room for the shadow. */
export const OMNIBOX_SHADOW_PAD = 8;
const OMNIBOX_MIN_CARD_WIDTH = 420;
const OMNIBOX_HEADER_HEIGHT = 28;
const OMNIBOX_FOOTER_HEIGHT = 36;
/** Card padding top/bottom, the gap under the URL field, and the card's distance to the window edges. */
const OMNIBOX_CARD_PADDING = 4;
const OMNIBOX_FIELD_GAP = 4;
const OMNIBOX_WINDOW_MARGIN = 8;

/**
 * Bounds of the popover view for `rowCount` suggestion rows. `rect` is the URL field's bottom-left
 * corner and width in window coordinates (`y` = the field's bottom). The card is at least 420 wide
 * and stays 8px inside the window; the view is the card plus the shadow margin on every side, and
 * is cut off 8px above the window bottom (the card then clips its rows).
 */
export function omniboxBounds(
  rect: { x: number; y: number; width: number },
  rowCount: number,
  hasHeader: boolean,
  window: { width: number; height: number },
): Rect {
  const cardWidth = Math.max(0, Math.min(Math.max(rect.width, OMNIBOX_MIN_CARD_WIDTH), window.width - 2 * OMNIBOX_WINDOW_MARGIN));
  const cardX = Math.max(OMNIBOX_WINDOW_MARGIN, Math.min(rect.x, window.width - OMNIBOX_WINDOW_MARGIN - cardWidth));
  const cardY = rect.y + OMNIBOX_FIELD_GAP;
  const cardHeight =
    OMNIBOX_CARD_PADDING + (hasHeader ? OMNIBOX_HEADER_HEIGHT : 0) + rowCount * OMNIBOX_ROW_HEIGHT + 1 + OMNIBOX_FOOTER_HEIGHT + OMNIBOX_CARD_PADDING;
  const y = cardY - OMNIBOX_SHADOW_PAD;
  const height = Math.max(0, Math.min(cardHeight + 2 * OMNIBOX_SHADOW_PAD, window.height - OMNIBOX_WINDOW_MARGIN - y));
  return { x: cardX - OMNIBOX_SHADOW_PAD, y, width: cardWidth + 2 * OMNIBOX_SHADOW_PAD, height };
}
