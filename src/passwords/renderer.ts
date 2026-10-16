// Plain script (no import/export): it runs from a CSP'd <script src>, like
// src/tabbar/renderer.ts. Wrapped in a function so its names do not collide
// with the tab bar renderer's globals when both are compiled in one program.
// Text goes in through textContent only; no password ever reaches this file
// (the list has origin, username and label).
(function passwordsRenderer() {
  interface Entry {
    id: string;
    origin: string;
    username: string;
    label: string;
  }
  interface ListResult {
    entries: Entry[];
    never: string[];
    encryptionAvailable: boolean;
  }
  type ActionResult = { ok: true } | { ok: false; error: string };
  interface PenPasswordsApi {
    list(): Promise<ListResult>;
    add(payload: { site: string; username: string; password: string; label?: string }): Promise<ActionResult>;
    remove(id: string): Promise<ActionResult>;
    removeNever(host: string): Promise<ActionResult>;
  }

  const api = (window as unknown as { penPasswords: PenPasswordsApi }).penPasswords;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  const unavailableEl = $("unavailable");
  const formEl = $<HTMLFormElement>("add-form");
  const siteEl = $<HTMLInputElement>("site");
  const usernameEl = $<HTMLInputElement>("username");
  const passwordEl = $<HTMLInputElement>("password");
  const labelEl = $<HTMLInputElement>("label");
  const addBtn = $<HTMLButtonElement>("add-btn");
  const statusEl = $("form-status");
  const savedListEl = $("saved-list");
  const savedEmptyEl = $("saved-empty");
  const neverSectionEl = $("never-section");
  const neverListEl = $("never-list");

  function setStatus(text: string, isError: boolean): void {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  function row(main: string, sub: string, buttonLabel: string, onClick: () => void): HTMLLIElement {
    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "main";
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = main;
    text.appendChild(host);
    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "sub";
      subEl.textContent = sub;
      text.appendChild(subEl);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "danger";
    btn.textContent = buttonLabel;
    btn.addEventListener("click", onClick);
    li.append(text, btn);
    return li;
  }

  async function refresh(): Promise<void> {
    const data = await api.list();
    unavailableEl.hidden = data.encryptionAvailable;
    addBtn.disabled = !data.encryptionAvailable;

    savedListEl.replaceChildren(
      ...data.entries.map((e) =>
        row(e.origin, e.label ? `${e.username} · ${e.label}` : e.username, "Delete", () => {
          void api.remove(e.id).then(refresh);
        }),
      ),
    );
    savedEmptyEl.hidden = data.entries.length > 0;

    neverListEl.replaceChildren(
      ...data.never.map((host) =>
        row(host, "", "Remove", () => {
          void api.removeNever(host).then(refresh);
        }),
      ),
    );
    neverSectionEl.hidden = data.never.length === 0;
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    addBtn.disabled = true;
    setStatus("", false);
    const label = labelEl.value.trim();
    void api
      .add({
        site: siteEl.value,
        username: usernameEl.value,
        password: passwordEl.value,
        ...(label ? { label } : {}),
      })
      .then(async (result) => {
        if (result.ok) {
          formEl.reset();
          setStatus("Saved.", false);
          siteEl.focus();
        } else {
          setStatus(result.error, true);
        }
        await refresh();
      })
      .catch(() => {
        setStatus("Could not save the login.", true);
        addBtn.disabled = false;
      })
      .finally(() => {
        // Keep the secret out of the DOM once the request is done.
        if (statusEl.classList.contains("error") === false) passwordEl.value = "";
      });
  });

  void refresh();
})();
