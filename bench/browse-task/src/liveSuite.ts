// Live real-site suite (`--scenarios @live`). Every scenario is judged by the
// LLM end-state oracle; `verify` is only a cheap reply sanity check.
// Prices and availability drift, so endCheck describes STATE, not numbers.
// Never in the default run. Today (authoring date): 2026-10-12.

import type { Scenario } from "./scenarios.ts";
import { verdict } from "./verdict.ts";

const SAFETY =
  " Do not sign in, do not pay, do not enter any personal data, and stop before checkout or booking.";
const PRICE = /€|EUR|\$|£|USD|GBP/;
const TIME = /\b\d{1,2}[:.]\d{2}\b/;

function live(
  id: string,
  about: string,
  minSteps: number,
  url: string,
  goal: string,
  endUrl: string,
  endCheck: string,
  checks: (t: string) => Record<string, boolean>,
): Scenario {
  return {
    id,
    about,
    minSteps,
    start: async () => ({
      url,
      goal: goal + SAFETY,
      endUrl,
      endCheck,
      verify: ({ finalText }) => verdict(checks(finalText)),
      close: async () => {},
    }),
  };
}

export const LIVE_SUITE: Scenario[] = [
  live(
    "live-bahn",
    "bahn.de: station autocomplete, date/time pickers, BahnCard discount, filter direct trains",
    14,
    "https://www.bahn.de",
    "On https://www.bahn.de (English UI is fine) search trains from Berlin Hbf to München Hbf on Monday 26 October 2026, departing after 08:00, for 1 adult with a BahnCard 25 (2nd class). Find the cheapest DIRECT train (0 changes). Reply with its departure and arrival time, train number and price.",
    "agent-tab",
    "The tab shows a results list for Berlin -> München on 26 Oct 2026. The traveller summary shows a BahnCard 25 discount applied. A direct connection (0 changes) departing after 08:00 is visible with its price.",
    (t) => ({ times: (t.match(/\b\d{1,2}:\d{2}\b/g) ?? []).length >= 2, price: PRICE.test(t), train: /\b(ICE|IC|EC|RJX?|TGV)\s*\d+/i.test(t) }),
  ),
  live(
    "live-ikea",
    "ikea.com/de: search, product variant (width, colour), store stock, quantity, bag",
    14,
    "https://www.ikea.com/de/en/",
    "On https://www.ikea.com/de/en/ find the PAX wardrobe frame, 100 cm wide, white. Check its stock at the IKEA Berlin-Tempelhof store. Add 2 units to the shopping bag. Reply with the product name, article number and the bag total.",
    "https://www.ikea.com/de/en/shoppingcart/",
    "The bag contains a white PAX wardrobe frame, 100 cm wide, quantity 2. No unrelated items. A total is shown.",
    (t) => ({ pax: /pax/i.test(t), article: /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{2}\b|\b\d{8}\b/.test(t), price: PRICE.test(t) }),
  ),
  live(
    "live-apple",
    "apple.com/shop: multi-step configurator (chip, memory, storage, colour), add to bag",
    12,
    "https://www.apple.com/shop/buy-mac/macbook-pro",
    "On https://www.apple.com/shop/buy-mac/macbook-pro (US store) configure a 14-inch MacBook Pro with the M5 chip, 32GB unified memory, 1TB SSD storage, in Space Black. Add it to the bag. Reply with the final price and the delivery estimate.",
    "https://www.apple.com/shop/bag",
    "The bag holds one 14-inch MacBook Pro with the M5 chip, 32GB unified memory, 1TB SSD storage, Space Black. A total price is shown. No duplicates.",
    (t) => ({ price: /\$\s?\d/.test(t), delivery: /deliver|ship|arrive|\b(Oct|Nov|Dec)\w*\b|\d{1,2}\s*-\s*\d{1,2}/i.test(t), pro: /m5|32\s?gb/i.test(t) }),
  ),
  live(
    "live-amazon",
    "amazon.de: search + sidebar filters, product page colour, add-on popup, basket",
    14,
    "https://www.amazon.de",
    "On https://www.amazon.de (English UI via the language switch is fine, not required) search for over-ear wireless headphones. Filter: customer rating 4 stars & up, price 50 to 100 EUR, brand Sony or JBL. Open the first matching product, pick the black colour, add it to the basket (decline any add-on or insurance popup). Reply with the product title, its price and the basket subtotal.",
    "https://www.amazon.de/gp/cart/view.html",
    "The basket contains exactly one Sony or JBL over-ear wireless headphone in black, priced 50-100 EUR. No protection plan. A subtotal is shown.",
    (t) => ({ brand: /sony|jbl/i.test(t), price: PRICE.test(t), subtotal: /subtotal|zwischensumme|basket|cart|warenkorb/i.test(t) }),
  ),
  live(
    "live-rightmove",
    "rightmove.co.uk: location autocomplete, rent/radius/bedrooms/price filters, sort",
    10,
    "https://www.rightmove.co.uk",
    "On https://www.rightmove.co.uk search properties TO RENT near Clapham Junction station, London, within 1 mile, 2 bedrooms, maximum £2,500 pcm, sorted by newest listed. Reply with the first 3 listings, each with price and address.",
    "agent-tab",
    "Rental search results near Clapham Junction. Radius 1 mile, 2 bedrooms and max £2,500 pcm are visible as applied filters. Sorted by newest listed. At least 3 listings are visible.",
    (t) => ({ price: /£\s?[\d,]+/.test(t), pcm: /pcm|per month|pm/i.test(t), listings: (t.match(/£\s?[\d,]+/g) ?? []).length >= 3 }),
  ),
  live(
    "live-gmaps",
    "google.com/maps: search with open-now and rating filters, transit directions",
    10,
    "https://www.google.com/maps?hl=en",
    "On https://www.google.com/maps?hl=en find coffee shops near Alexanderplatz, Berlin that are open now and rated 4.5 or higher. Pick the best-rated of the first results and get public-transport directions to it from Berlin Hauptbahnhof. Reply with 3 coffee shops and their ratings, the one you chose, and the transit travel time.",
    "agent-tab",
    "A directions panel from Berlin Hauptbahnhof to a coffee shop near Alexanderplatz, in public-transport mode, with a travel time shown.",
    (t) => ({ ratings: (t.match(/\b[45][.,]\d\b/g) ?? []).length >= 1, duration: /\b\d+\s*(min|h|hr|hour)/i.test(t), chosen: /alexanderplatz|berlin|coffee|caf[eé]/i.test(t) }),
  ),
  live(
    "live-stockanalysis",
    "stockanalysis.com screener: add-filter dialog, range filters, view tabs, column sort (TradingView needs sign-in for filters)",
    14,
    "https://stockanalysis.com/stocks/screener/",
    "On https://stockanalysis.com/stocks/screener/ use the stock screener: add filters Market Cap over 10B, PE Ratio under 15 and Sector Technology. Show the dividend yield column and sort by dividend yield, highest first. Reply with the top 5 tickers and their dividend yield.",
    "agent-tab",
    "The stock screener shows three active filters: market cap over 10B, PE ratio under 15, sector Technology. The table has a dividend yield column sorted from highest to lowest. At least 5 rows are visible.",
    (t) => ({ tickers: (t.match(/\b[A-Z]{2,5}\b/g) ?? []).length >= 5, yields: (t.match(/\d+(\.\d+)?\s*%/g) ?? []).length >= 3, five: /(^|\n|\s)5\b|\b1\.|\b5\./.test(t) || (t.match(/\b[A-Z]{2,5}\b/g) ?? []).length >= 5 }),
  ),
  live(
    "live-ebay",
    "ebay.com: search filters (condition, format, location, ship-to), sort, listing page",
    13,
    "https://www.ebay.com",
    "On https://www.ebay.com search for Apple iPhone 13 128GB. Filter: Used condition, Buy It Now only, item location Worldwide, ship to Cyprus. Sort by price + shipping, lowest first. Open the first listing. Reply with the listing title, item price, shipping cost to Cyprus and the seller feedback percentage.",
    "agent-tab",
    "An eBay item page for a used iPhone 13 128GB sold via Buy It Now. Shipping to Cyprus and its cost are shown. Seller feedback is shown.",
    (t) => ({ iphone: /iphone\s*13/i.test(t), price: PRICE.test(t), feedback: /\d{2,3}(\.\d+)?\s*%/.test(t) }),
  ),
  live(
    "live-opentable",
    "opentable.com: date/time/party pickers, results with time-slot buttons",
    9,
    "https://www.opentable.com",
    "On https://www.opentable.com (London region) search for Saturday 24 October 2026, 19:00, party of 4, in London. Find 3 restaurants that have a free slot within 30 minutes of 19:00. Do not book. Reply with the restaurant names and slot times.",
    "agent-tab",
    "OpenTable search results for London, 4 people, 24 Oct 2026, around 7:00 PM. At least 3 restaurants with time-slot buttons near 19:00 are visible.",
    (t) => ({ times: (t.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)?/gi) ?? []).length >= 3, names: t.trim().split(/\s+/).length >= 8, slot: /1[89][:.][0-5]\d|[67][:.][0-5]\d\s*pm|7\s*pm/i.test(t) }),
  ),
  live(
    "live-github",
    // 13.10: the repo has no label "feature" (GitHub: "Invalid value feature
    // for label", 0 issues; API lists 73 labels, only feature-*), so the old
    // goal could not be met. feature-test-runner had 10 open issues.
    "github.com: site search, releases page, issues label filter without signing in",
    12,
    "https://github.com",
    "On https://github.com find the repository microsoft/playwright through GitHub search (do not type the repository URL). Open its latest release and report its version and the first item of its highlights or \"What's New\". Then open the repository's open issues filtered by the label \"feature-test-runner\" and report how many open issues have it.",
    "agent-tab",
    "The tab shows the issues list of microsoft/playwright filtered by the label \"feature-test-runner\" and state open, with the open issue count visible.",
    (t) => ({ version: /v?\d+\.\d+/.test(t), count: /\b\d[\d,]*\b/.test(t), playwright: /playwright/i.test(t) }),
  ),
];
