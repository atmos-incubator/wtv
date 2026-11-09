# TODO

Planned work, one step at a time, each reviewed and committed before the next starts. Built steps
move into [`docs/spec.md`](docs/spec.md) (build order + feature specs), which also lists what's
still open (bugs, the publishing checklist, deferred ideas).

Rules: dependencies exact-pinned and at least two weeks old; dev-only tools stay out of the store
build; selectors live in source; no new install-time permission warnings.

---

## Bug Fixes

3. I'd like to be able to nav back and forward through the playlist via a mouse hover ux that shows subtle left and right arrows over the entry.

9. Cards can overflow the screen and they don't scroll to see the rest of the post.

10. The popup menu that shows the playlist / current playing items will change width if the item has a long url rendered in the display.  That should just ellipsis, and the content should be a consistent width - with a decent width to show long-ish titles.

11. Make a preview button that shows what a page would look like in a slideshow, but with an X option to close it so we can test selectors more easily.

12. Is there a way to refresh the extension from the playlist management page and not lose track of the view when I do it (basically a way to restore the tab that disappears when I click refresh, but also remember if I had a playlist edit page open when I do?)