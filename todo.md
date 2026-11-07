# TODO — Round 2

Round 1 (steps 0–9) is done; its build order, architecture decisions and feature specs are in
[`docs/spec.md`](docs/spec.md), which stays the reference for how things work. This file plans
round 2: what round 1 left open, and the ideas from [`docs/future.md`](docs/future.md) (numbers in
brackets, e.g. [F5], point back to that list).

Same rules as round 1: one step at a time, each reviewed and committed by me before the next
starts. Dependencies exact-pinned and at least two weeks old. Dev-only tools stay out of the store
build.

---

## Left over from round 1

Not done, or done but not verified:

- [ ] **Run the health check once for real.** `npm run health` has only been type-checked and
      unit-tested. Run it, check `.health/results/latest.md`, and fix whatever the first real run
      turns up.
- [ ] **Metadata extraction** (spec: JSON-LD `VideoObject` → OpenGraph → `meta` / `itemprop` →
      role selectors, with the stale-OpenGraph check on SPAs). Never built: the `title`,
      `description`, `keywords` and `creator` roles exist but nothing reads them. Needed by the
      selector preview (step 11) and the media library (step 14). Built in step 11.
- [ ] **Backup / restore** of playlists + selector overrides as a JSON export / import. Built in
      step 15, alongside built-in playlists.
- [ ] **Publishing over the previous extension** (checklist in `docs/spec.md`):
    - Version: `2.0.0` must be higher than the published one. Check the store listing.
    - Diff permission warnings against the published manifest. New warnings disable the extension
      for existing users until they accept.
    - Wiping the old extension's storage on update and scoping `host_permissions` to bundled sites
      are already done (steps 1–2); tick them once checked against the published version.
- **Open bugs:**
    - [ ] Ads stopped reappearing after several video clicks on YouTube (deferred in step 6).
          Reproduce with the dev timeline and 📸 snapshots.
    - [ ] Ad pictures blip off for a split second when an ad starts. Two fixes are in (end the ad
          only once the show is playing; cover the player that holds the video) plus a blip
          detector that logs a timeline. Close once it hasn't recurred for a while.
    - [ ] YouTube advertiser surveys: Skip ignores untrusted clicks, and seeking can't help (no
          video plays). The skip code now rotates four click strategies and records which one
          worked. If none works, the survey stays muted and covered for its ~30 s. Close after a
          few surveys either way.
