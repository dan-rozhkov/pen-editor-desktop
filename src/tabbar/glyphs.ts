// Icon glyphs shared by the tab bar (renderer.ts), the empty page (emptyRenderer.ts), the address suggestions
// (omnibox), History and Passwords. They are COPIES of the pen-editor icon set (pen-editor src/components/icons/):
// 16x16 grid, outline strokes, 1.25px stroke kept at screen width by vector-effect: non-scaling-stroke
// (CSS `[data-pen-icon] * { vector-effect: non-scaling-stroke }` in every page that draws one), round caps and joins.
// pen-editor src/components/icons/__tests__/desktopIconsContract.test.tsx renders each icon and compares it with this file:
// change a glyph in pen-editor, then re-copy its markup here. Do not hand-draw glyphs here.
// Its own plain global script, loaded before the renderers, like urlNormalization.ts: no top-level import/export,
// so tsc emits it as a plain script. DOM is built with createElementNS only (the CSPs forbid inline markup).
// The two JSON blocks are read by that test: keep them strict JSON between the /* json:NAME */ and /* end */ markers.
type PenNode = [string, Record<string, string>] | [string, Record<string, string>, PenNode[]];

/* json:PEN_GLYPHS */
var PEN_GLYPHS: Record<string, PenNode[]> = {
  "PaintBrush": [["g",{"transform":"translate(8 8) scale(1.06) translate(-8 -8)"},[["rect",{"x":"10.68","y":"1.61","width":"2","height":"5.44","rx":"1","transform":"rotate(45 11.68 4.33)"}],["path",{"d":"M10.81 7.31 8.69 5.19 7.28 6.6 9.4 8.72Z"}],["path",{"d":"M7.28 6.6C4 6.6 2.3 9.2 2.5 13.5c4.3.2 6.9-1.5 6.9-4.78"}]]]],
  "Globe": [["circle",{"cx":"8","cy":"8","r":"6"}],["path",{"d":"M2 8h12M8 2c-1.9 1.75-2.75 3.75-2.75 6S6.1 12.25 8 14c1.9-1.75 2.75-3.75 2.75-6S9.9 3.75 8 2Z"}]],
  "FileText": [["path",{"d":"M9.25 2.25H5a1.5 1.5 0 0 0-1.5 1.5v8.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5V5.5Z M9.25 2.25V5.5h3.25"}],["path",{"d":"M6 8.75h4M6 11.5h4"}]],
  "TreeStructure": [["rect",{"x":"5.75","y":"1.75","width":"4.5","height":"3","rx":"1","fill":"currentColor","stroke":"none"}],["rect",{"x":"1.5","y":"11.25","width":"4.5","height":"3","rx":"1","fill":"currentColor","stroke":"none"}],["rect",{"x":"10","y":"11.25","width":"4.5","height":"3","rx":"1","fill":"currentColor","stroke":"none"}],["path",{"d":"M8 4.75V8M3.75 11.25V8h8.5v3.25"}]],
  "FilmStrip": [["rect",{"x":"2.5","y":"2.5","width":"11","height":"11","rx":"1.75"}],["path",{"d":"M5.5 2.5v11M10.5 2.5v11M2.5 8h3M10.5 8h3"}]],
  "Gear": [["path",{"d":"M6.55 3.53L6.67 1.74L9.33 1.74L9.45 3.53A4.7 4.7 0 0 1 11.14 4.51L12.76 3.72L14.09 6.02L12.6 7.02A4.7 4.7 0 0 1 12.6 8.98L14.09 9.98L12.76 12.28L11.14 11.49A4.7 4.7 0 0 1 9.45 12.47L9.33 14.26L6.67 14.26L6.55 12.47A4.7 4.7 0 0 1 4.86 11.49L3.24 12.28L1.91 9.98L3.4 8.98A4.7 4.7 0 0 1 3.4 7.02L1.91 6.02L3.24 3.72L4.86 4.51A4.7 4.7 0 0 1 6.55 3.53z"}],["circle",{"cx":"8","cy":"8","r":"2"}]],
  "ClockCounterClockwise": [["path",{"d":"M2.75 8A5.25 5.25 0 1 0 4.3 4.3M4.3 1.8v2.5h2.5M8 5.25V8l2 1.25"}]],
  "Key": [["circle",{"cx":"5.25","cy":"8","r":"3.25"}],["path",{"d":"M8.5 8H14M11.25 8v2.75M14 8v2.5"}]],
  "SidebarSimple": [["rect",{"x":"2","y":"3","width":"12","height":"10","rx":"1.75"}],["path",{"d":"M6.5 3v10"}]],
  "Plus": [["path",{"d":"M8 2.75v10.5M2.75 8h10.5"}]],
  "ArrowLeft": [["path",{"d":"M13.25 8H2.75M7.25 3.5 2.75 8l4.5 4.5"}]],
  "ArrowRight": [["path",{"d":"M2.75 8h10.5M8.75 3.5 13.25 8l-4.5 4.5"}]],
  "ArrowClockwise": [["path",{"d":"M13.25 8A5.25 5.25 0 1 1 11.7 4.3M11.7 1.8v2.5H9.2"}]],
  "DotsThreeVertical": [["circle",{"cx":"8","cy":"3.5","r":"1","fill":"currentColor","stroke":"none"}],["circle",{"cx":"8","cy":"8","r":"1","fill":"currentColor","stroke":"none"}],["circle",{"cx":"8","cy":"12.5","r":"1","fill":"currentColor","stroke":"none"}]],
  "MagnifyingGlass": [["g",{"transform":"translate(8 8) scale(1.06) translate(-8 -8)"},[["circle",{"cx":"7","cy":"7","r":"4.5"}],["path",{"d":"M10.25 10.25 13.5 13.5"}]]]],
  "X": [["path",{"d":"M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5"}]],
  "PencilSimple": [["g",{"transform":"translate(8 8) scale(1.14) translate(-8 -8)"},[["path",{"d":"M2.75 13.25 3.3 10.6l7.4-7.4a1.25 1.25 0 0 1 1.77 0l.33.33a1.25 1.25 0 0 1 0 1.77l-7.4 7.4-2.65.55ZM9.5 4.5l2 2"}]]]],
  "Trash": [["path",{"d":"M2.5 4.25h11M6.25 4.25v-1c0-.4.35-.75.75-.75h2c.4 0 .75.35.75.75v1M3.75 4.25l.6 8.15c.06.8.72 1.35 1.5 1.35h4.3c.78 0 1.44-.55 1.5-1.35l.6-8.15M8 7.5v3"}]],
  "FunnelSimple": [["path",{"d":"M2.5 4h11M4.5 8h7M6.5 12h3"}]]
} /* end */;

