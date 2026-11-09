# Wtv spec

The build order as it ran (round 1: steps 0–9, round 2: steps 10–17), the architecture decisions,
the feature specs (kept current as features change), and what's still open. New work is planned in
[`todo.md`](../todo.md); once built, it lands here.

New Plugin - wtv - Web TV - Wtv

Starting over on a project I have already released because I realize I did a terrible implementation, and so I'm starting fresh here before I publish this extension to the chrome store over the previous one.

The idea is to turn a browser into a tv, and every website / video is a show. It's intended to just be on in the background. Eventually I'll publish an authoritative playlist as a "tv station", but for v1 the focus is exclusively on audio / video sources.

---

## Build Order

Each step is reviewed and committed before the next one starts.

- [x] **Step 0 — Update this todo** with the technical review, architecture decisions, and build order.
- [x] **Step 1 — Project scaffold + site config format + loader**
    - WXT + TypeScript project, `dev` and `store` build modes, Vitest wired up. Version `2.0.0`.
    - Site config JSON schema (versioned), bundled configs in `src/sites/` (YouTube only to start), override layering + hash stamping.
    - `chrome.storage` wrappers, `onInstalled` schema migrations. The previous extension's data is cleared, not migrated.
- [x] **Step 2 — Media detection**
    - MAIN-world `document_start` hook on `HTMLMediaElement.prototype.play` (and `attachShadow`).
    - Primary-media heuristic with the config `video` match as a strong bonus. Works across shadow roots and `all_frames`.
    - Generic site profile for any site without a config (see Generic sites), with per-site opt-in via `optional_host_permissions`.
    - Runtime content-script registration, popup (enable / disable / just this tab / media status), dev outline of the primary.
- [x] **Step 3 — Ad detection + tab mute + skip**
    - `exists` / `visible` conditions, `MutationObserver` driven, debounce/grace period.
    - Tab-level mute with `mutedInfo` ownership tracking. Best-effort skip click.
    - Per-frame ad ports to the background, `AD` badge, `Mute ads` / `Auto-skip ads` settings in the popup.
- [x] **Step 4 — Overlay iframe**
    - Extension-origin iframe for blackout, quotes, slideshow, click shield.
    - Image import into IndexedDB, domain folders + keyword resolution, filename durations, bundled default cat pack.
    - Options page (folder import + "Try it"), popup toggle + link. Blackout mode built but only used from step 7.
- [x] **Step 5 — Selector picker side panel**
    - Element picker, candidate ranking, delayed pick, live match count, save as override.
    - Dev-mode only: write configs straight to the repo via File System Access API.
- [x] **Step 6 — Maximize + TV fullscreen**
    - Top-layer popover maximize with `::backdrop` letterbox. Window-level fullscreen.
    - Click-to-play/pause shield, keyboard shortcuts.
- [x] **Step 7 — Playlists**
    - Parser / serializer with round-trip tests. Runner in background with session state.
    - Next / previous, end detection, blackout between entries, multi-playlist add, context menu, export.
- [x] **Step 8 — Hash params + seeking**
    - Namespaced `#wtv:` hash, timestamp formats, seek-after-preroll.
- [x] **Step 9 — Site health checks**
    - Playwright daily runner (outside the extension) + in-extension "selectors may be broken" badge.

Round 2 (planned in `todo.md`, now merged here; F-numbers pointed into `docs/future.md` as it was then):

- [x] **Step 10 — Overlay control + YouTube's "Continue watching?"** [F1, F6]
    - **Show pictures** pill after ✕, and in the popup's Ads row. The `continuePrompt` role, clicked only when nobody has used the page for a minute. The stuck-ad safety net (10 min with the video's time not moving).
- [x] **Step 11 — Selector panel: remove selectors, metadata preview** [F2, F4]
    - ✕ per selector, **Remove unmatched**, **Undo**. Metadata extraction (`src/lib/metadata/`) and the panel's **Preview**.
- [x] **Step 12 — Pictures outside ads** [F5, F11]
    - **Show pictures while paused**. `view=pictures`, `[view pictures]`, `[show]`.
- [x] **Step 13 — Playlist options** [F16, F13]
    - `end=` / `dur=` (hash `e=`), `[shuffle]` with **Reshuffle**, `[loop]`.
- [x] **Step 14 — Media library** [F7, F9, part of F10]
    - Durations, thumbnails (`thumbnailHosts`), the `unavailable` role and gone entries.
- [x] **Step 15 — Built-in playlists + backup / restore** [F3, F8, F12]
    - `src/playlists/*.txt` + placeholder SVG covers, `npm run health -- --playlists`, **Export everything** / **Import…**.
- [x] **Step 16 — Playlist explorer side panel** [F10]
- [x] **Step 17 — Non-video shows: web pages and posts** [F14, F15]
    - `view=read` (Readability), `view=scroll`, `view=card` (post adapters: X, Reddit, Bluesky).

---

## Architecture Decisions

