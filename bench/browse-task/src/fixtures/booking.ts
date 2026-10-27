// REWRITTEN after the loss of bench/ (27.10.2026) — NOT the original fixture.
// The original (216 lines) was never captured in a transcript; this one keeps the
// contract used by scenarios.ts (startBookingFixture, BOOKING_EXPECTED, bookings(),
// progress(), close) and the endpoints that selfcheck.ts exercises (GET /api/cities?q=,
// POST /api/progress {k,v}, form POST /book -> 303 /confirmation?ref=) and the documented widgets: cookie dialog, destination
// autocomplete (<li role="option">), date picker that opens on the CURRENT month
// (the check-in is in the next month), nights stepper, native <select> for guests
// and a custom dropdown for the room. Progress is reported through a beacon so
// partial runs are visible. Results on `booking` from before the loss are not
// comparable with runs on this fixture.

import { serve, html, json, redirect, readBody, readForm, esc, page, type FixtureServer } from "./http.ts";

export const BOOKING_EXPECTED = {
  destination: "Lisbon, Portugal",
  checkin: "2026-10-14",
  nights: 3,
  guests: 2,
  room: "deluxe",
} as const;

export interface BookingRecord {
  ref: string;
  destination: string;
  checkin: string;
  nights: number;
  guests: number;
  room: string;
}

export interface BookingProgress {
  cookies?: boolean;
  destination?: string;
  checkin?: string;
  nights?: number;
  guests?: number;
  room?: string;
}

const CITIES = ["Lisbon, Portugal", "Lisburn, United Kingdom", "Porto, Portugal", "Madrid, Spain", "Barcelona, Spain", "Paris, France", "Berlin, Germany"];

const SCRIPT = `
const st = { cookies: false, destination: "", checkin: "", nights: 1, guests: 1, room: "" };
const beacon = (k) => { if (k) navigator.sendBeacon("/api/progress", JSON.stringify({ k, v: st[k] })); };
const $ = (id) => document.getElementById(id);
$("accept").onclick = () => { $("cookie").remove(); st.cookies = true; beacon("cookies"); };
const dest = $("dest"), list = $("places");
dest.oninput = async () => {
  const q = dest.value.trim();
  list.innerHTML = "";
  if (!q) return;
  const places = await (await fetch("/api/cities?q=" + encodeURIComponent(q))).json();
  for (const p of places) {
    const li = document.createElement("li");
    li.setAttribute("role", "option"); li.textContent = p; li.tabIndex = 0;
    li.onclick = () => { dest.value = p; st.destination = p; $("f-destination").value = p; list.innerHTML = ""; beacon("destination"); };
    list.appendChild(li);
  }
};
let view = new Date(2026, 8, 1); // September 2026: the check-in is next month
const cal = $("cal");
function draw() {
  const y = view.getFullYear(), m = view.getMonth();
  const days = new Date(y, m + 1, 0).getDate();
  let h = '<div class="bar"><button type="button" id="prev" aria-label="Previous month">‹</button><strong>' +
    view.toLocaleString("en", { month: "long", year: "numeric" }) +
    '</strong><button type="button" id="next" aria-label="Next month">›</button></div><div class="grid">';
  for (let d = 1; d <= days; d++) h += '<button type="button" class="day" data-d="' + d + '">' + d + "</button>";
  cal.innerHTML = h + "</div>";
  $("prev").onclick = () => { view = new Date(y, m - 1, 1); draw(); };
  $("next").onclick = () => { view = new Date(y, m + 1, 1); draw(); };
  cal.querySelectorAll(".day").forEach((b) => (b.onclick = () => {
    const iso = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(b.dataset.d).padStart(2, "0");
    st.checkin = iso; $("checkin").value = iso; $("f-checkin").value = iso; cal.hidden = true; beacon("checkin");
  }));
}
$("checkin").onclick = () => { cal.hidden = false; draw(); };
const setNights = (n) => { st.nights = Math.max(1, Math.min(14, n)); $("nights").textContent = st.nights; $("f-nights").value = st.nights; beacon("nights"); };
$("minus").onclick = () => setNights(st.nights - 1);
$("plus").onclick = () => setNights(st.nights + 1);
$("guests").onchange = (e) => { st.guests = Number(e.target.value); $("f-guests").value = st.guests; beacon("guests"); };
$("roomBtn").onclick = () => { $("rooms").hidden = !$("rooms").hidden; };
document.querySelectorAll("#rooms [role=option]").forEach((o) => (o.onclick = () => {
  st.room = o.dataset.v; $("roomBtn").textContent = o.textContent; $("f-room").value = st.room; $("rooms").hidden = true; beacon("room");
}));
`;

