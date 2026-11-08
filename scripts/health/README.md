# Site health check

Dev-only. Plays a known video on every bundled site with the built extension loaded and
checks that each selector role still resolves. See the header of `run.ts` for details.

## First time

```sh
npm install
npx playwright install chromium   # Playwright's own Chromium (Google Chrome no longer loads unpacked extensions from the command line)
npm run health:setup               # opens each site: accept cookie consent / sign in, then press Enter
```

The browser profile lives in `.health/profile/` (gitignored), so consent and sign-ins
stick between runs.

## Run

```sh
npm run health                       # every site in src/sites/
npm run health -- --site youtube.com # one site
npm run health -- --keep-open        # leave the browser open to poke at it
npm run health -- --playlists        # also check every built-in playlist entry
```

`--playlists` opens each entry of every built-in playlist (`src/playlists/*.txt`) without
playing it, and marks it ❌ gone when the player shows its "Video unavailable" message (the
`unavailable` role) or YouTube's `playabilityStatus` says it's removed or private (⚠️
restricted: age or content checks a TV can't pass). The report gets a "Built-in playlists"
section listing them per playlist. Gone entries don't change the exit code. Pages and posts
(`view=read` / `scroll` / `card`) are checked by HTTP status instead: the page itself, or the
post's oEmbed answer (404 / 410, and 403 for posts, is ❌ gone).

It's headful on purpose: headless browsers and datacenter IPs get bot walls. Run it on
your own machine, logged in.

Results: `.health/results/latest.md`, and per run `.health/results/<timestamp>/`
(`report.json`, `summary.md`, plus `<site>.html` and `<site>.png` for each failing site,
so selectors can be fixed offline). Exit code 1 if any site failed.

Verdicts per role: ✅ pass, ⚠️ fallback (the first selector broke; a fallback still
matched — fix it before the fallback goes too), ❌ fail. `adIndicator` and `skip` are 👁
seen / · not seen: ads aren't guaranteed, so not seeing one isn't a failure.

## Targets

`targets.json` maps each site id to a stable video URL. Every bundled site needs one
(a unit test checks). Pick something long-lived and long enough to get ads.

## Daily (macOS)

A LaunchAgent runs in your logged-in session, which a headful browser needs. Save as
`~/Library/LaunchAgents/com.wtv.health.plist` (fix the path), then
`launchctl load ~/Library/LaunchAgents/com.wtv.health.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wtv.health</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /path/to/wtv &amp;&amp; npm run health</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/wtv-health.log</string>
  <key>StandardErrorPath</key><string>/tmp/wtv-health.log</string>
</dict>
</plist>
```
