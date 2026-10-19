// Empty-state page of the tab area (agent layout, zero tabs). Plain script (no
// exports), like renderer.ts. Uses its own minimal preload bridge (`penEmpty`,
// preload/empty.ts); wrapped in a function so no name leaks into the global
// scope shared with renderer.ts.
(function () {
  const bridge = (window as unknown as {
    penEmpty: {
      newCanvasTab(): void;
      newBrowserTab(): void;
      newDocTab(): void;
      onState(cb: (state: { theme: "light" | "dark"; sessionTabs: number }) => void): void;
    };
  }).penEmpty;
  document.getElementById("new-canvas")!.addEventListener("click", () => bridge.newCanvasTab());
  document.getElementById("new-browser")!.addEventListener("click", () => bridge.newBrowserTab());
  document.getElementById("new-doc")!.addEventListener("click", () => bridge.newDocTab());
  const note = document.getElementById("sessions-note")!;
  // Fade-in + 4px rise whenever the placeholder appears: first load, and each time the view is
  // shown again (WebContentsView.setVisible fires visibilitychange). Without the `.shown` class the
  // content is in its start state (empty.css); toggling it off, forcing a reflow and on replays it.
  const content = document.getElementById("empty-state")!;
  const replay = () => {
    content.classList.remove("shown");
    void content.offsetWidth;
    content.classList.add("shown");
  };
  replay();
  // Replay only on "visible": `.shown` is never removed on "hidden", so a hidden event without a
  // matching visible one (platform-dependent) cannot leave the buttons at opacity 0.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") replay();
  });
  bridge.onState(({ theme, sessionTabs }) => {
    document.documentElement.dataset.theme = theme;
    note.hidden = !(sessionTabs > 0);
  });
})();
