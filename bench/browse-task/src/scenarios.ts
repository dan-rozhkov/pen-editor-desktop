import path from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP_DIR } from "./paths.ts";
import { startFormFixture, FORM_EXPECTED } from "./fixtures/form.ts";
import { startLookupFixture, LOOKUP_ANSWER, LOOKUP_DECOYS } from "./fixtures/lookup.ts";
import { LIVE_SUITE } from "./liveSuite.ts";
import { OM2W_SUITE } from "./om2wSuite.ts";
import { WV_SUITE } from "./webvoyagerSuite.ts";
import { WTB_SUITE, WTB_E2E_SUITE } from "./wtbSuite.ts";
import { startBookingFixture, BOOKING_EXPECTED } from "./fixtures/booking.ts";
import { startForm2Fixture, FORM2_EXPECTED } from "./fixtures/form2.ts";

export interface VerifyInput {
  /** Text of the agent's final reply (last /api/chat response). */
  finalText: string;
}

export interface Verdict {
  success: boolean;
  /** Share of checkpoints passed, 0..1 — how far a failed run got. */
  score: number;
  checks: Record<string, boolean>;
  detail?: unknown;
}

export interface RunningScenario {
  url: string;
  goal: string;
  verify: (input: VerifyInput) => Verdict;
  /** Optional end-state oracle: page to read after the turn, and what it must contain. */
  endUrl?: string;
  endCheck?: string;
  /** Question task: the judge grades the final reply as the answer (see JudgeInput.replyIsAnswer). */
  endReplyIsAnswer?: boolean;
  close: () => Promise<void>;
}

export interface Scenario {
  id: string;
  /** What the scenario stresses, for the report. */
  about: string;
  /** Rough hand-counted minimum of browse steps for a perfect run. */
  minSteps: number;
  start: () => Promise<RunningScenario>;
}

export { verdict } from "./verdict.ts";
import { verdict } from "./verdict.ts";

interface ShopOrder {
  orderNumber: string;
  fullName: string;
  email: string;
  country: string;
  shipping: string;
  termsAccepted: boolean;
  items: { productId: string; price: number }[];
}

const shop: Scenario = {
  id: "shop",
  about: "cookie banner, search, 3 filters + sort, product, cart, checkout form (bench-shop from pen-editor-desktop)",
  minSteps: 16,
  async start() {
    const mod = (await import(
      pathToFileURL(path.join(DESKTOP_DIR, "e2e/fixtures/bench-shop/server.ts")).href
    )) as { startBenchShopServer: (port?: number) => Promise<{ url: string; close: () => Promise<void>; getOrders: () => ShopOrder[] }> };
    const server = await mod.startBenchShopServer();
    return {
      url: server.url,
      goal:
        `Open ${server.url}. Accept cookies, search for headphones, keep only wireless ones from brand ` +
        `AudioNova under $100, sort by rating, open the top result, add it to the cart and check out as ` +
        `Test User, test@example.com, Germany, standard shipping, accept the terms. Reply with the order number.`,
      verify({ finalText }) {
        const orders = server.getOrders();
        const order = orders.at(-1);
        return verdict(
          {
            orderPlaced: !!order,
            rightProduct: !!order && order.items.length === 1 && order.items[0].productId === "hp-02",
            rightDetails:
              !!order &&
              order.fullName === "Test User" &&
              order.email === "test@example.com" &&
              order.country === "Germany" &&
              order.shipping === "standard",
            singleOrder: orders.length === 1,
            reportedOrderNumber: !!order && finalText.includes(order.orderNumber),
          },
          { orders: orders.map((o) => ({ n: o.orderNumber, items: o.items.map((i) => i.productId) })) },
        );
      },
      close: server.close,
    };
  },
};

const form: Scenario = {
  id: "form",
  about: "11-control signup form: text fields, <select> with placeholder, radio, one checkbox to leave OFF, one to turn ON",
  minSteps: 12,
  async start() {
    const server = await startFormFixture();
    const e = FORM_EXPECTED;
    return {
      url: server.url,
      goal:
        `Open ${server.url}/register and create an account for ${e.firstName} ${e.lastName}, email ${e.email}, ` +
        `phone ${e.phone}, address ${e.street}, ${e.postcode} ${e.city}, ${e.country}, on the Pro plan. ` +
        `Do not subscribe to the newsletter; accept the terms. Reply with the account ID.`,
      verify({ finalText }) {
        const subs = server.submissions();
        const s = subs.at(-1);
        const field = (k: keyof typeof FORM_EXPECTED) => !!s && s[k] === FORM_EXPECTED[k];
        return verdict(
          {
            submitted: !!s,
            names: field("firstName") && field("lastName"),
            contact: field("email") && field("phone"),
            address: field("street") && field("city") && field("postcode"),
            country: field("country"),
            plan: field("plan"),
            newsletterOff: !!s && s.newsletter === false,
            singleAccount: subs.length === 1,
            reportedAccountId: !!s && finalText.includes(s.accountId),
          },
          { last: s },
        );
      },
      close: server.close,
    };
  },
};

const form2: Scenario = {
  id: "form2",
  about: "2-field contact form (name + phone with digits) and Save: the simplest form",
  minSteps: 3,
  async start() {
    const server = await startForm2Fixture();
    const e = FORM2_EXPECTED;
    return {
      url: server.url,
      goal: `Open ${server.url}/contacts/new and add a contact ${e.name} with phone ${e.phone}. Reply with the contact ID.`,
      verify({ finalText }) {
        const subs = server.submissions();
        const s = subs.at(-1);
        return verdict(
          {
            submitted: !!s,
            name: !!s && s.name === e.name,
            phone: !!s && s.phone === e.phone,
            singleContact: subs.length === 1 && server.posts() === 1,
            reportedContactId: !!s && finalText.includes(s.contactId),
          },
          { last: s, posts: server.posts() },
        );
      },
      close: server.close,
    };
  },
};

