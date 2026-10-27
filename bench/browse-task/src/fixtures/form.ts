// Registration form: 7 text fields, a <select> with a placeholder option, a
// radio group, a checkbox the goal says to LEAVE unchecked and one it says to
// check. Server-side validation re-renders the form with inline errors and
// the submitted values (the same shape as a real signup page), so a partly
// filled submit is recoverable. Targets the refill/re-select loops recorded
// in memory browse-task-form-filling-loops.

import { serve, html, redirect, readForm, esc, page, type FixtureServer } from "./http.ts";

export interface Registration {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  postcode: string;
  country: string;
  plan: string;
  newsletter: boolean;
  terms: boolean;
  accountId: string;
}

export const FORM_EXPECTED = {
  firstName: "Anna",
  lastName: "Petrova",
  email: "anna.petrova@example.com",
  phone: "+49 30 1234567",
  street: "Hauptstrasse 5",
  city: "Berlin",
  postcode: "10115",
  country: "Germany",
  plan: "pro",
  newsletter: false,
  terms: true,
} as const;

const TEXT_FIELDS = [
  ["firstName", "First name", "text"],
  ["lastName", "Last name", "text"],
  ["email", "Email", "email"],
  ["phone", "Phone number", "tel"],
  ["street", "Street address", "text"],
  ["city", "City", "text"],
  ["postcode", "Postal code", "text"],
] as const;

const COUNTRIES = ["Austria", "France", "Germany", "Netherlands", "Poland", "Spain", "Switzerland"];
const PLANS = [
  ["free", "Free — 1 project"],
  ["pro", "Pro — €12/month"],
  ["team", "Team — €30/month"],
] as const;

function formPage(values: URLSearchParams, errors: Record<string, string>): string {
  const err = (k: string) => (errors[k] ? `<div class="error">${esc(errors[k])}</div>` : "");
  const pairs: string[] = [];
  for (let i = 0; i < TEXT_FIELDS.length; i += 2) {
    const cells = TEXT_FIELDS.slice(i, i + 2).map(
      ([name, label, type]) =>
        `<div><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(values.get(name) ?? "")}">${err(name)}</div>`,
    );
    pairs.push(`<div class="row">${cells.join("")}</div>`);
  }
  const country = values.get("country") ?? "";
  const plan = values.get("plan") ?? "free";
  return page(
    "Create your account — Northwind Cloud",
    `<h1>Create your account</h1>
<p>Start with Northwind Cloud in under a minute.</p>
${Object.keys(errors).length ? `<p class="error" role="alert">Please fix the highlighted fields.</p>` : ""}
<form method="post" action="/register" novalidate>
${pairs.join("\n")}
<label for="country">Country</label>
<select id="country" name="country">
  <option value="">Select a country…</option>
  ${COUNTRIES.map((c) => `<option${c === country ? " selected" : ""}>${c}</option>`).join("")}
</select>${err("country")}
<fieldset style="margin-top:14px"><legend>Plan</legend>
${PLANS.map(
  ([v, l]) =>
    `<label style="display:inline-block;margin-right:14px"><input type="radio" name="plan" value="${v}"${v === plan ? " checked" : ""}> ${l}</label>`,
).join("")}
</fieldset>
<label><input type="checkbox" name="newsletter"${values.get("newsletter") ? " checked" : ""}> Send me product news and offers</label>
<label><input type="checkbox" name="terms"${values.get("terms") ? " checked" : ""}> I accept the Terms of Service</label>${err("terms")}
<p><button type="submit">Create account</button></p>
</form>`,
  );
}

export interface FormFixture extends FixtureServer {
  submissions: () => Registration[];
}

export async function startFormFixture(): Promise<FormFixture> {
  const done: Registration[] = [];
  let counter = 4100;
  const server = await serve(async (req, res, url) => {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/register")) {
      return html(res, formPage(new URLSearchParams(), {}));
    }
    if (req.method === "POST" && url.pathname === "/register") {
      const f = await readForm(req);
      const errors: Record<string, string> = {};
      for (const [name, label] of TEXT_FIELDS) if (!(f.get(name) ?? "").trim()) errors[name] = `${label} is required.`;
      if (f.get("email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.get("email")!)) errors.email = "Enter a valid email.";
      if (!f.get("country")) errors.country = "Please select a country.";
      if (!f.get("terms")) errors.terms = "You must accept the terms.";
      if (Object.keys(errors).length) return html(res, formPage(f, errors), 422);
      const accountId = `NW-${++counter}`;
      done.push({
        firstName: f.get("firstName")!.trim(),
        lastName: f.get("lastName")!.trim(),
        email: f.get("email")!.trim(),
        phone: f.get("phone")!.trim(),
        street: f.get("street")!.trim(),
        city: f.get("city")!.trim(),
        postcode: f.get("postcode")!.trim(),
        country: f.get("country")!,
        plan: f.get("plan") ?? "",
        newsletter: f.get("newsletter") !== null,
        terms: true,
        accountId,
      });
      return redirect(res, `/welcome?id=${accountId}`);
    }
    if (req.method === "GET" && url.pathname === "/welcome") {
      const id = url.searchParams.get("id") ?? "";
      return html(res, page("Welcome", `<h1>Welcome aboard!</h1><p>Your account is ready. Account ID: <strong id="account-id">${esc(id)}</strong></p>`));
    }
    html(res, page("Not found", "<h1>Not found</h1>"), 404);
  });
  return { ...server, submissions: () => [...done] };
}