export interface BookingServer extends FixtureServer {
  bookings: () => BookingRecord[];
  progress: () => BookingProgress;
}

export async function startBookingFixture(): Promise<BookingServer> {
  const bookings: BookingRecord[] = [];
  const progress: BookingProgress = {};
  const server = await serve(async (req, res, url) => {
    if (url.pathname === "/api/cities") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(res, q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)) : []);
    }
    if (req.method === "POST" && url.pathname === "/api/progress") {
      try {
        const { k, v } = JSON.parse(await readBody(req)) as { k: keyof BookingProgress; v: never };
        (progress as Record<string, unknown>)[k] = v;
      } catch {
        // ignore malformed beacon
      }
      res.statusCode = 204;
      return void res.end();
    }
    if (req.method === "POST" && url.pathname === "/book") {
      const f = await readForm(req);
      const ref = `BK-${String(100000 + bookings.length * 7919 + 4217).slice(-6)}`;
      bookings.push({ ref, destination: f.get("destination") ?? "", checkin: f.get("checkin") ?? "", nights: Number(f.get("nights") ?? 1), guests: Number(f.get("guests") ?? 1), room: f.get("room") ?? "" });
      return redirect(res, `/confirmation?ref=${ref}`);
    }
    if (url.pathname === "/confirmation") {
      const ref = url.searchParams.get("ref") ?? "";
      return html(res, page("Booking confirmed", `<h1>Booking confirmed</h1><p>Reference: <strong id="ref">${esc(ref)}</strong></p>`));
    }
    if (url.pathname !== "/") return html(res, page("Not found", "<h1>Not found</h1>"), 404);
    const body = `
<div id="cookie" role="dialog" aria-label="Cookies"><p>We use cookies to improve your stay.</p><button id="accept" type="button">Accept all</button></div>
<h1>Stays — find your hotel</h1>
<label for="dest">Destination</label>
<input id="dest" autocomplete="off" placeholder="Where are you going?" role="combobox" aria-expanded="true">
<ul id="places"></ul>
<label for="checkin">Check-in</label>
<input id="checkin" readonly placeholder="Select a date">
<div id="cal" hidden></div>
<label>Nights</label>
<div><button id="minus" type="button" aria-label="Fewer nights">−</button> <span id="nights">1</span> <button id="plus" type="button" aria-label="More nights">+</button></div>
<label for="guests">Guests</label>
<select id="guests">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n} guest${n > 1 ? "s" : ""}</option>`).join("")}</select>
<label>Room type</label>
<div><button id="roomBtn" type="button" aria-haspopup="listbox">Select a room</button>
<ul id="rooms" role="listbox" hidden>${["Standard", "Deluxe", "Suite"].map((r) => `<li role="option" data-v="${r.toLowerCase()}">${esc(r)}</li>`).join("")}</ul></div>
<form method="post" action="/book">
  <input type="hidden" id="f-destination" name="destination"><input type="hidden" id="f-checkin" name="checkin">
  <input type="hidden" id="f-nights" name="nights" value="1"><input type="hidden" id="f-guests" name="guests" value="1"><input type="hidden" id="f-room" name="room">
  <p><button id="book" type="submit">Book now</button></p>
</form>`;
    html(res, page("Stays", body, SCRIPT));
  });
  return { ...server, bookings: () => [...bookings], progress: () => ({ ...progress }) };
}
