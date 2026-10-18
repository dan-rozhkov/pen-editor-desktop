// Empty-state page of the tab area (agent layout, zero tabs). Plain script (no
// exports), like renderer.ts. Uses its own minimal preload bridge (`penEmpty`,
// preload/empty.ts); wrapped in a function so no name leaks into the global
// scope shared with renderer.ts.
(function () {
  const bridge = (window as unknown as {
    penEmpty: {
      newCanvasTab(): void;
      newBrowserTab(): void;
      onTheme(cb: (theme: "light" | "dark") => void): void;
    };
  }).penEmpty;
  document.getElementById("new-canvas")!.addEventListener("click", () => bridge.newCanvasTab());
  document.getElementById("new-browser")!.addEventListener("click", () => bridge.newBrowserTab());
  bridge.onTheme((theme) => {
    document.documentElement.dataset.theme = theme;
  });
})();