- **Dependencies:** exact-pinned, and only versions published at least two weeks ago. `web-ext` (WXT's optional auto-launch-browser peer) is deliberately not installed, because its Firefox tooling pulls in vulnerable packages. In dev, load `.output/chrome-mv3-dev` unpacked once; WXT reloads it on change.
- **Framework:** [WXT](https://wxt.dev) + TypeScript. Two build modes:
    - `dev` — includes the selector-authoring tools (write configs to repo). Only for me.
    - `store` — dev tools stripped out, no extra permissions.
- **No local server.** Dev tooling writes site configs directly to the repo's `src/sites/` folder from an extension page using the File System Access API (`showDirectoryPicker()`, handle persisted in IndexedDB, "Allow on every visit" permission). Must run from the side panel / options page, not the popup (popups close when the picker steals focus).
- **Selectors live in source.** No public webservice for selector sync. Users can override broken selectors locally until a fix release ships. A selector import system can come later if popularity grows.
- **Site configs are data, not code.** JSON per site. Optional small code hooks are allowed, but only in source (never from overrides), to stay clear of store "remote code" rules.
- **Service worker is stateless.** MV3 workers die after ~30s idle. Playlist position, TV-mode tabs, and ad/mute state live in `chrome.storage.session`.
- **Storage:** `chrome.storage.local` for config, overrides, playlists (not `window.localStorage`, which is per-site in content scripts and missing in the worker). IndexedDB (extension origin) for image blobs, with `unlimitedStorage`.
- **Overlays render in an extension-origin iframe** (`web_accessible_resources`). It can read the extension's IndexedDB, is immune to site CSS, can't be read by site scripts, and doubles as the ad click shield.
- **Event-driven, not polling.** `MutationObserver` + media events instead of `setInterval`, because Chrome heavily throttles timers in background / silent tabs.

### Publishing over the previous extension

- [ ] Version number must be higher than the currently published one.
- [ ] Diff the new manifest's permission warnings against the old one. **New warnings disable the extension for existing users until they accept.**
- [ ] `runtime.onInstalled` with `reason: "update"` → wipe the old extension's storage (nothing worth keeping).
- [ ] Scope `host_permissions` to the sites with bundled configs. Use `optional_host_permissions` + `chrome.permissions.request` when a user enables Wtv on another site. Avoids `<all_urls>` in-depth review.

---

## Feature Specs

### Site configs + overrides

- One JSON file per site in `src/sites/<id>.json` (file name = `id`): `schemaVersion`, `id`, `name`, `domains`, `roles`, optional `quirks` (`controlBarInset` for the click shield; `adsInMainVideo` when ads play in the main `<video>`, as on YouTube; `noAds` and `startsItself`, see Selector picker → Site switches), optional `thumbnailHosts` (where the site's thumbnails live, e.g. `i.ytimg.com`: requested at Play for the media library, never given content scripts). The folder holds only data, so the dev repo writer can be pointed at it.
- Validated at build time (`wxt.config.ts` fails the build) and in tests. Bundled `host_permissions` are generated from `domains`.
- **Roles:** `video`, `player` (optional: the player's outer box; ad pictures cover it, and it's searched for unlisted Skip buttons), `adIndicator`, `skip`, `continuePrompt` (optional, see Ad detection + muting), `unavailable` (optional: the player's "Video unavailable" message, see Media library), `playButton` (optional), `progressBar` (optional, click-to-seek geometry), `title`, `description`, `keywords`, `creator`, and the post roles (optional, for `view=card` read from the page; see Pages and posts as shows): `post` (the box around the post; the others are looked for in it first; for all post roles an element on screen wins over a hidden one, `matchRoleShownFirst`, since apps like Bluesky keep the posts you navigated away from in the DOM, hidden, ahead of the current one), `postTitle`, `postAuthor`, `postText`, `postTime` (a `<time datetime>` is read from its datetime), `postImage` (up to 4 pictures; in the post's box first, then anywhere, like the others), `postEmbed` (the post's player when it's embedded from another site: picked as the `<iframe>` or the box it's in, and shown in place, see `view=card`). A site has post selectors when it has `postText`, `postTitle`, `postImage` or `postEmbed` (`hasPostSelectors`), and a page has a post when any of those read something: a post of only a picture (or a player) is a card of only that.
- **Each role is an ordered list of fallback selectors**, not a single selector. First match wins. Entries are a selector string or `{ "selector", "when" }`.
- **Selector format supports shadow DOM** traversal with ` >>> `, e.g. `"ytd-app >>> #movie_player video"`.
- **`when` condition** per selector, since many sites leave ad nodes in the DOM and only hide them:
    - `exists` or `visible`. Defaults per role (`adIndicator`, `skip`, `playButton` → `visible`; others → `exists`).
    - Class / attribute conditions are written in the CSS itself (e.g. `#movie_player.ad-showing`), so no separate detector types.
- **Metadata extraction** (`src/lib/metadata/`: `extract.ts` pure + tested over collected page facts; `page.ts` collects them from the DOM): title, creator, description, keywords, thumbnail, duration. Order per field:
    1. The user's own selector for the role (an override saved in the side panel: they picked it because the page's data was wrong).
    2. JSON-LD (`VideoObject` first, then other media and article types; `@graph` and nested items like an article's `video` included).
    3. OpenGraph (`og:*`, `video:*`, `article:*`).
    4. Other meta tags: `name=` (`description`, `keywords`, `author`, `twitter:*`) and microdata (`itemprop`, only on media / article items).
    5. The site config's selector for the role.
    6. `document.title` (title only, without a leading "(3)" notification count).
    - On SPAs (YouTube) the `<head>` goes stale after in-app navigation: when `og:url` (else `<link rel=canonical>`) names another page, every OpenGraph and `name=` tag is ignored. A JSON-LD item whose `url` is another page of the same site is ignored too; one on another site (an embedded video) is kept.
    - Used by the popup's Media row (title, creator) and the side panel Preview; the media library (step 14 of round 2) will store it.
- **Overrides:**
    - Stored per role, not per site.
    - Each override records `baseHash`: a hash of the bundled role it replaced (`none` if the bundled config had no such role). No manual version bumping.
    - An override applies only while the bundled role still hashes to `baseHash`. When a release changes that role, bundled wins, the override is pruned on update, and a notice is stored for the UI.
    - Overrides with their own `domains` for a site with no bundled config are **user-defined sites**.

### Generic sites

Sites will ultimately be completely dynamic. YouTube is the only bundled config to start. Resolution order for a page:

1. Bundled config (with any user overrides).
2. User-defined site (built with the picker).
3. **Generic profile:** no selectors, everything heuristic.

- The generic profile covers what doesn't need site knowledge:
    - Media detection (play() hook + largest-playing heuristic).
    - Metadata (JSON-LD → OpenGraph → `document.title`).
    - Maximize, click-to-play, playlists, hash seeking.
- **No ad detection in the generic profile** (no reliable universal signal). Picking an `adIndicator` with the picker turns the site into a user-defined site.
    - Worth investigating later: Google IMA SDK iframes (`imasdk.googleapis.com`) are a cross-site ad signal on many players; media `src` / duration swaps mid-playback.
- **Permissions:** bundled sites get `host_permissions`. Any other site is opt-in:
    - `optional_host_permissions: ["*://*/*"]` (no install warning), requested per site from the popup via `chrome.permissions.request`.
    - **All content scripts are registered at runtime** (`chrome.scripting.registerContentScripts`) for exactly the origins Wtv holds: bundled `host_permissions` plus granted optional origins. Bundled and opt-in sites share one code path. Re-synced on install / startup / `permissions.onAdded|onRemoved`; already-open matching tabs are injected on grant.
    - Popup: **Enable on this site** (exact-host grant), **Just this tab** (`activeTab`, top frame only, no persistent grant), **Disable on this site** (optional origins only; bundled sites are managed from Chrome's site-access menu). It also shows what the agent detected.

### Ad detection + muting

- Detect ads on video sites, mute the tab until the ad indicator is gone, then unmute.
- **Mute the tab, not the element:** `chrome.tabs.update(tabId, { muted: true })`. Ads can play in other elements / iframes, and players reset `video.muted`.
- **Only unmute what we muted:** check `tab.mutedInfo.reason === "extension"` and `extensionId` matches ours. Respect the user muting before an ad or unmuting during one.
- **Ending an ad** (`src/lib/ads/end.ts`, pure + tested): the indicator must be gone for 1.5 s *and* the show must be playing (its time moving), or 8 s must pass. The indicator can drop for a moment between the ads of a pod or while the player reloads the show, and ending the ad there flashed the page.
- **Stuck ads:** an ad showing for 10 minutes with the video's time not moving is treated as over (no muting or covering) until the video moves or the indicator goes away.
- **"Continue watching?" dialogs** (`continuePrompt` role, `src/lib/prompts/continue.ts`): looked for for 15 s after each pause of the video, and confirmed only when the page has had no trusted key / click / wheel for a minute (sites reuse the dialog for confirmations people ask for). Click strategies as for Skip; if all are ignored, Wtv plays the video and hides the dialog.
- Driven by `MutationObserver` (child lists + `class` / `hidden` attributes, not `style`, which players animate constantly) + primary media events, with `timeupdate` as a heartbeat that catches style-only visibility changes while something plays. Evaluations are capped at one per 150 ms. Only runs on sites with an `adIndicator` role.
- **Reporting:** each frame opens a port (`wtv-ad`) to the background only while it has an ad. A port closing (ad over, navigation, unload, script invalidated) clears that frame, so a dead frame can't leave a tab muted. If the worker restarts mid-ad, frames reconnect and re-send.
- **Background:** tab "ad showing" = any frame active (`AD` badge). "Want mute" = any active frame with `muteAds` on. Mute ownership is kept in `storage.session` to survive worker restarts; tabs we muted whose frames never come back are unmuted after a 5 s recovery grace.
- **Ownership rules** (`src/lib/ads/mute.ts`, pure + tested): mute only an audible tab; if the user unmutes or re-mutes mid-ad, give up ownership for that ad; unmute only if still muted by *this* extension.
- **Settings:** `muteAds` and `autoSkip` (both on by default), toggled in the popup. (Also in the popup: `adOverlay`, `clickShield`, `pausePictures`.)

### Skip button

- Automatically click the skip button when it appears and is clickable. Discovered / maintained as a role like `video` and `adIndicator`.
- Content-script clicks are `isTrusted: false`, and some players ignore them. The only trusted route is `chrome.debugger` (shows a warning bar), so **skip is best-effort**. Mute + overlay is the guaranteed path.
- Each retry on the same button uses the next **click strategy** (`src/lib/dom/click.ts`): the full pointer + mouse sequence at its centre, the same on whatever is hit-tested there (a label inside it), `element.click()`, then focus + Enter / Space. A strategy that makes the button go away within 1.5 s is remembered for the page and tried first. The ad status keeps a log of attempts.
- **Unlisted Skip buttons:** when no `skip` selector matches, a visible button inside the `player` box that looks like Skip (class / id / label / short text, `src/lib/ads/skip.ts`), then anything saying "skip" where the show is or was just before the ad (the **ad probe**, `src/lib/ads/probe.ts`). Each is logged to the console so it can be added to the role.
- If the Skip button is still there 1 s after the click and the site has `quirks.adsInMainVideo` (YouTube, which ignores untrusted clicks), the ad is seeked to its end instead. Only once per Skip button, and only once Skip is showing, so only skippable ads are skipped. The popup counts both.

### Media detection

- Auto-detect the primary media element, falling back to hard-coded config selectors.
- **MAIN-world hook** (`"world": "MAIN"`, `document_start`) wraps `HTMLMediaElement.prototype.play` to catch every element that plays, including detached `new Audio()` players with no DOM node. Also wrap `attachShadow` to see into closed shadow roots.
    - Wrappers are Proxies, so `play.toString()` still reports native code.
    - Media the isolated world can reach is announced on the element. Media it can't reach (detached, or in a closed shadow root) is **bridged**: the hook posts its state and accepts play / pause / seek / mute commands over DOM events (JSON details, validated on both sides since the page can see and forge them).
- **Discovery** (isolated agent): hook events, capture-phase media events on the document and each open shadow root, and a scan of `video, audio` plus the config `video` role. Re-scans at most once a second, only when elements are added. No polling.
- **Heuristic** (`src/lib/media/score.ts`, pure + tested):
    - Viable = has a source and is either on screen at ≥ 200×112 or playing audibly (audio-only players have no geometry).
    - Score: playing, audible, share of viewport, long or live duration; penalties for short clips and muted loops (GIF-style videos, hover previews).
    - **The config `video` match is a large bonus, not an override.** A matched-but-hidden player (YouTube's watch player while on the home page) isn't viable. If the config has a `video` role and nothing matched, status reports `configVideoMissing` (early "selectors may be broken" signal).
    - The current primary gets a stickiness bonus so near-ties don't flicker.
- Content scripts run with `all_frames: true` for embedded players. Each frame picks its own primary. (Cross-origin embeds need permission for the embed's origin too.)
- **Dev builds** outline the primary with a labelled dashed box and log changes to the console.
- **Dev builds, debugging aids** (`src/lib/dev/`, compiled out of the store build):
    - The **ad probe** runs twice a second during an ad (every 5 s after 30 s): what's on top in the player / video / pre-ad video areas, page elements drawn above our overlay, every element saying "skip" with an HTML snippet, iframes over the areas. Logged when it changes; also in the ad status.
    - **📸 Snapshot** button (top right): saves the whole DOM (open shadow roots included), element boxes over the player, the probe, media / ad status, the overlay timeline and a screenshot (needs the toolbar icon clicked once on the tab: `captureVisibleTab` wants `activeTab`) as one JSON file in Downloads.
    - **Timeline:** the last 300 overlay / ad events; an "overlay blip" warning prints it when the ad pictures go away and come back within 5 s.
    - **Reload Wtv** (playlists page, Dev): reloads the extension from disk without losing your place (`src/lib/dev/reload.ts`, tested). Reloading closes the extension's tabs, so first it notes the open playlists / options pages (URL with `?id=`, window, position, active, pinned; found with `extension.getViews`, since `tabs.query` gives no URLs without the `tabs` permission) and this page's unsaved playlist text in `storage.local` (`session` is cleared by the reload). The new background opens them again where they were (a note older than a minute is ignored), and the playlists page showing that playlist takes the draft back, marked unsaved. Playing playlists stop with the reload; their card pages aren't reopened. Reloading from `chrome://extensions` can't do this (nothing runs first).

### Selector picker (side panel)

- `chrome.sidePanel` UI to pick DOM nodes and generate unique CSS selectors for each role: the side panel's **Fix selectors** view (beside **Playlists**, see Playlist explorer). Opened from the popup's **Fix selectors…**, which asks that window's panel for this view (`src/lib/sidepanel-view.ts`: localStorage + the `storage` event, since `sidePanel.open()` must run synchronously in the click). It only talks to the page while it's the view showing. Ships in the store build (users fix their own session); only the repo writer is dev-only.
- Roles in collapsible groups (`ROLE_GROUPS`): Player, Ads and prompts, About the video, Posts. Posts starts closed until the site has a post selector; open / closed is remembered per group. The Posts group has a **card preview**: the post card this page would make (`wtv/pick/post` → `readPagePost`), refreshed with the metadata Preview. The test line of a post role shows what it reads. With an embed, the preview says it plays beside the card instead of the pictures. **Preview on the page** (`wtv/pick/preview`, `src/lib/posts/preview.ts`) shows the real card over the tab, as a playlist entry would, until **✕ Close preview** (or Esc in the page): the card page is framed in preview mode (`card.html?preview[&embed=1]#token`) and gets the post by postMessage, checked against the random token in its fragment; an embedded player is lifted beside it as in a playlist. Nothing is reported to a playlist, and there's no countdown (no progress bar; long text scrolls with the wheel): the card stays until it's closed.
- **Site switches** (above the Preview; `quirks` in the site's override, `withQuirk`, pure + tested): **No ads on this site** (`noAds`: the ad watcher stays off even with ad selectors: no muting, skipping, ad pictures; the popup says there's no ad detection) and **Videos start by themselves** (`startsItself`: see Playlists → Blackout). They're settings, not selectors: they apply whatever a release changes, and a value equal to the built-in one is dropped, so only differences are stored. On a site with no config, turning one on makes it a user-defined site. Copy site config JSON includes them.
- Per role: current selectors with live match counts and which one wins, source (built-in / yours), **Pick**, **Pick in 5 s**, **Type selector**, **Reset**.
- **Removing selectors:** a **✕** on each selector row, and **Remove unmatched (n)** per role (every selector with 0 matches right now; asks first, and warns for roles that only show during an ad or dialog). Removal saves an override with the rest (`withSelectorsRemoved`, pure + tested):
    - What's left equals the built-in list: the override is dropped instead (same as Reset).
    - Nothing left of a built-in role: an empty override, which turns the role off for that site ("removed · yours") until Reset or a release that changes the role.
    - **Undo** restores the site's overrides as they were before the last removal.
- **Preview** (collapsible, at the top): the metadata Wtv reads from the page (see Metadata below), each value with its source; hover the source for the exact tag / JSON-LD key, and expand "other values" to see what every other source says. Refreshed every 3 s while the panel is visible. While editing a metadata role's selector, the test line shows what it reads.
- Generate **several ranked candidates** per pick (own generator in `src/lib/picker/`, no dependency):
    - Prefer: `id`, test ids (`data-testid` etc.), `itemprop`, other `data-*`, `name`.
    - Then: stable class names (singles and pairs), then "inside a stable ancestor".
    - Last resort: `nth-of-type` path from the nearest stable ancestor.
    - Filtered out: hashed / generated ids and classes (`css-1x9f2`, `Button_root__a1b2c`, framework ids), state classes (`active`, `is-open`). Pure + tested.
    - Avoid text / `aria-label` selectors. They're localized and break for non-English users.
    - Elements in open shadow roots get host selectors joined with ` >>> `. Non-unique candidates are kept but ranked down.
- **In-page picker:** hover highlight with tag + size, click to select, **↑ / ↓** walk to parent and back, **P** play/pause the primary (freeze an ad), **Esc** cancel. The keys work whether the page or the side panel has focus (the panel forwards them). The ad overlay steps aside while picking. Runs in every frame; the frame you click in answers.
- **The page never sees a pick** (`src/lib/picker/guard.ts`): pointer / mouse / touch / click / contextmenu / drag events are stopped by window capture listeners the content script adds at `document_start`, before any page script has added its own (same-target listeners run in the order added, so the page's never run). Listeners added when picking starts would run after the page's, and a page that acts on pointerdown at the window (Reddit's media viewer) got there first and ate the click. The pick is the element pressed on; if no click follows within 350 ms of pointerup, it's taken anyway. Injected into an already-open page (no early guard), the picker listens itself, as before.
- **Embedded frames** (`shieldFrames` in `src/lib/picker/picker.ts`): a frame Wtv doesn't run in (a player embedded from another site, like the one inside Reddit's `shreddit-embed`) would take the click itself, out of reach of the guard, and its player would open its own popup. While picking, every such `<iframe>` (also in open shadow roots, rescanned every second) gets `pointer-events: none !important`, so hover and click land on the element holding it; afterwards its inline value is put back exactly. Frames that do run Wtv have their own picker and say so (`postMessage` `wtv-picker-live`, also in answer to the parent's `wtv-picker-ask`), so they stay live. A page could send that too; all it gets is its own iframe left clickable.
- **Delayed pick** (5 s countdown) because skip buttons and ad indicators are transient.
- **Editor:** candidate list, editable selector, condition (default / exists / visible), live test with green outlines on every match, "keep current selectors as fallbacks" (on by default: the new one goes first).
- **Save** writes the override to `chrome.storage.local`. On a generic site this creates a user-defined site for the host (minus `www.`).
- **Copy site config JSON** (all builds): the effective config in the `src/sites/` file format, for users to send fixes.
- **Dev mode only:** **Write to repo…** saves `<id>.json` straight into `src/sites/` via File System Access API (folder picked once, handle remembered). Not present in the store build. Once the rebuilt bundled role matches, the local override is pruned automatically on update (hash stamping).

### Overlay iframe (blackout, quotes, slideshow)

- Show a slideshow of images, or quotes, over the video while ads play.
- **Frame:** `overlay.html` (extension page, the only web-accessible resource) in an iframe inside a **closed shadow root** on a `popover="manual"` host. The page can't read or restyle it; the popover puts it in the top layer (above fullscreen players, re-stacked on `fullscreenchange`). Kept alive between ads so the next one covers instantly; preloaded on sites with ad selectors.
    - Channel: `MessageChannel` handed over with a random token that's also in the iframe URL hash (unreadable by the page).
    - Glued with a rAF loop to the site's `player` box holding the primary video (ads like YouTube's surveys move the `<video>` out and draw in its place), else the primary video's rect. If the box disappears for a moment (re-layout), it holds its last place for 1 s. No rect (audio-only) → no overlay, just mute. Ad pictures and the blackout paint the host black from the first frame.
    - **Extension reloaded under an open tab** (dev rebuilds, store updates, turned off): the old content script keeps running but its overlay iframe goes blank, a black box over the video. A 1 s check (`ctx.setInterval` reads `ctx.isInvalid`) notices, and every `onInvalidated` cleanup runs, which removes the overlay. Wtv is then off in that tab until it's reloaded.
    - Covering the video is the ad click shield. A ✕ on the overlay hides it for the rest of the current ad; a **Show pictures** pill in the player's top-right corner (and a popup button) brings it back.
    - Commands: `ad` (program + host), `pictures` (program + host, `purpose` `pause` or `show`, `paused`), `blackout` (title, for playlists), `shield` (transparent click shield, see Click to play / pause), `pill`, `hide`.
    - **Pictures outside ads** (`pictures` command; clicks on them play / pause the show, double-click maximizes, keys reach the page):
        - **On pause** (setting `pausePictures`, "Show pictures while paused", off by default): a show (`isShow`) paused by anything, after 1.5 s, not while buffering, seeking, loading, at its end or during an ad (`src/lib/overlay/pause.ts`, pure + tested). Badge "⏸ Paused · click to resume"; a click, or play from any other control, takes it away. Program: the entry's `[ads]`, the playlist default, then site pictures.
        - **As the show** (playlist entry `view=pictures`): the media plays unseen under its `[show]` program for the whole entry. Covers the player / media box, or the whole tab for media with no box (audio). Paused: the pictures dim, hold the current slide and show ⏸. Ads still get the ad program.
    - Not using `use_dynamic_url` yet: it would stop sites from detecting Wtv by probing `overlay.html`, but needs testing against `runtime.getURL`.
- **Images:**
    - "Load from folder" workflow in the options page (File System Access needs a page that stays open; the popup closes on the picker): pick a folder, import into IndexedDB (`unlimitedStorage`), keep the handle for **Re-import**. Import replaces the library atomically. Files over 100 MB are skipped.
    - The options page has a **Try it** box: site + keyword → which files would show.
    - The overlay reads IndexedDB directly (same extension origin). If Chrome ever partitions that storage for framed extension pages, it falls back to the bundled cats.
    - **Filename duration:** `_d(\d+)(s|m)?` immediately before the extension, e.g. `grumpy_d20s.png`. Default 5s.
    - Formats: PNG, JPG, WebP, GIF, WebM (WebM plays muted and loops for its duration).

#### Image folder layout

    images/                 ← picked root
      relax.png             ← top-level files
      cats/                 ← top-level keyword folder
      youtube.com/          ← domain folder (name contains a dot)
        grumpy_cats_d10s.png
        cats/               ← domain keyword folder (max depth)
          ...               ← anything deeper is ignored at import

- **Domain folders** are any top-level folder whose name contains a dot. They are scopes, not keywords.
    - Matches the current hostname exactly or as a suffix (`youtube.com/` matches `www.youtube.com` and `m.youtube.com`). Most specific folder wins.
- **Keyword folders** are one level deep only: `images/<keyword>/` or `images/<domain>/<keyword>/`. Files nested deeper are skipped at import (with a count shown in the import summary).
- **Keyword filename match:** case-insensitive substring of the filename, ignoring the extension and `_dNNs` suffix (`cats` matches `grumpy_cats_d10s.png`).

#### `[img ...]` resolution

`[img cats]` on `www.youtube.com`, first non-empty step wins:

1. `youtube.com/cats/` folder → all files in it.
2. `youtube.com/` files (top level of the domain folder) with `cats` in the filename.
3. `cats/` top-level folder → all files in it.
4. Top-level files with `cats` in the filename.
5. Nothing matched → bundled cat pack.

Steps 1–2 are skipped when there's no domain folder for the current site.

`[img]` with no keyword (and the default slideshow when no playlist `[ads]` block applies):

1. Files at the top level of the domain folder.
2. Top-level files.
3. Bundled cat pack.

- Single syntax for folders and filename keywords: folder match first, filename match as fallback. A separate syntax can be added later if there's a real need to force a filename match when a same-named folder exists.
- **Bundled pack:** four original SVG cat cartoons in `public/cats/` (drawn for Wtv, so no licensing to track).
- **Quotes:** duration-prefixed lines from the playlist `[ads]` block (see Playlists).
- **Rotation:** program items in order; each `[img]` item expands to its images, shuffled. Loops with a fresh shuffle when exhausted; cross-fades between slides; cut when the ad ends (see Ending an ad, same as unmute). Duration: item's explicit `N` > file name `_dNs` > 5 s.
- **Fit:** fill the frame (`cover`) when that crops less than 20% of the picture, otherwise show it whole with letterbox bars (`contain`). Re-evaluated when the overlay resizes (`src/lib/overlay/fit.ts`, pure + tested).
- **Setting:** `adOverlay` ("Show pictures during ads", on by default).

### Click to play / pause

- Play / pause by clicking the video itself without triggering accidental ad clicks.
- **Click shield** = the overlay iframe in a transparent `shield` mode (`src/lib/overlay/controller.ts` decides what the overlay shows). Setting `clickShield` ("Click the video to play / pause", on by default).
    - Normal playback: covers the video but leaves the site's control bar uncovered (`quirks.controlBarInset`, default 56 px on generic sites). Only over a **show** (`src/lib/overlay/shield.ts`, pure + tested): the config `video` match, or an audible, non-looping video ≥ 30 s / live. Hover previews and GIF-style loops stay clickable.
    - During ads (pictures off) and while maximized: covers everything. The ad ✕ hides the shield too for the rest of that ad, so the page is reachable.
    - Click → play / pause. Double-click → maximize / restore.
    - **Click to seek:** in normal playback, a click in the 24 px strip just above the site's progress bar jumps to that point. x maps onto the `progressBar` role's rect (YouTube: `.ytp-progress-bar`), else the video's width. Live streams seek within their seekable window. Pointer cursor + faint highlight over the strip. Pointer movement → synthetic `mousemove` on the video so the site still shows its controls. Clicks hand keyboard focus back to the page (`window.focus()`) so the site's own shortcuts keep working; keys pressed while the shield has focus are forwarded (Esc restores, others are re-dispatched to the page).
    - Transparent only because the overlay root switches to `color-scheme: normal` in shield mode: Chrome paints an opaque backdrop behind an iframe whose color scheme differs from its `<iframe>` element's.
- Play / pause prefers clicking the site's `playButton` role over calling `video.play()` directly (which can desync the site's player UI); falls back to the element if the click changed nothing after 400 ms (`src/lib/view/playback.ts`).
- **Keyboard shortcuts** (`chrome.commands`, rebind at `chrome://extensions/shortcuts`): play / pause `Alt+Shift+P`, maximize `Alt+Shift+M`, TV mode `Alt+Shift+F`, playlist next `Alt+Shift+N`; mute and playlist previous unbound (Chrome allows four suggested keys).
- **Mute command** toggles the tab mute. A mute made this way is the user's (`attributeMute`, tested): an ad ending won't unmute it, and unmuting mid-ad gives up ad ownership.

### Maximize + fullscreen

- "Maximize" the video above everything else with a letterbox behind it, stretched to the largest size its aspect ratio allows (`src/lib/view/maximize.ts`).
- **Top layer, not z-index.** z-index can't escape ancestor stacking contexts (`transform`, `filter`, `contain`, `will-change`) or `overflow: hidden`, and re-parenting a `<video>` pauses it and breaks site players.
    - `video.popover = "manual"; video.showPopover()`. The original `popover` attribute is put back on restore (a closed `[popover]` is `display: none`).
    - Injected stylesheet, in the element's own root so open shadow roots work: `position: fixed; inset: 0; 100% × 100%; object-fit: contain`, all `!important`, on `[data-wtv-maximized]:not(#wtv-x#wtv-y)` for ID-level specificity. `<html>` gets `overflow: hidden` while maximized.
    - `::backdrop { background: #000 }` is the letterbox.
    - The overlay host re-enters the top layer after a maximize so the shield / ad pictures stay on top.
- **Frames:** the background reads every frame's state with one `scripting.executeScript` (a `FrameCandidate` per frame id, exposed by the content script on its isolated-world global) and picks a frame (`src/lib/view/elect.ts`, pure + tested). An embedded frame maximizes its video, then asks its parent (postMessage with a background-issued token the parent verifies) to maximize the `<iframe>` element, recursively up to the top. A parent frame without Wtv running breaks the chain; the video then fills only its iframe.
- Maximize state lives in the pages, not the background, so it can't go stale. Restore is broadcast to all frames. Esc (page or shield focus) restores; so does the maximized element disappearing. Players that swap `<video>` elements are followed.
- **TV mode** = fullscreen window + maximized video, per tab, in `storage.session` with the window's previous state. `chrome.windows.update(windowId, { state: "fullscreen" })` needs no user gesture and **survives navigation**, unlike `requestFullscreen()`, which would exit on every playlist entry. New pages in a TV-mode tab re-maximize once a frame reports a viewable video (`VIEW_READY`). Esc, the shortcut, or the popup exit TV mode and restore the window; leaving fullscreen any other way also ends it.
- Popup: **Maximize / Restore**, **TV mode / Exit TV mode**, the bound shortcuts, **Shortcuts…**.

### Playlists

- Load a playlist of URLs (by pasting), play through, and jump to the next entry when a video finishes. Jump back to a previous entry.
- **Playlists page** (`playlists.html`, from the popup's **Playlists…**): list + **New**; editor with name, the playlist **text** (the source of truth, so comments and layout survive), live problems ("Line 4: …"), and an entries preview (title, host, start time, which ads program applies, ▶ play from here, ↗ open the page on its own: a plain tab, no playlist, for checking one entry). **Save** (also Cmd/Ctrl+S), **Copy text** (export to clipboard), **Delete**, **▶ Play** with "in TV mode", **Shuffle** and **Loop** options (Shuffle / Loop are ticked when the playlist has `[shuffle]` / `[loop]`, when it's opened and whenever those lines are added or removed). Edits happen in the text; structured edits (`withEntryTitle`, `appendEntry`) exist for code paths and re-render only the touched line. **Duplicate** copies any playlist ("<name> copy"; a built-in's copy keeps its name).
- **Built-in playlists** (`src/playlists/<id>.txt`, `src/lib/playlist/builtin.ts`, tested): the playlist format, first line `# name: <Name>`; id `builtin-<file stem>`. Strict: any problem the editor would report fails the build (checked in `wxt.config.ts`), like site configs. A file with no entries is a stub: skipped with a build note, so genres can be stubbed and ship once filled in. Listed under **Built in** in the playlists page sidebar, read-only (no Save / Delete / Remove gone entries; **Duplicate** makes an editable copy). Not in storage: they update with releases, and the popup's / context menu's **Add to playlist** only offer your own. The runner resolves them by id like stored ones.
    - **Placeholder cover:** an optional `src/playlists/<id>.svg` (≤ 50 kB; no scripts, event handlers, `<foreignObject>`, or references other than `#fragment`s: `checkSvg`, checked at build). It's the playlist's sidebar cover until any entry has a thumbnail, and the thumbnail of every entry that hasn't got one yet. Always shown with `<img>`.
- **Storage:** `wtv.playlists` in `chrome.storage.local`: `{ id, name, text, createdAt, updatedAt }` per playlist (`src/lib/playlist/store.ts`, tested). The name is metadata, not part of the text.
- **Adding pages** to any playlist, not just the running one: popup **Add this page** (playlist picker, remembers the last one, or "New playlist"), and the context menu **Add to Wtv playlist ▸** (each playlist + "New playlist"; a link adds its target, anywhere else adds the page with the tab title). The menu is rebuilt whenever playlists change.
- **Play** opens a new tab. First it requests host access for every entry's site (for `view=card` posts: the post's site if it has post selectors, plus the post adapter's fetch hosts if it needs any) in one prompt (Wtv only runs where it has access, and it needs to be there to see a video end). Declined sites still play, but need **Next** by hand. Shared by the playlists page and the explorer (`src/lib/playlist/play.ts`). Starting records when the playlist last played (`wtv.playlistPlays`, local; not in backups).
- **Runner** (`src/lib/playlist/runner.ts`) lives in the background; per-tab state in `storage.session`; all operations go through one queue. The playlist is snapshotted at start (edits apply next time).
    - Moving to an entry: the current page blacks out (so end screens / autoplay never show), `gen` is bumped, the tab navigates.
    - Each frame says hello at start; the runner answers with the entry (title, `t=`, end time, ads program) if the page is that entry (`sameEntryUrl`: ignores www./m., extra query params, hash; also compared with the URL the tab actually landed on, so redirects count).
- **Blackout** (top frame, over the whole tab) until anything plays: the **ad pictures** (the entry's `[ads]` program, else the site's images; the same slideshow as during ads, from the overlay's image library), not the title or the host. Notices keep their text on black (`notice` on `wtv/playlist/apply`: "Unavailable: <title>"). The Start / Next prompt and the status line sit over the pictures (the status on a dark pill). The card page shows one ad picture the same way while its post loads. **One picture through a transition** (`src/lib/images/loading-picture.ts`): the page being left, the new page (before and after it knows its entry's `[ads]`) and the card page are separate pages that would each pick at random, flashing one picture and then another. The picture on screen is remembered in the extension origin's localStorage, shared by every overlay iframe and the card page; a loading screen within 30 s of the last one starts with it, at once (no fade from black), and the slideshow goes on from there. A page's loading screen also keeps its slideshow when the entry's own `[ads]` arrive. After a while (the entry played) the next transition picks afresh.
    - **Wtv starts playback itself** (it's a TV; many sites never autoplay): once the primary video has data (`loadeddata` / `canplay`), the site gets 2 s to start it, then Wtv calls `play()` up to 3 times (immediately, +1.5 s, +3 s). No ads in progress, and only on the entry page (not the blackout shown while leaving a page). Not on a site marked **Videos start by themselves** (`quirks.startsItself`): there Wtv never calls `play()`, not after a refusal or the 15 s fallback either; it waits, and Start / Next show as usual.
    - Each try pulses the status line ("Starting the video… (1 of 3)"), or the Start button once it's showing; the result is shown ("Chrome blocked autoplay" / "No video on the page yet" / "The video didn't start") and logged to the console.
    - **Start / Next** appear when Chrome refuses autoplay, when Wtv's own tries fail, or after a 15 s fallback with no video at all. Refusals are detected exactly: the MAIN-world hook observes every page `play()` promise (a side branch, so the page sees exactly what it would without us) and reports `NotAllowedError` (`EVT_BLOCKED`); embedded frames forward it via the runner. A click on Start is a user gesture that reaches the page, so `play()` is allowed then. Embedded players can't be retried from the top frame: the status says to click Start, then the player.
    - To skip the prompt on a dedicated TV machine: launch Chrome with `--autoplay-policy=no-user-gesture-required`.
- **End detection:** `ended`, or playback within 0.25 s of the end → next entry. An entry with an **end time** (`end=` / `dur=`) pauses there and moves on (`endState` in `seek.ts`, pure + tested). It's measured in the media's own time, so ads don't count, and only once the start-time seek has settled. An end time without a start time starts from 0, so a site resuming where the viewer left off can't skip past it. Near-end is then measured to the end time. A frame also reports **near-end** (last 20 s, media ≥ 30 s). Navigating off the entry *after* near-end counts as the end (YouTube autoplay / end screens can pre-empt `ended`); navigating off *before* it is the user doing something else, so the runner **detaches** and the popup offers **Resume** instead of hijacking the tab. Everything is ignored while an ad is playing (YouTube ads play in the same `<video>`), and `gen` stops late events from a page being left from skipping twice.
- **Ads program:** the entry's `[ads]` block (else the playlist default, else site pictures) drives the ad overlay on that page.
- **View:** an entry's `view=pictures` (or the playlist's `[view pictures]`) covers the media with its `[show]` program the whole time (see Overlay iframe → Pictures outside ads). Runner state from before views existed reads as `video`.
- **Order** (`src/lib/playlist/order.ts`, pure + tested): the runner keeps a play `order` (entry indexes) and a position in it.
    - In order, playing from an entry starts there. **Shuffle** shuffles once at start (from an entry's ▶, that entry first; from **▶ Play**, any) and keeps the order in the runner's state, so **Previous** retraces it.
    - **Loop:** past the last entry a new lap starts from the top, with the usual blackout and title. Shuffled, each lap is reshuffled and the entry that just played never comes first (unless it's the only one). Previous doesn't cross back into the last lap.
    - **Reshuffle** (popup): the current entry keeps playing; everything else comes after it in a new order.
    - Runner state from before shuffle existed plays in order, without looping.
- **Popup:** playlist name, `3 / 10` (position in the play order), "shuffled" / "looping, lap 2", and the entry title; **⏮ Previous**, **Next ⏭** / **Finish** (always Next while looping), **Reshuffle** when shuffled, **Stop**; **Resume** when detached. Shortcuts: next `Alt+Shift+N`, previous unbound. The popup is a fixed 380 px wide; the status line and the entry's title / URL are one line each, cut short with … (full text on hover), so a long URL never widens it.
- **Arrows over the entry** (`src/lib/playlist/nav-arrows.ts`): previous / next tabs at the middle of the left and right edges, in the top layer (above the page, a maximized video and our overlay), in the entry's tab (top frame, from when the runner says hello until `release`) and on the card page (not when it's framed in the post's page: the page has them). They wake dimly for 2.5 s when the pointer moves (over the page, or over the overlay iframe: its `pointer` / `activity` events) and show fully under the pointer; asleep they're invisible but still answer to hovering, so one shows before it can be clicked. Previous from the second entry on; Next on the last one finishes (or laps), like the popup. Hidden while the selector picker runs.
- `t=` is parsed and stored with each entry; the page seeks to it (see Hash params + seeking).

#### Playlist format

- Grammar is in `src/lib/playlist/format.ts`; parser + serializer with **round-trip tests** (parse → export reproduces the input byte for byte, including comments, ordering, odd spacing and junk lines; CRLF kept).
- Format:

    ```
    [ads]
        20: Take a moment to breathe
        [img cats]

    https://www.youtube.com/watch?v=abc | Some Title | t=1:37
    [ads]
        20: Take a moment to breathe
        10: Dismiss your worries
        5: Relax

    https://vimeo.com/123 | Another Title
    [ads]
        [img]
        [img cats 10]
    ```

    Pictures as the show (music, radio, podcasts):

    ```
    [view pictures]
    [show]
        [img beach]

    https://radio.example/live | Radio
    https://www.youtube.com/watch?v=xyz | A video after all | view=video
    ```

    Clips, shuffled, round and round:

    ```
    [shuffle]
    https://www.youtube.com/watch?v=abc | Chorus | t=1:00 | end=2:30
    https://www.youtube.com/watch?v=def | Intro | t=30 | dur=45s
    [loop]
    ```

    Pages and posts (see Pages and posts as shows):

    ```
    [speed 200 wpm]
    https://example.com/a-story | view=read
    https://example.com/a-page | view=scroll | speed=40
    https://x.com/someone/status/123 | view=card | dur=20s
    ```

- One construct per line: URL entry, `[ads]`, `[show]`, `[view …]`, `[speed …]`, `[shuffle]`, `[loop]`, quote, `[img …]`, comment (`#` or `//`), blank. Anything else is kept as an invalid line and reported, never dropped.
- `[ads]` before the first URL is the **playlist-wide default**. An `[ads]` block after a URL (and before the next URL) **overrides** it for that entry. Quote / img lines outside a block are reported and ignored.
- `N: text` — quote displayed for N seconds (only the first `N:` is a prefix; colons later in the text are fine).
- `[img]` — images for the current site (see `[img ...]` resolution under Overlay iframe).
- `[img <keyword>]` — images matching that keyword (may be several words), using filename durations or 5s default. `[img <keyword> N]` forces N seconds.
- `url | title | t=…` — optional title and options. Fields shaped `key=value` are options (unknown keys are kept and reported); the first other field is the title. Titles are written so they can't read back as options.
- `[show]` blocks scope like `[ads]` and pick the pictures for `view=pictures` entries: the entry's own `[show]`, else the playlist's, else the entry's ads program, else site pictures.
- `end=` stops the entry at that time; `dur=` plays it that long from its start (`t=`, else 0). Same formats as `t=`. Both given: `end=` wins, reported. An end at or before the start, or `dur=0`, is reported and ignored.
- `[shuffle]` before the first URL and `[loop]` after the last are defaults for the Play options; anywhere else they're reported and ignored. `[loop]` doesn't end the last entry's `[ads]` / `[show]` block.
- `[view pictures]` before the first URL makes every entry pictures; `view=…` on an entry overrides it. Views: `video`, `pictures`, `read`, `scroll`, `card`. A `[view …]` after the first URL, or an unknown view, is reported and ignored.
- `speed=` on a `read` entry is words per minute, on a `scroll` entry pixels a second (a unit, `wpm` / `px/s`, is optional but must match). `[speed 200 wpm]` / `[speed 40 px/s]` before the first URL set the playlist's defaults (the unit is required). Out of range (30–1000 wpm, 1–2000 px/s), on another view, or after the first URL: reported and ignored.
- On `read` / `scroll` / `card` entries, `dur=` (or `end=`) is how long they show and `t=` is reported and ignored. Whether a `card` entry can play depends on the user's post selectors, so the format doesn't check it; the playlists page says per entry where its post comes from ("read from its page with your post selectors" / "from Bluesky's public data"), or that the site needs post selectors.
- Indentation is **not** significant. An `[ads]` or `[show]` block's scope ends at the next URL line. Indentation is cosmetic and preserved on export.

### Pages and posts as shows

Playlist entries that are read, not watched (`src/lib/page-show/`, `src/lib/posts/`).

- **`view=read`**: the entry's page loads under the blackout (the `#wtv:` hash's `v=read` tells the content script there's no video to wait for: no Start prompt, no autoplay attempts, media events ignored in every frame). Once it has loaded (the `load` event, at most 12 s, then 1.2 s more), the top frame pauses the media on it and hands a snapshot (`outerHTML`, ≤ 8 MB) to the overlay (`read` command). The overlay page parses it with DOMParser (runs nothing), finds the article with **Readability** (`@mozilla/readability` 0.6.0, Firefox Reader View's library; Apache-2.0, no dependencies) and rebuilds it from text and picture URLs only: site, title, byline, headings, paragraphs, quotes, list items, pictures (`src/entrypoints/overlay/reader.ts`). Large type, a centered column, scrolled so a reading line moves down the article at the entry's pace (default 180 wpm), held 35% down the screen; a 4 s lead-in on the title and a 5 s dwell at the end (`readPlan`, `readScrollTop`, tested). `dur=` fits the whole thing into that time. Click or Space pauses. Less than 500 characters of article: the overlay says so and the page is scrolled instead.
- **`view=scroll`**: the page itself, scrolled at the entry's pace (default 30 px/s; the document, or the page's biggest scrolling box), then 5 s at the bottom; a page that grows as it scrolls keeps going, up to 15 min. `dur=` ends it at that time instead. The viewer scrolling holds it for 5 s. Nothing covers the page (no click shield or pause pictures). (`src/lib/page-show/scroller.ts`.)
- Both report `playing`, then the page's metadata with the show's planned length (so the playlist length counts it), then `ended`. A stand-alone `#wtv:v=read` / `v=scroll` link works too: at the end, the page is left as it is.
- **`view=card`** plays on the extension's **card page** (`card.html?gen=N`). Where the post comes from is decided as the entry starts (`src/lib/posts/source.ts`, pure + tested):
  - **From its page** (`page`), when the site has post selectors (built in, or picked in Fix selectors → Posts) and Wtv has access to it. Picking them is how you say "use my sign-in": the tab goes to the post's own page first (`#wtv:v=card`, behind the blackout), where the content script reads the post with the selectors (`src/lib/posts/page.ts`: text with its line breaks, `<time datetime>`, pictures ≥ 64 px from `img` / video posters, https only), trying for 15 s since apps render late, then once more 0.8 s later for pictures still loading. A visible `unavailable` role means gone (also checked again just before the post is taken: a removed post keeps its title, and the banner can come in after it). It sends the post, or why not, to the runner (`wtv/playlist/page-post`), which goes on to the card page. The page is your own session, so posts that need signing in (Reddit, Bluesky authors who hide from signed-out viewers, forums) work. The page's address may change while it's read (SPAs tidy URLs): same host doesn't count as leaving.
  - **From the API** (`api`): straight to the card page, the post fetched by the background through the site's adapter, anonymously. Also the fallback when reading the page failed and the site has an adapter.
  - Neither: the card page says why for 8 s, then the playlist moves on.
  - **With an embedded player** (the site's `postEmbed` matches on the post's page, `src/lib/posts/embed.ts`): the post can't go to the card page without its player (moving an `<iframe>` reloads it, and many players only run framed by their own site). So the card comes to the page: the runner keeps the tab there (`inPage` on `wtv/playlist/page-post`), the content script frames the card page over the whole tab (`card.html?gen=N&embed=1`, web-accessible), and then lifts the player into the **top layer** above it (`view/maximize.ts`, placed in a box with `placeMaximized`; the top layer, not z-index, because z-index can't escape the site's stacking contexts and overflow clipping). The card page lays the post out beside an empty slot and the player sits over the slot: landscape, player left (60%) and post right; portrait, player on top (`embedLayout`, pure + tested; both sides work it out from the viewport size, so they agree without messages). The lifted element is the `<iframe>` itself if the picked box holds one (its size is the site's, in pixels), else the picked element; a `<video>` in it is played (controls turned on if autoplay is refused); an iframe's player may want a click. No pictures then, and the card shows for `dur=`, else at least a minute (`embedCardDurationS`: the player's length isn't known). If the page re-renders the player away, it's looked for and lifted again every second. A clear **shield** lies over the lifted player (all but its 56 px control strip, for sound and full screen), like the overlay's over a video: a click plays / pauses it instead of reaching the site (which would open its own viewer, or the post). A `<video>` in the page is played / paused directly, with ⏸ on the shield while paused; a player in an iframe through the background (`play-pause` to the frame playing). The card and the player pause together, whichever is clicked (`wtv/card/paused`, both ways by postMessage); the card's ⏸ sits over the post (the middle of the tab is under the player). The shield enters the top layer after the player and the playlist's arrows after the shield (`notifyRestacked`); the pointer over the card page wakes them (`wtv/card/pointer`). Same-host address changes don't count as leaving while it shows. When the playlist lets go of the tab (stopped, finished, the user left: `release`), it's taken down.
- The card page says hello like an entry page, asks the background for the post (`wtv/playlist/post`), and shows author, handle (or community), title, text, up to 4 pictures and date on a full-screen card for `dur=`, else 6 s + 0.4 s a word + 3 s a picture (8–45 s, `cardDurationS`). **Pictures** (`src/lib/posts/card-layout.ts`, pure + tested): the card waits up to 3 s for them to load to learn their shapes (broken ones dropped; late ones count as square until they arrive, then the card is laid out again). Then whichever arrangement shows them biggest: **stack** (text on top, pictures below across the card) or **side** (pictures down the left at full height, 55%, the text beside them; only on a card wider than tall), with the pictures in one row, one per row, or two per row (3–4). Pictures in a row share its height and get widths by their shape, so the block has a known shape and fills its area without letterboxing (container query units size it). The pictures get 55% of the card's height or width beside text, 70% beside a caption (title + text up to 120 characters), 85% with none (`pictureShare`; side columns follow it via `--pic-share`). Long text gives way, down to 40% for the pictures. **Nothing overflows the card** (`fitText`): the text starts at a size by its length, steps down a size at a time until it fits its room, and if it still doesn't at the smallest it scrolls by itself over the card's time (held at the top for the first 12%, at the end for the last 12%), fading out at the bottom while there's more; the wheel scrolls it too (anywhere on the card), and then it's left where the viewer puts it. Refitted on resize and when late pictures change the layout. Click or Space pauses. A post the site says is gone (each adapter decides from the endpoint's answer) is reported `gone` (marked in the library, skipped after 3 s, with the reason under "Unavailable"); any other failure is shown for 8 s, then the playlist moves on.
- **Post adapters** (`src/lib/posts/adapters.ts`, pure + tested, no imports so the health check can use it): post URL → canonical URL → endpoint → `{ site, author, handle, title, text, time, url, images }`, or gone / an error (`read(status, body)`). HTML from the sites is read with regular expressions (the background has no DOM); only text and picture URLs come out. Fetched anonymously by the background (`src/lib/posts/fetch.ts`, `credentials: 'omit'`). Each adapter lists its **fetch hosts** (need host access, asked for at Play instead of the post's own page) and its **API hosts** (serve only the endpoint: never get content scripts, like thumbnail hosts).
  - **X / Twitter**: x.com / twitter.com / mobile, `/<user>/status/<id>` → `publish.x.com/oembed` (public, no sign-in; `publish.twitter.com` redirects there). Picture links dropped. 404 / 410 / 403 → gone. Fetch + API host `publish.x.com`.
  - **Reddit**: www / old / new / m / np.reddit.com `/r/<sub>/comments/<id>/…` (also `/comments/<id>`, `/user/<name>/comments/<id>`) and `redd.it/<id>` → the post's Atom feed `www.reddit.com/…/comments/<id>/.rss?limit=1` (Reddit's `.json` asks for a login; the feed doesn't). The first entry is the post: title, `u/author`, `r/sub`, self text (between `SC_OFF` / `SC_ON`), one picture (the `[link]` when it's an image, else the preview, else the thumbnail; Reddit's image hosts only). 404 / 410, or a `[deleted]` / `[removed]` body → gone; 403 / 429 → an error (private community, rate limit). Share links (`/r/<sub>/s/<code>`) aren't posts: use the post's own address. Fetch host `www.reddit.com`, which keeps its content scripts (people watch Reddit, too).
  - **Bluesky**: bsky.app `/profile/<handle or DID>/post/<rkey>` → `public.api.bsky.app/xrpc/app.bsky.feed.getPostThread` (`depth=0`): text, display name, handle, date, pictures (images, a video's poster, a link card's picture; none when the post is labelled adult). The API allows cross-origin requests: no fetch hosts, nothing asked at Play. `400 NotFound`, `notFoundPost` / `blockedPost` → gone. An author labelled `!no-unauthenticated` (seen only by signed-in people; about one post in seven on the Discover feed) isn't shown from the anonymous API, though it answers: an error that says to pick Bluesky's post selectors, so the post is read from bsky.app, signed in.
  - More sites (Mastodon, …) are one adapter each.
- **`view=video` on a post with an embedded player**: when the entry's page has no player Wtv can see (the video is in an iframe from a site Wtv doesn't run on) but the site's `postEmbed` matches, the top frame waits for the page to load and 4 s more; if nothing has played, it lifts the embed to fill the tab, lifts the blackout and reports `playing`. Nothing can report its end, so it plays for `dur=` (`end=` minus `t=`), else a minute, then reports `ended`; that time stops while it's paused on its shield (see above: the same shield, without a card). If Wtv does run in the embed after all and its video starts, that frame reports for itself and the timer is dropped.
- The playlists page describes each ("read as an article, 200 wpm", "the page, scrolled 30 px/s", "a post, on a title card"; "for 1:00" instead of "until"). `npm run health -- --playlists` checks pages by HTTP status and posts through their adapter, as ✅ / ❌ gone / ❔.

### Media library

What Wtv learns about each URL as it plays in a playlist, for the playlist features that need it before playing (`src/lib/media-library/`).

- **Store:** IndexedDB `wtv-media` in the extension origin (beside the image library): `records` (title, creator, duration, live, thumbnail URL, status `ok` / `gone`, last played) and `thumbs` (cached thumbnail blobs). Written by the background, read by the playlists page and the explorer; the background broadcasts `wtv/library/changed` after each write.
- **Key:** the entry URL normalized like `sameEntryUrl` (no www. / m., no trailing slash, no hash), query parameters sorted, minus `t`, `start`, `si`, `pp`, `feature`, `utm_*` (`libraryKey`, pure + tested).
- **What's recorded:** `playing` → status ok + last played. Once the primary has played 3 s with no ad, each frame sends `PL_INFO`: the media's own `duration` (or live), and from the top frame the metadata extractor's title, creator, thumbnail and duration (the media's own duration wins). A top frame with no player (an embed page) sends the page's metadata after 8 s. The runner files reports under its own entry URL for the reporting tab's current `gen`, never a URL the page names. Missing fields never erase known ones (`mergeRecord`).
- **Thumbnails:** `og:image` / JSON-LD `thumbnailUrl`, fetched by the background the first time the entry plays (or when its URL changes) and cached as a blob (images only, ≤ 2 MB). Only with host access to the image's host: **▶ Play** asks for the entry sites' `thumbnailHosts` in the same prompt as the sites. Turned down once, a thumbnail host isn't asked for again (remembered in the extension origin's localStorage, so the playlists page and the explorer share it). Without a cached blob the page shows the thumbnail URL directly.
- **Gone videos:** every frame of an entry polls the site's `unavailable` role once a second until the entry has really played (3 s ad-free) or 60 s pass. Plus **built-in gone markers** (`src/lib/sites/gone-markers.ts`, tested) for sites with no bundled config (a bundled one would add an install-time host permission): checked after the site's own `unavailable` matchers, here and when a post is read from its page. Reddit: `[slot="post-removed-banner"]` (post deleted by its author, or removed). YouTube's private / removed videos hide the two-column player (`#columns[hidden]`, where the error screen is) and show the message in `#single-column-container` instead, so the bundled role also matches `ytd-watch-flexy[player-unavailable] … ytd-background-promo-renderer`. When it shows, the frame reports `gone`; the runner marks the record gone, blacks out with "Unavailable: <title>" for 3 s, and moves on. A gone entry that plays later is marked ok again.
- **Playlists page:** each entry shows its thumbnail, its length (`1:30`, or `1:30 of 4:13` for part of a video, from `t=` / `end=` / `dur=` and the library), and the library's title when the entry has none. Gone entries are struck through and say "Unavailable"; **Remove gone entries (n)** deletes them from the text with their own `[ads]` / `[show]` blocks (`withoutEntries`, tested), for the user to save. Above the list: "about 2 h 10 min, 3 entries unknown" (`entryLengthS`, `describeLength`, tested).
- **Playlist covers** (`src/lib/ui/cover.ts`, shared): 16:9; with no thumbnails, a built-in's placeholder SVG, else the name on a color block (hue from the playlist id). Hovering (or focusing) plays all the thumbnails full size, 1.2 s each, most recent first.
    - Playlists page sidebar: only entries with a thumbnail count. Four or more: a quad of the four most recently played (each shrunk into its quarter); one to three: the most recent one (`coverRecords`, tested).
    - Explorer: every video counts (`coverSlots`, tested): thumbnails first, most recent first, then the rest in playlist order as their title on a color block (a built-in's SVG instead, until they've played). The quad moves on to the next four every 6 s (fewer than four: the next one), fading in; not while hovered, hidden or scrolled into a hidden view, and not at all with reduced motion.

### Playlist explorer (side panel)

The side panel's **Playlists** view, for browsing while watching (`src/entrypoints/sidepanel/explorer.ts`). Opened from the popup's **Explore…** (Playlist row), or the side panel's own tab; the panel reopens on the last view used.

- **Cards:** built-in and yours together, most recently played first (`wtv.playlistPlays`), then never-played ones: yours, then built-ins, each by name (`explorerOrder`, tested). Each card: the cover (see Media library → Playlist covers), name, "Built in", entry count, length when known ("about 40 min", "+" while some entries are unknown), "played 2 h ago".
- **Search** (one box): by playlist name and entry title (the entry's own, else the library's). Case- and accent-insensitive; every word must match, in the name or split between the name and one entry's title. A name match shows the whole playlist; otherwise the card lists just the matching entries, open (`matchPlaylist`, tested).
- **Actions:** **▶ Play**, **TV mode**, **Shuffle** (the playlist's own `[shuffle]` / `[loop]` apply otherwise), **Open** (the playlists page editor, in a new tab), and **Entries**: a collapsible list with thumbnail, title, length, host, and ▶ play from here. Read-only: editing is on the playlists page.
- **Playing:** the card of a playlist that's running is outlined, with "Now playing · 3 / 12", the entry title, **Next ⏭** / **Finish**, **Stop** (**Resume** when detached), and **Show tab** when it plays in a tab other than this window's active one. Its entry is highlighted in the list (if the playlist still has it at that position: the run plays the playlist as it was at start). From `wtv/playlist/runs` (every run, any tab), refreshed when the runner's session state changes.
- Live: refreshes when playlists change, a playlist starts, the runner moves, or the media library learns something (`wtv/library/changed`). Nothing is redrawn while the other view is showing.

### Hash params + seeking

- Jump to a specific video location with a timestamp hash (`src/lib/playlist/hash.ts`, tested).
- **Namespaced** to avoid colliding with sites' own hash routing / `t` params: `#wtv:t=97&e=187&d=Title` (`e`: end time in seconds, from `end=` or `dur=`).
- **Timestamp formats:** `200`, `200s`, `1:37`, `1:02:03`, `1h2m3s` (`parseTimestamp`, tested). Written back as seconds.
- Title uses `encodeURIComponent`, not underscore escaping (titles with real underscores would be lost).
- The background playlist state is the source of truth. The hash is the synchronous fast path that lets the `document_start` content script show the blackout before first paint:
    - The runner navigates to `entry URL + #wtv:t=…&e=…&d=…`. Entries with a hash of their own (hash-routed sites) are left alone and fall back to the hello round trip.
    - The top frame reads it at `document_start`, blacks out immediately (the overlay host is painted black until its iframe has loaded), then removes it with `history.replaceState`, before the page's own scripts run. One-shot: reloads and copied links are the plain page.
    - A hash arriving later (`hashchange`) starts over. That covers the runner moving to an entry whose URL only differs by hash from the current page (same video twice, Resume), which is a same-document navigation with no reload.
    - A `#wtv:` link outside any playlist works on its own: blackout (no Next), start, seek, and pause at `e=` (once: playing on is fine).
- **Seek only after `loadedmetadata` and after any pre-roll ad clears** (`src/lib/playlist/seek.ts`, pure + tested). Never while an ad is showing.
    - On `quirks.adsInMainVideo` sites (YouTube plays ads in the same `<video>`, and ad detection can lag the ad's first frames), also only after 750 ms of ad-free playback, so a pre-roll is never the thing seeked.
    - Elsewhere it seeks as soon as metadata arrives, before the first frame: no visible jump.
    - A start of 0 (an entry with an end time and no `t=`) still seeks if the player resumed elsewhere.
    - Skipped for live streams, start times past the end, or when the player is already there (the site honoured its own parameter). Once per entry; every frame seeks its own primary (embedded players get the start time from the runner's hello).

### Site health checks

- Automated daily check of each site for changes / breaks by playing a video from each.
- **Runs outside the extension** (dev only, `scripts/health/`, see its README): `npm run health`. Playwright 1.64.1 with its bundled Chromium (Google Chrome dropped `--load-extension` around v137).
    - Headful, on a home connection (headless / datacenter IPs trigger bot walls). Persistent profile in `.health/profile` (gitignored); `npm run health:setup` opens every target to accept consent / sign in once.
    - Loads the **built extension** and asks it, via its service worker, for the same media status (`wtv/status`) and role report (`wtv/pick/roles`) the popup and side panel use. It exercises the real selector engine and media detection rather than a copy.
    - For each site (`src/sites/*.json`; URLs in `scripts/health/targets.json`, a test checks every bundled site has one): load the URL, wait for ad-free playback (pre-roll ads extend the wait), then judge every configured role (`scripts/health/protocol.ts`, pure + tested):
        - ✅ pass, ⚠️ fallback (selector #1 broke, a fallback matched: an early warning), ❌ fail. Present-but-hidden controls pass.
        - `video` passes only if its selectors picked the playing video.
        - Ads aren't guaranteed, so `adIndicator` / `skip` are 👁 seen / · not seen, never failures. Same for roles that only show in rare moments: `continuePrompt`, `unavailable`.
    - `--playlists`: also opens every built-in playlist entry (no playback: videos are paused) and marks it gone when the `unavailable` role matches or YouTube's `ytInitialPlayerResponse.playabilityStatus` is `ERROR` / `UNPLAYABLE` / `LOGIN_REQUIRED` (age / content checks: restricted). A "Built-in playlists" section in the report lists them per playlist; they don't affect the exit code.
    - Results in `.health/results/<timestamp>/` (`report.json`, `summary.md`) + `.health/results/latest.md`. On failure: the page HTML + screenshot, so selectors can be fixed offline. Exit code 1 on any failure.
    - Daily: a macOS LaunchAgent (sample plist in the README), since a headful browser needs the logged-in session.
- **In-extension** (`src/lib/health/`, local only, no telemetry):
    - Once per page, after the primary video has played 10 s with no ad, each frame checks the site's **player roles** (`video`, `playButton`, `progressBar`): does a selector find anything at all (controls fade while playing), and did the video role pick the playing video. Metadata roles aren't judged (they vary by page type, and nothing uses them yet); ad roles can't be (no ad isn't evidence).
    - Only on what looks like the show (long, not looping, audible or config-matched), not hover previews.
    - The background keeps per-site streaks in `wtv.siteHealth`. A role failing on **2 pages in a row** with no success between is "broken": orange **!** badge on that tab and a warning in the popup's Media row pointing at **Fix selectors…**. Streaks reset when that site's overrides change, and on every install / update.
- **Badge** (`src/lib/badge.ts`, one owner per tab): **AD** (red) wins over **!** (orange); tooltip says which.

### Misc

- Toolbar badge state: on / ad / broken. (`AD` and `!` done; an "on" state isn't, since a badge on every page would be noise. Revisit with an icon variant instead.)
- Per-site enable toggle. (Done as the popup's **Enable / Disable on this site**; bundled sites use Chrome's site-access menu.)
- **Backup / restore** (`src/lib/backup.ts`, pure + tested; playlists page sidebar). **Export everything** downloads `wtv-backup-<date>.json`: `{ format: "wtv-backup", version: 1, exportedAt, playlists, overrides, settings }`. Not the image library (re-imported from its folder) or the media library (rebuilt by playing). **Import…** validates everything (malformed playlists, built-in ids, duplicates, bad selectors are dropped and listed), then confirms a merge before writing: playlists by id (added / replaced if different / unchanged), selector overrides per site and role (the backup's win), settings replaced. Other versions of the format are refused.
- Unit tests (Vitest) for the playlist parser, filename durations, timestamp parsing, and override merging.

---

## Open

Not done, or done but not verified (carried over from round 2's `todo.md`).

- [ ] **Run the health check once for real.** `npm run health` (and `-- --playlists`) has only been type-checked and unit-tested. Run it, check `.health/results/latest.md`, fix what the first real run turns up.
- [ ] **Publishing over the previous extension:** the checklist under Architecture Decisions. Version `2.0.0` must beat the store listing; diff permission warnings against the published manifest. The storage wipe and the `host_permissions` scoping are built; tick them once checked against the published version.
- **Open bugs:**
    - [ ] Ads stopped reappearing after several video clicks on YouTube (deferred in step 6). Reproduce with the dev timeline and 📸 snapshots.
    - [ ] Ad pictures blip off for a split second when an ad starts. Two fixes are in (end the ad only once the show is playing; cover the player that holds the video) plus a blip detector that logs a timeline. Close once it hasn't recurred for a while.
    - [ ] YouTube advertiser surveys: Skip ignores untrusted clicks, and seeking can't help (no video plays). The skip code rotates four click strategies and records which one worked; if none works, the survey stays muted and covered for its ~30 s. Close after a few surveys either way.
- **Deferred on purpose** (not scheduled):
    - An "on" toolbar state, as an icon variant rather than a badge.
    - `use_dynamic_url` for the overlay page (stops sites probing for Wtv; needs testing).
    - Generic-site ad signals (Google IMA SDK iframes, mid-playback `src` / duration swaps).
    - In a playlist, a "Continue watching?" prompt that can't be dismissed counting as the entry stalling (Start / Next, like a blocked autoplay).
    - More post adapters (Mastodon public statuses, …), one per site.

## Later

- Publish an authoritative playlist as a "tv station".
- Lightbox posts and comments, and auto-scroll long-form content, as playlist entries.
- Selector import system, if popularity grows.
