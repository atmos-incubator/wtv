# TODO

Planned work, one step at a time, each reviewed and committed before the next starts. Built steps
move into [`docs/spec.md`](docs/spec.md) (build order + feature specs), which also lists what's
still open (bugs, the publishing checklist, deferred ideas).

Rules: dependencies exact-pinned and at least two weeks old; dev-only tools stay out of the store
build; selectors live in source; no new install-time permission warnings.

---

## Bug Fixes

12. Is there a way to refresh the extension from the playlist management page and not lose track of the view when I do it (basically a way to restore the tab that disappears when I click refresh, but also remember if I had a playlist edit page open when I do?)

13. The iframe embedded videos need to intercept clicks in the playlist mode too - trying to pause causes that popup to open still in the playback mode.

15. Preview mode shouldn't trigger the timer to skip to the next item.