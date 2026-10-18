import type { MenuItemConstructorOptions } from "electron";

/**
 * The browser chrome row's "Browser tools" popup: Viewport emulation, Developer
 * Tools and Zoom for the ACTIVE BROWSER tab. Pure (no Electron runtime imports)
 * so the template and the CDP command plan are unit-testable; window.ts supplies
 * the state and the actions. A native menu for the same reason as the "+" menu:
 * an HTML popup would be clipped to the tab bar view's height.
 */

export type ViewportPresetId = "responsive" | "iphone-15" | "pixel-8" | "ipad" | "desktop-1440" | "desktop-1920";

export interface ViewportPreset {
  id: ViewportPresetId;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  /** Mobile presets only: the identity the page sees. null = no override. */
  identity: MobileIdentity | null;
}

export interface MobileIdentity {
  userAgent: string;
  /** navigator.platform */
  platform: string;
  /** userAgentMetadata.platform */
  uaPlatform: "iOS" | "Android";
  platformVersion: string;
  model: string;
}

// Numbers match the @sideform/browser-agent device presets.
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "iphone-15", label: "iPhone 15 — 393×852", width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
    identity: { platform: "iPhone", uaPlatform: "iOS", platformVersion: "17.0.0", model: "iPhone",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } },
  { id: "pixel-8", label: "Pixel 8 — 412×915", width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true,
    identity: { platform: "Linux armv8l", uaPlatform: "Android", platformVersion: "14.0.0", model: "Pixel 8",
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" } },
  { id: "ipad", label: "iPad — 820×1180", width: 820, height: 1180, deviceScaleFactor: 2, mobile: true,
    identity: { platform: "iPad", uaPlatform: "iOS", platformVersion: "17.0.0", model: "iPad",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } },
  { id: "desktop-1440", label: "Desktop — 1440×900", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, identity: null },
  { id: "desktop-1920", label: "Desktop — 1920×1080", width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, identity: null },
];

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
}

export interface UaBrand {
  brand: string;
  version: string;
}

export interface ViewportPlanContext {
  /** Current size of the tab view in DIPs; presets larger than it are scaled down to fit. */
  view: { width: number; height: number };
  /** Real navigator.userAgentData.brands, when the page exposes them. */
  brands?: UaBrand[] | null;
  /** Full Chromium version (e.g. process.versions.chrome) for the fallback brand list. */
  chromeVersion?: string;
}

const FALLBACK_CHROME_VERSION = "124.0.0.0";

function brandsFor(ctx: ViewportPlanContext): UaBrand[] {
  if (ctx.brands && ctx.brands.length > 0) return ctx.brands;
  const major = (ctx.chromeVersion ?? FALLBACK_CHROME_VERSION).split(".")[0];
  return [
    { brand: "Not.A/Brand", version: "99" },
    { brand: "Chromium", version: major },
  ];
}

/** Clears every emulation override (metrics, touch, UA). Used for "responsive", desktop UA reset and rollback. */
export function planClearCommands(): CdpCommand[] {
  return [
    { method: "Emulation.clearDeviceMetricsOverride" },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
    // An empty userAgent clears the override (no pinned UA without userAgentMetadata).
    { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
  ];
}

/** Scale that fits a preset entirely inside the view (DevTools device-mode behaviour). */
export function fitScale(preset: { width: number; height: number }, view: { width: number; height: number }): number {
  const s = Math.min(1, view.width / preset.width, view.height / preset.height);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** True when switching changes the identity the page sees, so a reload is needed. */
export function viewportNeedsReload(prev: ViewportPresetId, next: ViewportPresetId): boolean {
  const mobile = (id: ViewportPresetId) => VIEWPORT_PRESETS.find((p) => p.id === id)?.identity != null;
  return prev !== next && (mobile(prev) || mobile(next));
}

/**
 * The CDP commands that put a tab into `id`'s viewport. "responsive" (or an
 * unknown id) clears all emulation. Desktop presets never set a UA override
 * (they clear any earlier one); mobile presets send a full identity.
 */
export function planViewportCommands(id: ViewportPresetId, ctx: ViewportPlanContext): CdpCommand[] {
  const preset = VIEWPORT_PRESETS.find((p) => p.id === id);
  if (!preset) return planClearCommands();
  const scale = fitScale(preset, ctx.view);
  const commands: CdpCommand[] = [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        scale,
      },
    },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: preset.mobile } },
  ];
  const ident = preset.identity;
  if (!ident) {
    commands.push({ method: "Emulation.setUserAgentOverride", params: { userAgent: "" } });
    return commands;
  }
  const fullVersion = ctx.chromeVersion ?? FALLBACK_CHROME_VERSION;
  const brands = brandsFor(ctx);
  commands.push({
    method: "Emulation.setUserAgentOverride",
    params: {
      userAgent: ident.userAgent,
      platform: ident.platform,
      userAgentMetadata: {
        brands,
        fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Chromium" ? fullVersion : `${b.version}.0.0.0` })),
        fullVersion,
        platform: ident.uaPlatform,
        platformVersion: ident.platformVersion,
        architecture: "",
        model: ident.model,
        mobile: true,
        bitness: "",
        wow64: false,
      },
    },
  });
  return commands;
}

/** Chromium's zoom: factor = 1.2 ^ level; the app menu's zoomIn/zoomOut roles step the level by 0.5. */
export const ZOOM_LEVEL_STEP = 0.5;
export const ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export interface BrowserToolsState {
  /** False when the CDP debugger is not attached: Viewport items render disabled. */
  hasDebugger: boolean;
  viewport: ViewportPresetId;
  devToolsOpen: boolean;
  zoomFactor: number;
  zoomLevel: number;
}

export interface BrowserToolsActions {
  setViewport(id: ViewportPresetId): void;
  toggleDevTools(): void;
  setZoomFactor(factor: number): void;
  setZoomLevel(level: number): void;
}

export function buildBrowserToolsMenuTemplate(
  state: BrowserToolsState,
  actions: BrowserToolsActions,
): MenuItemConstructorOptions[] {
  const viewportItem = (id: ViewportPresetId, label: string): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: state.viewport === id,
    enabled: state.hasDebugger,
    click: () => actions.setViewport(id),
  });
  return [
    {
      label: "Viewport",
      submenu: [
        viewportItem("responsive", "Responsive (window size)"),
        ...VIEWPORT_PRESETS.map((p) => viewportItem(p.id, p.label)),
      ],
    },
    {
      label: state.devToolsOpen ? "Close Developer Tools" : "Open Developer Tools",
      click: () => actions.toggleDevTools(),
    },
    {
      // Electron's zoom is stored per HOST in the shared persist:penbrowser
      // partition, so it applies to every tab on this site and is remembered
      // across sessions. Deliberately not made per-tab.
      label: "Zoom (this site)",
      submenu: [
        // Accelerators are display-only; the application menu owns the shortcuts.
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false,
          click: () => actions.setZoomLevel(state.zoomLevel + ZOOM_LEVEL_STEP) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false,
          click: () => actions.setZoomLevel(state.zoomLevel - ZOOM_LEVEL_STEP) },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", registerAccelerator: false,
          click: () => actions.setZoomLevel(0) },
        { type: "separator" },
        ...ZOOM_PRESETS.map((z): MenuItemConstructorOptions => ({
          label: `${Math.round(z * 100)}%`,
          type: "radio",
          checked: Math.abs(state.zoomFactor - z) < 0.01,
          click: () => actions.setZoomFactor(z),
        })),
      ],
    },
  ];
}