- **Deferred on purpose** (kept from round 1's notes, not scheduled):
    - An "on" toolbar state, as an icon variant rather than a badge.
    - `use_dynamic_url` for the overlay page (stops sites probing for Wtv; needs testing).
    - Generic-site ad signals (Google IMA SDK iframes, mid-playback `src` / duration swaps).

---

## Build Order

- [ ] **Step 10 — Overlay control + YouTube's "Continue watching?"** [F1, F6]
- [ ] **Step 11 — Selector panel: remove selectors, metadata preview** [F2, F4]
- [ ] **Step 12 — Pictures outside ads: on pause, and as the show** [F5, F11]
- [ ] **Step 13 — Playlist options: end time / duration, shuffle** [F16, F13]
- [ ] **Step 14 — Media library: durations, thumbnails, gone videos** [F7, F9, part of F10]
- [ ] **Step 15 — Built-in playlists + backup / restore** [F3, F8, F12]
- [ ] **Step 16 — Playlist explorer side panel** [F10]
- [ ] **Step 17 — Non-video shows: web pages and posts** [F14, F15]

Steps 10–13 are small and independent. 14 comes before 15 and 16 because built-in playlists
want durations and the explorer wants thumbnails. 17 is the biggest change (a playlist entry that
isn't a video) and goes last.

---

## Step specs

### Step 10 — Overlay control + "Continue watching?"

**Bring the ad pictures back after ✕** [F1]. Not done yet: ✕ hides them until that ad ends, with
no way back.

- After ✕, a small "Show pictures" pill sits in a corner of the player for the rest of the ad
  (part of the shield, so it can't be an ad click). Clicking it shows the pictures again.
- The popup's Media row gets **Show ad pictures** while an ad is on and they're hidden.

**YouTube's "Video paused. Continue watching?" dialog** [F6, `docs/continue_watching_bug.md`].
It once left the ad overlay up all night: the prompt paused the video during an ad, so the ad
never ended.

- New optional role **`continuePrompt`**: the dialog's confirm button (YouTube:
  `yt-confirm-dialog-renderer #confirm-button button`, checked with a 📸 snapshot of the real
  dialog). When it's visible, Wtv clicks it using the skip button's click strategies.
- If the click is ignored, call `play()` on the video, and hide the dialog if it's still there.
- Safety net, for any site: if an ad has "shown" for 10 minutes with the video's time not moving,
  stop covering and muting, and log why. A stuck ad shouldn't run all night.
- In a playlist, a prompt that can't be dismissed counts as the entry stalling: show Start / Next,
  like a blocked autoplay.

### Step 11 — Selector panel: remove selectors, metadata preview

**Remove selectors that don't match** [F2]:

- Every selector row in the side panel gets a **✕** that removes it. For a built-in selector this
  saves an override for that role without it. **Reset** still restores the built-in list.
- **Remove unmatched** per role removes every selector with 0 matches. It asks first, because
  transient roles (skip, ad indicator) legitimately match nothing outside an ad.

**Metadata extraction + preview** [F4, round 1 leftover]:

- `src/lib/metadata/`: per page, title / creator / description / keywords / thumbnail / duration
  from JSON-LD `VideoObject`, then OpenGraph (`og:title`, `og:image`, `og:video:duration`), then
  `meta` / `itemprop`, then the role selectors. Pure parsing over a DOM snapshot, unit-tested with
  fixture HTML. OpenGraph is only trusted when `og:url` matches the current URL (YouTube leaves
  stale tags behind after in-app navigation).
- Side panel **Preview** section: the extracted values, live, each labelled with where it came
  from (JSON-LD / OpenGraph / your selector). It updates as you edit a selector, so you can see
  what a change does.
- The popup shows the extracted title / creator in the Media row.

### Step 12 — Pictures outside ads

The overlay already plays a picture program over ads. Two more reasons to show it:

**On pause** [F5]: setting **Show pictures while paused** (off by default).

- Shown when the show is paused by the user (click shield, play/pause shortcut, the site's own
  button), not while it buffers, seeks or loads. It waits 1.5 s, so quick pause / play doesn't
  flash.
- Clicking a picture resumes the show and hides the overlay. So does play from any other control.
- The program is the same as for ads: the entry's `[ads]` block, the playlist default, then site
  pictures.

**Pictures as the show** [F11]: the media plays in the background, unseen, and pictures cover it
for the whole entry. For music, radio, podcasts.

- Playlist entry option `view=pictures` (so `url | Title | view=pictures`), and a playlist-wide
  default line `[view pictures]` before the first URL (round-trips like `[ads]`).
- A new `[show]` block, same syntax as `[ads]`, picks the pictures for the show. It falls back to
  `[ads]`, then site pictures.
- Covers the media's box, or the whole tab when the media has no box (audio-only).
- Pauses are still visible: the pictures dim and show ⏸.

### Step 13 — Playlist options

**End time / duration** [F16]:

- Entry options `end=1:30` (stop at that time) and `dur=45s` (play that long from the start time).
  Same timestamp formats as `t=`. If both are given, `end=` wins and the editor flags it.
- Hash: `#wtv:t=97&e=187` (end time in seconds, from either option). A link outside a playlist
  pauses at the end; inside one it moves to the next entry.
- Ad time doesn't count: the end is measured against the media's own time, not the clock.

**Shuffle** [F13]:

- Playlist-wide line `[shuffle]` before the first URL. The playlist page's **▶ Play** gets a
  **Shuffle** checkbox, ticked by default when the playlist has the line.
- The order is shuffled once at start and kept in the runner's session state, so **Previous**
  goes back through the same order. **Reshuffle** in the popup.
- Decide: should shuffle reshuffle when the playlist loops? (Playlists don't loop yet: add a
  `[loop]` line here too?)

### Step 14 — Media library

What Wtv learns about each URL as it plays, kept for the playlist features that need it before
playing [F9, F10, F7].

- **Store:** IndexedDB (extension origin, beside the images), keyed by normalized entry URL
  (`sameEntryUrl`'s rules): title, creator, duration, thumbnail URL, thumbnail blob, status
  (`ok` / `gone`), last played. Updated by the playlist client from the metadata extractor
  (step 11) and the primary's `duration`.
- **Durations** [F9]: the playlist page shows each entry's duration and the playlist total ("about
  2 h 10 min, 3 entries unknown"). A `progressBar`-style role isn't needed: the media's
  `duration` and `og:video:duration` cover it.
- **Thumbnails** [F10]: `og:image` / JSON-LD `thumbnailUrl`, fetched by the background and cached
  as a blob on first play. Needs host access to the image's host, so ask for it with the
  playlist's other sites at Play (`i.ytimg.com` for YouTube). On demand only: nothing is fetched
  for entries that haven't played.
- **Gone videos** [F7]: a new optional role **`unavailable`** (YouTube: the "Video unavailable" /
  "This video has been removed" player error, checked with a snapshot). When it shows in a
  playlist, the entry is marked `gone` and the runner moves on after 3 s with the title card
  "Unavailable: <title>". The playlist page flags gone entries; **Remove gone entries** cleans up.

### Step 15 — Built-in playlists + backup / restore

**Built-in playlists** [F3, F8]:

- Shipped as text files in `src/playlists/*.txt` (same format, plus a `# name:` first line),
  validated at build time like site configs. YouTube to start; I provide the lists.
- Shown read-only on the playlists page under **Built in**. **Duplicate** makes an editable copy.
  Updates arrive with extension releases.
- Durations / thumbnails for built-ins come from the media library as they're played. Not
  shipped; it's the same on-demand cache [F10].

**Gone videos in the health check** [F12]:

- `npm run health -- --playlists` opens every built-in entry (title page only, no playback) and
  checks the `unavailable` role and the page's own status (YouTube's `playabilityStatus` in the
  page JSON). The report lists gone entries per playlist, as a ❌ that doesn't fail the site check.

**Backup / restore** (round 1 leftover): the playlists page gets **Export everything** / **Import**,
for playlists + selector overrides + settings in one JSON file (versioned, validated on import,
merged by playlist id with a confirm). The image library isn't included; it's re-imported from
its folder.

### Step 16 — Playlist explorer side panel [F10]

- A **Playlists** view in the side panel (beside Fix selectors), for browsing while watching:
  search by playlist name and entry title, built-in and yours, sorted by last played.
- Each playlist card shows a quad-layout slideshow of its entries' cached thumbnails, cycling
  slowly (the four most recent, then the next four). Entries with no cached thumbnail show their
  title on a color block.
- **▶ Play**, **Play in TV mode**, **Shuffle**, **Open** (goes to the playlists page editor). The
  current playlist and entry are highlighted while it runs.

### Step 17 — Non-video shows [F14, F15]

A playlist entry can be something to read, not watch. New entry option `view=`:

**Web pages** [F14]: `url | Title | view=read` or `view=scroll`.

- `read`: the page's article, extracted with Mozilla's Readability (`@mozilla/readability`, the
  library behind Firefox Reader View; Apache-2.0, no dependencies). It's shown in the overlay as
  large, TV-legible text and scrolled at a steady reading pace. If Readability finds no article,
  it falls back to `scroll`.
- `scroll`: the page itself, scrolled to the bottom at a steady pace.
- Ends at the bottom plus a short dwell, or at `dur=`. Speed: `speed=` option (words per minute
  for `read`, px/s for `scroll`), with a playlist-wide default.
- Wtv needs host access to the page's site, like any other entry.

**Posts as title cards** [F15]: `url | view=card` for a single post: author, text and time on a
full-screen card for `dur=` (default from text length).

- X / Twitter: the public oEmbed endpoint (`publish.twitter.com/oembed`) returns a post's text
  without signing in. Fetched by the background, rendered by the overlay page (never the
  embed script).
- Decide: which sites besides X? Bluesky (public API, no sign-in), Mastodon (public statuses),
  Reddit (`.json`) are the easy ones.

---

## Later

- Publish an authoritative playlist as a "tv station".
- Selector import system, if popularity grows.