const lookup: Scenario = {
  id: "lookup",
  about: "search, pagination past 4 near-duplicate decoys, read a detail page, report a value",
  minSteps: 5,
  async start() {
    const server = await startLookupFixture();
    return {
      url: server.url,
      goal:
        `Open ${server.url} (a library catalog) and find the ISBN of the 2019 revised paperback edition of ` +
        `"The Silent Orchard" by Mira Holt. Reply with the ISBN.`,
      verify({ finalText }) {
        // The answer is the FIRST ISBN in the reply — a good reply may still
        // name the decoys it ruled out afterwards.
        const digits = (s: string) => s.replace(/[^0-9]/g, "");
        const isbns = [...finalText.matchAll(/97[89][\d\s-]{10,16}\d/g)].map((m) => digits(m[0]));
        return verdict(
          {
            rightIsbnFirst: isbns[0] === digits(LOOKUP_ANSWER),
            noDecoyFirst: !LOOKUP_DECOYS.some((d) => digits(d) === isbns[0]),
          },
          { isbns },
        );
      },
      close: server.close,
    };
  },
};

const booking: Scenario = {
  id: "booking",
  about: "cookie dialog, autocomplete <li role=option>, date picker (next month), stepper, native select, custom dropdown",
  minSteps: 12,
  async start() {
    const server = await startBookingFixture();
    return {
      url: server.url,
      goal:
        `Open ${server.url} and book a Deluxe room in Lisbon, Portugal: check-in on 14 October 2026, ` +
        `3 nights, 2 guests. Reply with the booking reference.`,
      verify({ finalText }) {
        const all = server.bookings();
        const b = all.at(-1);
        const p = server.progress();
        const e = BOOKING_EXPECTED;
        return verdict(
          {
            cookies: p.cookies === true,
            destination: (b?.destination ?? p.destination) === e.destination,
            checkin: (b?.checkin ?? p.checkin) === e.checkin,
            nights: Number(b?.nights ?? p.nights ?? 1) === e.nights,
            guests: Number(b?.guests ?? p.guests ?? 1) === e.guests,
            room: (b?.room ?? p.room) === e.room,
            booked: !!b,
            singleBooking: all.length <= 1,
            reportedRef: !!b && finalText.includes(b.ref),
          },
          { last: b, progress: p },
        );
      },
      close: server.close,
    };
  },
};

// Live, unverifiable: the real booking.com. Read the transcripts, not the verdict.
const liveBooking: Scenario = {
  id: "livebooking",
  about: "LIVE booking.com: sign-in modal, destination autocomplete, date-picker popup",
  minSteps: 8,
  async start() {
    return {
      url: "https://www.booking.com",
      goal:
        "Find me a hotel in Ayia Napa, Cyprus on booking.com for this weekend: check-in Saturday 3 October 2026, " +
        "check-out Sunday 4 October 2026, 2 adults. Open https://www.booking.com, search, and reply with 3 hotels and their prices.",
      verify({ finalText }) {
        return verdict({ napa: /ayia napa/i.test(finalText), price: /€|EUR|\$/.test(finalText) });
      },
      close: async () => {},
    };
  },
};

// Live demo: the nearest weekend in Cyprus under a nightly budget.
const liveCyprus: Scenario = {
  id: "livecyprus",
  about: "LIVE booking.com: Cyprus, nearest weekend, price filter <= EUR 150/night",
  minSteps: 10,
  async start() {
    return {
      url: "https://www.booking.com",
      goal:
        "Open https://www.booking.com and find me a hotel in Cyprus for the nearest weekend: check-in Saturday 3 October 2026, " +
        "check-out Sunday 4 October 2026, 2 adults. The budget is at most 150 EUR per night — apply the price filter on the results page. " +
        "Reply with 3 hotels that fit the budget, with their prices.",
      verify({ finalText }) {
        return verdict({ cyprus: /cyprus|кипр/i.test(finalText), price: /€|EUR/.test(finalText) });
      },
      close: async () => {},
    };
  },
};

// Ad-hoc live check: BENCH_LIVE_URL + BENCH_LIVE_GOAL; replyCheck = BENCH_LIVE_EXPECT regex on the reply.
// With BENCH_LIVE_END_URL + BENCH_LIVE_END_CHECK an LLM judge also scores the page state the agent left behind.
const liveGoal: Scenario = {
  id: "livegoal",
  about: "LIVE ad-hoc goal from env (BENCH_LIVE_URL / BENCH_LIVE_GOAL / BENCH_LIVE_EXPECT)",
  minSteps: 3,
  async start() {
    return {
      url: process.env.BENCH_LIVE_URL ?? "about:blank",
      goal: process.env.BENCH_LIVE_GOAL ?? "",
      endUrl: process.env.BENCH_LIVE_END_URL || undefined,
      endCheck: process.env.BENCH_LIVE_END_CHECK || undefined,
      verify({ finalText }) {
        return verdict({ replyCheck: new RegExp(process.env.BENCH_LIVE_EXPECT ?? ".", "i").test(finalText) });
      },
      close: async () => {},
    };
  },
};

export const SCENARIOS: Scenario[] = [lookup, form, form2, booking, shop, liveBooking, liveCyprus, liveGoal, ...LIVE_SUITE, ...OM2W_SUITE, ...WV_SUITE, ...WTB_SUITE, ...WTB_E2E_SUITE];
