# Changelog

All notable changes to **pen-editor-desktop** (the Electron shell) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [0.9.5](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.9.4...v0.9.5) (2026-10-30)


### Features

* **computer-use:** click and type at screenshot coordinates in app windows ([e2905d4](https://github.com/dan-rozhkov/pen-editor-desktop/commit/e2905d4cfe8191e8a7a83b5c4ec5ffa587860765))
* **empty:** bulk select, search, filter and bulk delete in the Recent list ([8900912](https://github.com/dan-rozhkov/pen-editor-desktop/commit/890091215415ab630f03970c7ca5fc4855cba7ce))
* **tabbar:** one icon per entity: FilmStrip for traces, TreeStructure for workflows ([4aa9cc3](https://github.com/dan-rozhkov/pen-editor-desktop/commit/4aa9cc373d9dd2bf6870d5a538c3aa6edef7f94f))
* **traces:** a document tab can open a trace tab ([0e7a059](https://github.com/dan-rozhkov/pen-editor-desktop/commit/0e7a059cc25e68e7b8013b487d198f3a9d8b94a2))
* **workflows:** store workflows as files on disk and list them in Recent ([4029032](https://github.com/dan-rozhkov/pen-editor-desktop/commit/402903207587e239529927274d3da8d57f1ed890))


### Bug Fixes

* **computer-use:** keep the AX tree of Electron apps on across runs ([12133fb](https://github.com/dan-rozhkov/pen-editor-desktop/commit/12133fb2ca1d83b761ccd42140ffe663bb53ce33))
* **computer-use:** wait for the Chromium AX tree without restarting it ([2ef175a](https://github.com/dan-rozhkov/pen-editor-desktop/commit/2ef175a11b5e9bdb668facccb391f47911334a88))
* **empty:** keep "No matching files" right under the Recent header ([827dfb7](https://github.com/dan-rozhkov/pen-editor-desktop/commit/827dfb7ae87fed18ae86596939e341c17df9b53f))
* **empty:** open the Recent filter as a native menu, like every other popup ([b69628a](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b69628a5e08278a31c0710bbd4b6b57a19b49129))

## [0.9.4](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.9.3...v0.9.4) (2026-10-27)


### Bug Fixes

* **deps:** bump @sideform/browser-agent to v0.4.4 ([47d067f](https://github.com/dan-rozhkov/pen-editor-desktop/commit/47d067fb723d40f0e358562b7ce39d27389731d2))

## [0.9.3](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.9.2...v0.9.3) (2026-10-27)


### Features

* **browser:** ad and tracker blocking, browser control over MCP ([d464e33](https://github.com/dan-rozhkov/pen-editor-desktop/commit/d464e33818f82c42e74797b82d71e231574ab9fa))
* **chats:** keep agent panel chats on disk ([802011d](https://github.com/dan-rozhkov/pen-editor-desktop/commit/802011d12efbbe6d1d325a34b822fade5bb3f18c))
* **computer-use:** assert names the checked element and the window ([8d068b0](https://github.com/dan-rozhkov/pen-editor-desktop/commit/8d068b090cbbcc395d9794737dbb5e01d996c711))
* **settings:** accept the new Settings sections ([9fdebc5](https://github.com/dan-rozhkov/pen-editor-desktop/commit/9fdebc5b529bec4fffb78259fd8b85d99e2f5b67))
* **traces:** DOM snapshots in local traces, capture for Electron apps ([7ef1500](https://github.com/dan-rozhkov/pen-editor-desktop/commit/7ef150019d6550378145f2ef5032f76c44a68cc5))


### Bug Fixes

* **computer-use:** name a missing app instead of "must be a .app bundle" ([fc45497](https://github.com/dan-rozhkov/pen-editor-desktop/commit/fc454976da316d84bb90ede5943f6cf0e8fe826d))
* **computer-use:** window text includes placeholders of empty fields ([4d17a30](https://github.com/dan-rozhkov/pen-editor-desktop/commit/4d17a30eb77f294c54221ff31da8265b2e48c799))
* **empty:** size Recent "Show all" to its label ([4dea194](https://github.com/dan-rozhkov/pen-editor-desktop/commit/4dea194a1e28a647798dac5bd9bde394f282bd72))
* **empty:** style Recent "Show all" like the chat files popover ([7e1adad](https://github.com/dan-rozhkov/pen-editor-desktop/commit/7e1adad923c5c96188ff037be1e27b6a85e84b1d))
* gray pen icons on the History and Passwords pages in light theme ([9643452](https://github.com/dan-rozhkov/pen-editor-desktop/commit/9643452f1f0af5fe02838dffaea5f7c71d7643e1))
* **icons:** draw the shell's icons from the pen icon set ([f4b305f](https://github.com/dan-rozhkov/pen-editor-desktop/commit/f4b305fc64c3b90719805a1b2cd6f06f417f2949))
* **icons:** re-copy the pen set's longer arrow heads ([cbd3164](https://github.com/dan-rozhkov/pen-editor-desktop/commit/cbd31648c602e25d9315793e08fd4d1032ce40fc))
* **icons:** re-copy the pen set's Trash glyph ([3964abd](https://github.com/dan-rozhkov/pen-editor-desktop/commit/3964abda6947a10b3fc1014257c1df032ab74e42))
* **passwords:** match the Settings nav on hover, selection and icons ([ead104c](https://github.com/dan-rozhkov/pen-editor-desktop/commit/ead104c7515bdf69bd196ba9b04f4cebc01e21e3))

## [0.9.2](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.9.1...v0.9.2) (2026-10-25)


### Features

* **browser:** browsing history with address-bar suggestions and a History tab ([e8c822a](https://github.com/dan-rozhkov/pen-editor-desktop/commit/e8c822a34513187b317509864614ee67b20764ac))
* recent canvases and documents on the empty start ([e93edeb](https://github.com/dan-rozhkov/pen-editor-desktop/commit/e93edebee5aa2801fc3194ec6a5207d22d28bfb9))
* Reveal in Finder for canvases, documents and traces ([438cccf](https://github.com/dan-rozhkov/pen-editor-desktop/commit/438cccf420871d76d5a7db217f31dad71addda5f))
* **traces:** list saved traces for the trace viewer ([6a786b3](https://github.com/dan-rozhkov/pen-editor-desktop/commit/6a786b3ff518035afc54afbeddee97dd69cb518c))


### Bug Fixes

* **browser:** address-bar popover URL matches the title size, footer divider edge to edge ([b8603cb](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b8603cba6ebf1b618b7cbdc972b2762633ab4bcd))
* **history:** header matches the Passwords and Settings pages, outline Clear button, 28px search ([e5e0296](https://github.com/dan-rozhkov/pen-editor-desktop/commit/e5e0296945bdd8e19842d0be44630f1c0f5c92a6))
* **menu:** keep the menu template free of the trace store import chain ([f8d2132](https://github.com/dan-rozhkov/pen-editor-desktop/commit/f8d2132204830f466a806e79fabd559c3b90f843))

## [0.9.1](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.9.0...v0.9.1) (2026-10-23)


### Features

* **apps:** block password managers and harden the confirm for risky apps ([ae9d8c7](https://github.com/dan-rozhkov/pen-editor-desktop/commit/ae9d8c73cf50f8e41b45c1fa1e089a8702e736c1))
* **apps:** control an already running macOS app without a restart ([f20bd67](https://github.com/dan-rozhkov/pen-editor-desktop/commit/f20bd67fc156d2545fbf252b124aadf08d6e2545))
* **browser:** verified saved-login submit, mock hits, single-frame trace reads ([b0ddfcc](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b0ddfcc57e7983d11d1fad1a9a5e26a377722c61))
* **computer-use:** native agent cursor is browser-agent's CURSOR_JS ([b9617ec](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b9617ec9bb1fc1fa7c45a9705bf697df620cacd1))
* **doc:** save a document tab as PDF ([4a21a11](https://github.com/dan-rozhkov/pen-editor-desktop/commit/4a21a118f9c640b7f142756aadafb54f6945ef79))
* **docs:** store Markdown documents on disk next to browse traces ([6b3a06f](https://github.com/dan-rozhkov/pen-editor-desktop/commit/6b3a06f9ac7cfc05eff642c3f6ce8df3c7aebc80))
* move to app.sideform.pro and sign in through the system browser ([280ad45](https://github.com/dan-rozhkov/pen-editor-desktop/commit/280ad45364204572f80e0b4eb6bffbeb3cf24685))
* open Passwords as a tab styled like Settings ([3d2c3a1](https://github.com/dan-rozhkov/pen-editor-desktop/commit/3d2c3a17f801ac6d4be9f01cb532d68b21af54f0))
* **passwords:** bring back the large site favicon in the detail header ([d643420](https://github.com/dan-rozhkov/pen-editor-desktop/commit/d6434200014514fd4c327ba997d507fc298a301c))
* **passwords:** list pane matches the Settings nav 1:1 ([7c9b082](https://github.com/dan-rozhkov/pen-editor-desktop/commit/7c9b0824d6f0b28eef3c4fe7a1db21ea45a3a7e9))
* **passwords:** saved logins for @ mentions in doc tabs ([73da277](https://github.com/dan-rozhkov/pen-editor-desktop/commit/73da27789ddbe9ecc33b0b8c3e056b5c47c14e97))
* Settings tab (Cmd+,) for the /settings page ([7de0eb2](https://github.com/dan-rozhkov/pen-editor-desktop/commit/7de0eb256f08f8f785f96f6b0180c11c4f6a6b72))
* **settings:** accept the "browser" settings section ([090eb03](https://github.com/dan-rozhkov/pen-editor-desktop/commit/090eb036bd8dee0d14b65e620b56f379e0059fb2))
* **tabbar:** "Where shall we start?" heading on the empty tab area ([c35c3cd](https://github.com/dan-rozhkov/pen-editor-desktop/commit/c35c3cdc724708c1bbc23b2b54f5785de6bcc6ab))
* **tabs:** workflow tab kind for the /workflow editor ([3f92440](https://github.com/dan-rozhkov/pen-editor-desktop/commit/3f924403bc36ee52b178b374979739b94c76ccb2))
* **trace:** a trace tab can open a document tab ([d0672b9](https://github.com/dan-rozhkov/pen-editor-desktop/commit/d0672b9460f45a4d412df0a048e96be4e32f75b5))
* **trace:** request log of browser tabs and a `requests` command ([483ce13](https://github.com/dan-rozhkov/pen-editor-desktop/commit/483ce1327cf0f74c613c757b3095308722e7af00))
* **trace:** store browse run traces locally and open them in a trace tab ([5d5f30c](https://github.com/dan-rozhkov/pen-editor-desktop/commit/5d5f30c3aa45b5b018606ba726144f561c6e980d))
* **trace:** the agent panel can list open trace tabs and read traces ([286ae85](https://github.com/dan-rozhkov/pen-editor-desktop/commit/286ae8571bccb7832d17a0d2f0d1ba1ab3c27cc7))


### Bug Fixes

* **browser:** agent tabs keep rendering in the background ([0a9903d](https://github.com/dan-rozhkov/pen-editor-desktop/commit/0a9903d1d870b90ddf0d9f2191b5a039fd44baae))
* **browser:** saved login survives late hydration; retry an empty screenshot ([342e7b5](https://github.com/dan-rozhkov/pen-editor-desktop/commit/342e7b5da391a6ef301eb1ad345f622e41208d78))
* **computer-use:** article in the unsupported-check error ([dc897a3](https://github.com/dan-rozhkov/pen-editor-desktop/commit/dc897a31a277d1269a2b72ef701da5aea24a4383))
* **computer-use:** QA checks and lower targets in native macOS apps ([2ca344f](https://github.com/dan-rozhkov/pen-editor-desktop/commit/2ca344f20eb2334f9d855b82ee28817c3bc8f61b))
* **deps:** @sideform/browser-agent v0.3.6 — a revealed password never reaches the model ([b4d1fbb](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b4d1fbb4b0c7e78d91b7bb8f13de13fea9769127))
* **deps:** browser-agent v0.3.1 — drive the app window, not a hidden service window ([8b68a12](https://github.com/dan-rozhkov/pen-editor-desktop/commit/8b68a12f7b31cd3723b5eeaa7ca8bddf4aca75ef))
* **deps:** update @sideform/browser-agent to v0.4.0 ([f362996](https://github.com/dan-rozhkov/pen-editor-desktop/commit/f362996618db1c17c1b05521d6d73e501b82bdb0))
* **empty-state:** no Workflow card on the start screen ([ff985f2](https://github.com/dan-rozhkov/pen-editor-desktop/commit/ff985f2cb3d2b367fe388bd2ecca6e7fb3b89ae6))
* **tabbar:** match the frontend header controls ([87bd845](https://github.com/dan-rozhkov/pen-editor-desktop/commit/87bd8455418ad5b3d6eaef4a6ce81384699b603c))

## [0.9.0](https://github.com/dan-rozhkov/pen-editor-desktop/compare/v0.8.1...v0.9.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **cursor:** one agent cursor motion, no motion setting

### Features

* **apps:** drive an app the user already has open ([fecacec](https://github.com/dan-rozhkov/pen-editor-desktop/commit/fecaceccd86ad7f2d2ff79c4349f4b395a722218))
* **apps:** expose launchApp on the preload browser bridge ([4e45936](https://github.com/dan-rozhkov/pen-editor-desktop/commit/4e459365750709e365fed18d5261a10e24bbf1c9))
* **apps:** the agent launches and drives external Electron apps ([e4fa2a7](https://github.com/dan-rozhkov/pen-editor-desktop/commit/e4fa2a74d0aeb17fcf86d27811d1899afb9d420c))
* **cursor:** one agent cursor motion, no motion setting ([319974c](https://github.com/dan-rozhkov/pen-editor-desktop/commit/319974cd9a18d19af0fe938cd770820ea77321d6))
* **empty:** card-based start screen for the tab area ([83cf659](https://github.com/dan-rozhkov/pen-editor-desktop/commit/83cf659f14e8318c70026d13239b86371a7c0609))
* **motion:** panel slide, tab loading fill, tab enter/exit ([9edcb51](https://github.com/dan-rozhkov/pen-editor-desktop/commit/9edcb5171ad7f47a319204f7addedc2b092c9eb6))
* **panel:** reveal the agent's browser tab on request ([83b2625](https://github.com/dan-rozhkov/pen-editor-desktop/commit/83b2625bef796bcef3c3e85ad18b65e37aefde9f))
* **tabbar:** drag tabs to reorder them ([6997451](https://github.com/dan-rozhkov/pen-editor-desktop/commit/699745111b24f0c6412a2d57053d934c2462462a))
* **tabs:** document tab kind for the /doc editor ([b137297](https://github.com/dan-rozhkov/pen-editor-desktop/commit/b13729796e6f04ae98e3a6ce2a55ca1eca8f30e1))


### Bug Fixes

* **tabbar:** address-row tail takes the browser page background ([00c34ca](https://github.com/dan-rozhkov/pen-editor-desktop/commit/00c34ca9c1b61e9ec449b82cfe5a66848fd7ab15))
* **tabbar:** close button overlays the title instead of reserving room ([3b3a482](https://github.com/dan-rozhkov/pen-editor-desktop/commit/3b3a482bf9487502fc5ad4c4fc77d9ee97d76a2e))
* **tabbar:** sample the page colour through a canvas, honour dark color-scheme ([f01f07b](https://github.com/dan-rozhkov/pen-editor-desktop/commit/f01f07bdb6631c5a435eb2e99f24f79df8a5ee5b))

## [0.8.1] - 2026-10-19

### Changed
- **Browser address row matches the chat header.** Same height, padding, text and bottom border, so both headers form one line across the window.
- **Thinner icons.** The sidebar toggle and the tab icons (paintbrush, globe) use a lighter stroke that matches the "+" button.

### Fixed
- **The chat panel follows the editor theme.** Switching light/dark in a canvas tab now switches the agent panel too (needs the current deployed editor).
- The agent is called **Sideform Agent** everywhere (deployed editor).

## [0.8.0] - 2026-10-18

The app is now **Sideform Desktop**, and it has one layout: the agent chat on the left, canvas and browser tabs on the right.

### Changed
- **Agent layout is the only layout.** The chat lives in a panel on the left (the `/agent` page). Canvas and browser tabs open on the right. A canvas tab is the full editor without its own chat (`/app?chat=off`). The classic layout and the `PEN_DESKTOP_AGENT_LAYOUT` flag are removed.
- **Empty start.** A new window opens with only the chat. A canvas tab opens when the agent needs one, or with New Canvas Tab. Closing the last tab keeps the window open and shows a placeholder.
- **Glass and islands.** The window background is macOS glass. Tabs sit on the glass. The chat and the tab area are rounded islands with an 8 px gap. The browser address row is the top of the tab island. Light and dark follow the editor theme.
- **Tabs.** A paintbrush icon for canvas tabs, a globe for browser tabs, compact spacing. The close button shows on the active tab and on hover. The "+" button is at the right edge.
- **Renamed to Sideform Desktop.** Existing installs keep their data folder and Keychain key, so sessions, cookies and saved logins carry over. Only one copy of the app runs at a time.
- **Close shortcuts.** Cmd/Ctrl+W closes the active tab and never the window. File > Close Window is Cmd/Ctrl+Shift+W.

### Added
- **Chat controls the canvas.** The agent in the panel edits the bound canvas tab over a link through the main process: tool calls, streaming edits and the canvas context. Browser tools run in the panel and do not need a canvas tab.
- **Sidebar toggle.** A button right of the window buttons (or Cmd/Ctrl+Alt+B) hides and shows the chat. The choice is kept between launches.
- **Agent buttons on the canvas** (frame, embed, element, comment "Send to agent") send the request to the chat panel.
- **MCP with no open tab.** A desktop MCP call with no canvas tab opens one in the background.

## [0.7.0] - 2026-10-18

### Added
- **Browser tools menu.** A gear button right of the address field: viewport presets (Responsive, iPhone 15, Pixel 8, iPad, Desktop 1440, Desktop 1920), Developer Tools and zoom for the current site.
- **QA checks.** `qa_assert` checks text, elements, field values, counts and the URL. The result lists console errors and failed requests seen during the run.
- **Device emulation for the agent.** A run can start on a phone, tablet or desktop size with its own locale, time zone and color scheme, and switch the viewport during the run.
- **File upload.** The agent can attach files to file inputs and drop zones.

### Fixed
- Emulating a device on a brand-new browser tab no longer crashes the app.

## [0.6.0] - 2026-10-17

### Added
- **Isolated browser sessions for parallel QA runs.** Each `browse_agent` QA run can get its own private browser: its own cookies, storage, tabs, fixtures and network mocks. Several QA scenarios run at the same time and do not share state. The shared built-in browser does not change.
  - A pool of 6 in-memory sessions for the whole app. A run that finds no free slot waits up to 60 s. When a session closes, its data is wiped before the slot is used again.
  - Session tabs open in the background. Click a tab to watch the run.
- **Saved logins in isolated sessions.** A QA run signs in with a login you saved, so parallel runs can use different accounts of the same site. The agent picks the account by its label or by its username. The password still never reaches the model. Session tabs do not ask to save passwords.
- **Agent cursor on the tab strip.** The browser tab the agent drives shows the agent's cursor before its title, so you can see which tab is working.

### Fixed
- Screenshots of hidden session tabs. On Linux a tab that was never shown cannot paint, so the screenshot now returns a clear error.

### Removed
- `get_design_system` and `lint_design` are no longer in the MCP tool list (the design-system tools were removed from the editor).

## [0.5.0] - 2026-10-16

### Changed
- **The Passwords window is redesigned** in Pen Editor's own look: a sidebar (All logins, Never saved), a searchable list of logins and a detail pane with Edit and Delete. Colors, radii, buttons, fields and badges come from the editor's design tokens and components.
  - It follows the theme of the editor window you used last, light or dark. On macOS the traffic lights sit in the sidebar's top strip, and the sidebar glass turns opaque when the macOS appearance differs from the editor theme.
  - Site tiles are neutral. They show the favicon of a site you opened in the built-in browser, or a globe. The window itself makes no network requests. Icons are cached per site and removed with the site's last login.

### Added
- Edit a saved login in place: username, label, or a new password.
- Adding a login that already exists asks before it replaces the password.
- An Add or Edit form with changes asks "Discard changes?" before you leave it, including with Escape.

## [0.4.0] - 2026-10-16

### Added
- **Saved logins in the built-in browser.** The browsing agent can sign in to a site with a login the user saved, and the password never reaches the model, the chat or the traces. The main process keeps it in the macOS Keychain (`safeStorage`) and types it into the page itself (`fillLogin`, used by the `browse_fill_login` tool). A login is filled only into a page with the same origin (scheme, host and port), and only into the top frame.
  - After a successful manual sign-in, the browser asks "Save password for <site>?". A failed attempt (the page still shows a password field) asks nothing, and "Update password?" defaults to Not Now.
  - **File ▸ Passwords…** lists saved logins (site, username, label, never the password), adds and deletes them, and manages the never-save list.
  - An unreadable credentials file is kept as `browser-credentials.json.bad-<timestamp>`, never overwritten.
- **Page fixtures** (`applyFixture` / `releaseFixture`): cookies, storage, steps and network mocks before a browse task, scoped to the built-in browser's own session.
- **Checkpoint journal commands** for mid-task browser checkpoints.
- **`capture` command** for `browse_capture`: an editable copy of the page on the canvas, with the page CSS fetched through the tab's own session.

### Changed
- The browser controller now comes from the `@sideform/browser-agent` package (v0.2.16); Renovate opens its bump PRs.
- The agent cursor is quiet, and marks are never shown to the user.

### Fixed
- Snapshots: role-less options of open custom dropdowns, transparent tile radios, natively disabled controls, suggestion lists of plain text fields, non-aria overlays reported as the modal, bounded frame labels.

## [0.3.0] - 2026-10-11

### Added
- **Browse step screenshots with numbered marks.** `browse_screenshot` takes `annotate` plus the loop's `snapshotId`: it outlines and numbers the elements of that same snapshot, so the numbers on the image are the indices the decision model picks from, and the snapshot stays valid for the next `perform`. The editor sends this image with every `browse_task` step when the screenshot mode is on (OpenAI Decisions).
- **Label placement that does not cover neighbours.** Each number tries the left, top, right and bottom of its element and takes the first spot that covers no other element, label or page text; dense grids fall back to a small translucent label inside the box. Element picks from the screenshot alone went from 83% to 93% on the click bench, table rows from 0/6 to 6/6.
- **Agent cursor motion engine** (cua-style, five styles, View menu setting); the arrow turns toward its direction of travel.
- **macOS glass tab bar**; the browser tab follows the editor theme.
- MCP advertises the design-system, style, component and lint tools.

### Fixed
- Browser snapshots: date pickers, custom dropdowns, ARIA sliders and hidden range inputs, controls behind modals and overlays, re-mounted targets, `<select>` and checkbox state, shadow DOM and iframes.
- Typing waits for autocomplete suggestions; click effects that land after the settle are caught.

## [0.2.0] - 2026-08-09

### Added
- **The app serves MCP itself, so an agent can drive the editor with no terminal and no tokens.** Until now the MCP bridge only worked for someone running the monorepo locally: `VITE_MCP_WS_TOKEN` is inlined at build time, so it cannot be set on a public deployment, and the hosted backend routes to the most-recently-active socket with no per-user scoping. This app already owns the editor tab, so it hosts the bridge instead — main runs a loopback MCP endpoint and routes `tools/call` into its own `WebContentsView` over IPC. It publishes the same handshake contract the backend already uses (`~/.pen-editor/mcp.json`, dir 0700 / file 0600, atomic write), which `pen-editor-plugin`'s proxy discovers with zero configuration. Install the app and the plugin — that is the whole setup; the plugin needed no changes at all.
- **`list_editor_tabs` and explicit `tabId` addressing.** Routing follows `TabManager.activeId` rather than the backend's most-recently-active guess, and any bridged tool accepts an optional `tabId`. Both are answered in main. Both key off `webContents.id`; mixing that with `TabManager`'s own id space already broke every real `tools/call` once, so a test drives every reported id back through routing.
- **Status surface**, because a packaged user has no terminal: an indicator in the tab strip and a "MCP: \<status\>" item in the File menu. It only reports *listening* when the handshake file was really written. "Use this app for MCP" forces ownership.
- **A tool manifest and its generator** (`scripts/gen-tool-manifest.ts`, `src/main/mcp/toolManifest.json`), pinned by a test against the sibling backend's bridged + static tool sets when that repo is present.

### Security
- The endpoint binds narrowly to 127.0.0.1 rather than binding wide and filtering, and adds a constant-time bearer check plus a loopback check as defense in depth. Two checks the backend does not have: `Host` must match the bound address (DNS rebinding), and any request carrying `Origin` is refused — a real MCP client never sends one, a browser always does.
- Replies are keyed by `(tabId, callId)`, so one tab cannot answer another tab's call and hand the agent a forged document.

### Changed
- The app yields to a locally running `pen-editor-backend`: it probes the existing handshake file, refuses to clobber a live owner, and recovers automatically when that owner goes away.
- Lifecycle is app-scoped, not window-scoped — on macOS closing a window does not quit the app, so the server outlives `createMainWindow`.

### Testing
- ~1,900 lines of new tests across handshake, dispatcher, JSON-RPC, HTTP server, service lifecycle, preload and the tool manifest, plus a cross-repo handshake contract test.
- The e2e suite drives the **real plugin binary** with no `PEN_EDITOR_*` environment against the running app — the literal end-user path — and asserts file modes, an unauthenticated 401, and cleanup on quit. The packaged `.app` was verified against production.

## [0.1.0] - 2026-07-19

### Added
- First Electron shell: `BaseWindow` with a tab-bar `WebContentsView` and one view per tab, each loading the deployed editor (`PEN_DESKTOP_URL` overrides; `npm run dev` points at :5173). Tabs sit in the macOS title bar.
- Native menus forward pen-editor **command-palette ids** over IPC (`menu:command`), executed by `src/lib/desktopBridge.ts` on the page side. The id list is pinned by a contract test that lives in the frontend repo.
- Navigation is clamped to the editor origin, with an offline fallback page.
- `electron-builder` packaging: unsigned arm64 dmg + zip via `npm run dist`. macOS only; no auto-updater, no file associations, no signing.
