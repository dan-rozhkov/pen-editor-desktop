// LLM-free sanity check of the fixtures: every page answers, every inline
// <script> parses, and each verifier passes on a scripted perfect run and
// fails on an empty one. Run: npm run check
import assert from "node:assert/strict";
import { SCENARIOS } from "../scenarios.ts";
import { LIVE_SUITE } from "../liveSuite.ts";

async function scriptsParse(url: string): Promise<void> {
  const body = await (await fetch(url)).text();
  for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
}

const post = (url: string, form: Record<string, string>) =>
  fetch(url, { method: "POST", body: new URLSearchParams(form), redirect: "manual" });

const liveIds = new Set(LIVE_SUITE.map((s) => s.id));
for (const scenario of SCENARIOS) {
  const run = await scenario.start();
  try {
    if (scenario.id.startsWith("live")) {
      // Real sites: never fetched here, only the static contract is checked.
      assert.equal(run.verify({ finalText: "" }).success, false, `${scenario.id}: empty run must fail`);
      if (liveIds.has(scenario.id)) {
        assert.ok(run.endUrl, `${scenario.id}: live suite needs endUrl`);
        assert.ok(run.endCheck, `${scenario.id}: live suite needs endCheck`);
        assert.ok(scenario.id.startsWith("live-"), `${scenario.id}: live suite id prefix`);
      }
      console.log(`ok  ${scenario.id}  (live, not fetched)`);
      continue;
    }
    await scriptsParse(run.url + (scenario.id === "form" ? "/register" : "/"));
    assert.equal(run.verify({ finalText: "" }).success, false, `${scenario.id}: empty run must fail`);

    if (scenario.id === "form") {
      const bad = await post(`${run.url}/register`, { firstName: "Anna" });
      assert.equal(bad.status, 422);
      const ok = await post(`${run.url}/register`, {
        firstName: "Anna", lastName: "Petrova", email: "anna.petrova@example.com", phone: "+49 30 1234567",
        street: "Hauptstrasse 5", city: "Berlin", postcode: "10115", country: "Germany", plan: "pro", terms: "on",
      });
      const id = new URL(ok.headers.get("location")!, run.url).searchParams.get("id")!;
      assert.equal(run.verify({ finalText: `Done, account ${id}` }).success, true);
    }
    if (scenario.id === "lookup") {
      const res = await (await fetch(`${run.url}/search?q=silent+orchard`)).text();
      assert.match(res, /Next page/);
      assert.equal(run.verify({ finalText: "ISBN 978-1-4028-9462-7" }).success, true);
      assert.equal(run.verify({ finalText: "It is 978-1-4028-9462-7 (not the 2011 978-0-316-48210-3)" }).success, true);
      assert.equal(run.verify({ finalText: "978-0-316-48210-3, maybe 978-1-4028-9462-7" }).success, false);
    }
    if (scenario.id === "booking") {
      const cities = await (await fetch(`${run.url}/api/cities?q=lis`)).json();
      assert.deepEqual(cities, ["Lisbon, Portugal", "Lisburn, United Kingdom"]);
      await fetch(`${run.url}/api/progress`, { method: "POST", body: JSON.stringify({ k: "cookies", v: true }) });
      const ok = await post(`${run.url}/book`, { destination: "Lisbon, Portugal", checkin: "2026-10-14", nights: "3", guests: "2", room: "deluxe" });
      const ref = new URL(ok.headers.get("location")!, run.url).searchParams.get("ref")!;
      assert.equal(run.verify({ finalText: ref }).success, true);
    }
    console.log(`ok  ${scenario.id}  ${run.url}`);
  } finally {
    await run.close();
  }
}

assert.equal(LIVE_SUITE.length, 10, "live suite has 10 scenarios");