/* json:PEN_GLYPHS_FILL */
var PEN_GLYPHS_FILL: Record<string, PenNode[]> = {
  "Globe": [["mask",{"id":"pen-fill-mask-Globe"},[["rect",{"width":"16","height":"16","fill":"white"}],["path",{"d":"M2 8h12M8 2c-1.9 1.75-2.75 3.75-2.75 6S6.1 12.25 8 14c1.9-1.75 2.75-3.75 2.75-6S9.9 3.75 8 2Z","fill":"none","stroke":"black","stroke-width":"1.25","stroke-linecap":"round"}]]],["circle",{"cx":"8","cy":"8","r":"6.6","mask":"url(#pen-fill-mask-Globe)"}]]
} /* end */;

function penBuild(parent: Element, nodes: PenNode[]): void {
  for (const [tag, attrs, kids] of nodes) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    if (kids) penBuild(el, kids);
    parent.appendChild(el);
  }
}

/**
 * A pen-set icon as an <svg> (viewBox 0 0 16 16; 16px unless page CSS sizes it), same root attributes as the frontend's createIcon:
 * outline weight by default; "fill" is the solid variant (only the glyphs in PEN_GLYPHS_FILL); "bold" is only for
 * the Dots* icons (the page CSS enlarges the dots) and steps the stroke to 1.5. `large` (rendered at 22px and up)
 * steps the stroke by 0.25, like the frontend does for a numeric size >= 22.
 */
function penIcon(name: string, cls = "", weight: "regular" | "fill" | "bold" = "regular", large = false): SVGSVGElement {
  const solid = weight === "fill" && name in PEN_GLYPHS_FILL;
  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (cls) svgEl.setAttribute("class", cls);
  svgEl.setAttribute("viewBox", "0 0 16 16");
  // Presentation attributes: any CSS width/height wins; without one (the sidebar toggle) the icon is 16px, not stretched.
  svgEl.setAttribute("width", "16");
  svgEl.setAttribute("height", "16");
  svgEl.setAttribute("data-pen-icon", name);
  svgEl.setAttribute("data-weight", weight);
  svgEl.setAttribute("fill", solid ? "currentColor" : "none");
  svgEl.setAttribute("stroke", solid ? "none" : "currentColor");
  svgEl.setAttribute("stroke-width", String((weight === "bold" ? 1.5 : 1.25) + (large ? 0.25 : 0)));
  svgEl.setAttribute("stroke-linecap", "round");
  svgEl.setAttribute("stroke-linejoin", "round");
  svgEl.setAttribute("aria-hidden", "true");
  // An unknown name draws an empty icon: throwing here would stop the page's startup script (tab list, buttons).
  penBuild(svgEl, (solid ? PEN_GLYPHS_FILL[name] : PEN_GLYPHS[name]) ?? []);
  return svgEl;
}

/** Swaps every static `<span class="..." data-pen-slot="Name"></span>` in the page for the pen icon of that name (same class). */
function penMountSlots(): void {
  for (const slot of Array.from(document.querySelectorAll("[data-pen-slot]"))) {
    slot.replaceWith(penIcon(slot.getAttribute("data-pen-slot")!, slot.getAttribute("class") ?? ""));
  }
}
