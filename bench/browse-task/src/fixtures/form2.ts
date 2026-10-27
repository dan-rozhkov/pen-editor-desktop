// The simplest form: two text fields and a Save button, like "add a contact"
// in a CRM. The goal quotes digits (a phone number), which is the case that
// made Luna refuse the submit button after a field fill (memory
// prompt-rules-cause-step-refusals). Every POST is recorded, so refills and
// double submits are visible.

import { serve, html, redirect, readForm, esc, page, type FixtureServer } from "./http.ts";

export const FORM2_EXPECTED = { name: "Ivan Sokolov", phone: "+7 916 555-12-34" } as const;

export interface Contact {
  name: string;
  phone: string;
  contactId: string;
}

function formPage(values: URLSearchParams, error: string): string {
  return page(
    "New contact — Acme CRM",
    `<h1>New contact</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/contacts/new" novalidate>
<label for="name">Full name</label>
<input id="name" name="name" type="text" value="${esc(values.get("name") ?? "")}">
<label for="phone">Phone</label>
<input id="phone" name="phone" type="tel" value="${esc(values.get("phone") ?? "")}">
<p><button type="submit">Save contact</button></p>
</form>`,
  );
}

export interface Form2Fixture extends FixtureServer {
  submissions: () => Contact[];
  posts: () => number;
}

export async function startForm2Fixture(): Promise<Form2Fixture> {
  const done: Contact[] = [];
  let posts = 0;
  let counter = 700;
  const server = await serve(async (req, res, url) => {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/contacts/new")) {
      return html(res, formPage(new URLSearchParams(), ""));
    }
    if (req.method === "POST" && url.pathname === "/contacts/new") {
      posts++;
      const f = await readForm(req);
      if (!(f.get("name") ?? "").trim() || !(f.get("phone") ?? "").trim()) {
        return html(res, formPage(f, "Name and phone are required."), 422);
      }
      const contactId = `C-${++counter}`;
      done.push({ name: f.get("name")!.trim(), phone: f.get("phone")!.trim(), contactId });
      return redirect(res, `/contacts/${contactId}`);
    }
    if (req.method === "GET" && url.pathname.startsWith("/contacts/C-")) {
      const id = url.pathname.split("/").pop() ?? "";
      return html(res, page("Contact saved", `<h1>Contact saved</h1><p>Contact ID: <strong>${esc(id)}</strong></p>`));
    }
    html(res, page("Not found", "<h1>Not found</h1>"), 404);
  });
  return { ...server, submissions: () => [...done], posts: () => posts };
}
