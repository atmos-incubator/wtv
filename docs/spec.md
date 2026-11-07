# Wtv spec

Round 1 of development (steps 0–9): the build order as it ran, the architecture decisions, and the
feature specs, kept current as features change. Round 2's plan is in [`todo.md`](../todo.md).

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

- One JSON file per site in `src/sites/<id>.json` (file name = `id`): `schemaVersion`, `id`, `name`, `domains`, `roles`, optional `quirks` (`controlBarInset` for the click shield; `adsInMainVideo` when ads play in the main `<video>`, as on YouTube). The folder holds only data, so the dev repo writer can be pointed at it.
- Validated at build time (`wxt.config.ts` fails the build) and in tests. Bundled `host_permissions` are generated from `domains`.
- **Roles:** `video`, `player` (optional: the player's outer box; ad pictures cover it, and it's searched for unlisted Skip buttons), `adIndicator`, `skip`, `continuePrompt` (optional, see Ad detection + muting), `playButton` (optional), `progressBar` (optional, click-to-seek geometry), `title`, `description`, `keywords`, `creator`.
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
- **Settings:** `muteAds` and `autoSkip` (both on by default), toggled in the popup.

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

### Selector picker (side panel)

- `chrome.sidePanel` UI to pick DOM nodes and generate unique CSS selectors for each role. Opened from the popup's **Fix selectors…**. Ships in the store build (users fix their own session); only the repo writer is dev-only.
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
- **In-page picker:** hover highlight with tag + size, click to select (page clicks swallowed), **↑ / ↓** walk to parent and back, **P** play/pause the primary (freeze an ad), **Esc** cancel. The keys work whether the page or the side panel has focus (the panel forwards them). The ad overlay steps aside while picking. Runs in every frame; the frame you click in answers.
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
    - Covering the video is the ad click shield. A ✕ on the overlay hides it for the rest of the current ad; a **Show pictures** pill in the player's top-right corner (and a popup button) brings it back.
    - Commands: `ad` (program + host), `blackout` (title, for playlists), `shield` (transparent click shield, see Click to play / pause), `hide`.
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
- **Playlists page** (`playlists.html`, from the popup's **Playlists…**): list + **New**; editor with name, the playlist **text** (the source of truth, so comments and layout survive), live problems ("Line 4: …"), and an entries preview (title, host, start time, which ads program applies, ▶ play from here). **Save** (also Cmd/Ctrl+S), **Copy text** (export to clipboard), **Delete**, **▶ Play** with an "in TV mode" option. Edits happen in the text; structured edits (`withEntryTitle`, `appendEntry`) exist for code paths and re-render only the touched line.
- **Storage:** `wtv.playlists` in `chrome.storage.local`: `{ id, name, text, createdAt, updatedAt }` per playlist (`src/lib/playlist/store.ts`, tested). The name is metadata, not part of the text.
- **Adding pages** to any playlist, not just the running one: popup **Add this page** (playlist picker, remembers the last one, or "New playlist"), and the context menu **Add to Wtv playlist ▸** (each playlist + "New playlist"; a link adds its target, anywhere else adds the page with the tab title). The menu is rebuilt whenever playlists change.
- **Play** opens a new tab. First it requests host access for every entry's site in one prompt (Wtv only runs where it has access, and it needs to be there to see a video end). Declined sites still play, but need **Next** by hand.
- **Runner** (`src/lib/playlist/runner.ts`) lives in the background; per-tab state in `storage.session`; all operations go through one queue. The playlist is snapshotted at start (edits apply next time).
    - Moving to an entry: the current page blacks out with the next title (so end screens / autoplay never show), `gen` is bumped, the tab navigates.
    - Each frame says hello at start; the runner answers with the entry (title, `t=`, ads program) if the page is that entry (`sameEntryUrl`: ignores www./m., extra query params, hash; also compared with the URL the tab actually landed on, so redirects count).
- **Blackout** (top frame, over the whole tab): the entry title (else the page title / host) until anything plays.
    - **Wtv starts playback itself** (it's a TV; many sites never autoplay): once the primary video has data (`loadeddata` / `canplay`), the site gets 2 s to start it, then Wtv calls `play()` up to 3 times (immediately, +1.5 s, +3 s). No ads in progress, and only on the entry page (not the blackout shown while leaving a page).
    - Each try pulses the status line ("Starting the video… (1 of 3)"), or the Start button once it's showing; the result is shown ("Chrome blocked autoplay" / "No video on the page yet" / "The video didn't start") and logged to the console.
    - **Start / Next** appear when Chrome refuses autoplay, when Wtv's own tries fail, or after a 15 s fallback with no video at all. Refusals are detected exactly: the MAIN-world hook observes every page `play()` promise (a side branch, so the page sees exactly what it would without us) and reports `NotAllowedError` (`EVT_BLOCKED`); embedded frames forward it via the runner. A click on Start is a user gesture that reaches the page, so `play()` is allowed then. Embedded players can't be retried from the top frame: the status says to click Start, then the player.
    - To skip the prompt on a dedicated TV machine: launch Chrome with `--autoplay-policy=no-user-gesture-required`.
- **End detection:** `ended`, or playback within 0.25 s of the end → next entry. A frame also reports **near-end** (last 20 s, media ≥ 30 s). Navigating off the entry *after* near-end counts as the end (YouTube autoplay / end screens can pre-empt `ended`); navigating off *before* it is the user doing something else, so the runner **detaches** and the popup offers **Resume** instead of hijacking the tab. Everything is ignored while an ad is playing (YouTube ads play in the same `<video>`), and `gen` stops late events from a page being left from skipping twice.
- **Ads program:** the entry's `[ads]` block (else the playlist default, else site pictures) drives the ad overlay on that page.
- **Popup:** playlist name, `3 / 10` and the entry title, **⏮ Previous**, **Next ⏭** / **Finish**, **Stop**; **Resume** when detached. Shortcuts: next `Alt+Shift+N`, previous unbound.
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

- One construct per line: URL entry, `[ads]`, quote, `[img …]`, comment (`#` or `//`), blank. Anything else is kept as an invalid line and reported, never dropped.
- `[ads]` before the first URL is the **playlist-wide default**. An `[ads]` block after a URL (and before the next URL) **overrides** it for that entry. Quote / img lines outside a block are reported and ignored.
- `N: text` — quote displayed for N seconds (only the first `N:` is a prefix; colons later in the text are fine).
- `[img]` — images for the current site (see `[img ...]` resolution under Overlay iframe).
- `[img <keyword>]` — images matching that keyword (may be several words), using filename durations or 5s default. `[img <keyword> N]` forces N seconds.
- `url | title | t=…` — optional title and options. Fields shaped `key=value` are options (unknown keys are kept and reported); the first other field is the title. Titles are written so they can't read back as options.
- Indentation is **not** significant. An `[ads]` block's scope ends at the next URL line. Indentation is cosmetic and preserved on export.

### Hash params + seeking

- Jump to a specific video location with a timestamp hash (`src/lib/playlist/hash.ts`, tested).
- **Namespaced** to avoid colliding with sites' own hash routing / `t` params: `#wtv:t=97&d=Title`.
- **Timestamp formats:** `200`, `200s`, `1:37`, `1:02:03`, `1h2m3s` (`parseTimestamp`, tested). Written back as seconds.
- Title uses `encodeURIComponent`, not underscore escaping (titles with real underscores would be lost).
- The background playlist state is the source of truth. The hash is the synchronous fast path that lets the `document_start` content script show the blackout before first paint:
    - The runner navigates to `entry URL + #wtv:t=…&d=…`. Entries with a hash of their own (hash-routed sites) are left alone and fall back to the hello round trip.
    - The top frame reads it at `document_start`, blacks out immediately (the overlay host is painted black until its iframe has loaded), then removes it with `history.replaceState`, before the page's own scripts run. One-shot: reloads and copied links are the plain page.
    - A hash arriving later (`hashchange`) starts over. That covers the runner moving to an entry whose URL only differs by hash from the current page (same video twice, Resume), which is a same-document navigation with no reload.
    - A `#wtv:` link outside any playlist works on its own: blackout (no Next), start, seek.
- **Seek only after `loadedmetadata` and after any pre-roll ad clears** (`src/lib/playlist/seek.ts`, pure + tested). Never while an ad is showing.
    - On `quirks.adsInMainVideo` sites (YouTube plays ads in the same `<video>`, and ad detection can lag the ad's first frames), also only after 750 ms of ad-free playback, so a pre-roll is never the thing seeked.
    - Elsewhere it seeks as soon as metadata arrives, before the first frame: no visible jump.
    - Skipped for live streams, start times past the end, or when the player is already there (the site honoured its own parameter). Once per entry; every frame seeks its own primary (embedded players get the start time from the runner's hello).

### Site health checks

- Automated daily check of each site for changes / breaks by playing a video from each.
- **Runs outside the extension** (dev only, `scripts/health/`, see its README): `npm run health`. Playwright 1.64.1 with its bundled Chromium (Google Chrome dropped `--load-extension` around v137).
    - Headful, on a home connection (headless / datacenter IPs trigger bot walls). Persistent profile in `.health/profile` (gitignored); `npm run health:setup` opens every target to accept consent / sign in once.
    - Loads the **built extension** and asks it, via its service worker, for the same media status (`wtv/status`) and role report (`wtv/pick/roles`) the popup and side panel use. It exercises the real selector engine and media detection rather than a copy.
    - For each site (`src/sites/*.json`; URLs in `scripts/health/targets.json`, a test checks every bundled site has one): load the URL, wait for ad-free playback (pre-roll ads extend the wait), then judge every configured role (`scripts/health/protocol.ts`, pure + tested):
        - ✅ pass, ⚠️ fallback (selector #1 broke, a fallback matched: an early warning), ❌ fail. Present-but-hidden controls pass.
        - `video` passes only if its selectors picked the playing video.
        - Ads aren't guaranteed, so `adIndicator` / `skip` are 👁 seen / · not seen, never failures.
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
- Backup / restore of playlists + overrides as a JSON export/import.
- Unit tests (Vitest) for the playlist parser, filename durations, timestamp parsing, and override merging.

---

## Later

- Publish an authoritative playlist as a "tv station".
- Lightbox posts and comments, and auto-scroll long-form content, as playlist entries.
- Selector import system, if popularity grows.
