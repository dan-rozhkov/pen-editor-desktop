// The frontend serves the showcase gallery at "/" and the editor itself at
// "/app" — the shell must open the editor, never the gallery. An explicit
// PEN_DESKTOP_URL override is used verbatim, so it has to carry "/app" too
// (see the `dev` script in package.json).
export const DEFAULT_EDITOR_URL = "https://pen-editor.onrender.com/app";

/** Editor URL: PEN_DESKTOP_URL override (http/https only), else production. */
export function resolveEditorUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PEN_DESKTOP_URL;
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return override;
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_EDITOR_URL;
}
