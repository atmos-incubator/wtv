# TODO

Planned work, one step at a time, each reviewed and committed before the next starts. Built steps
move into [`docs/spec.md`](docs/spec.md) (build order + feature specs), which also lists what's
still open (bugs, the publishing checklist, deferred ideas).

Rules: dependencies exact-pinned and at least two weeks old; dev-only tools stay out of the store
build; selectors live in source; no new install-time permission warnings.

---

## Bug Fixes

3. I'd like to be able to nav back and forward through the playlist via a mouse hover ux that shows subtle left and right arrows over the entry.

6. Reddit needs to detected deleted posts: <div slot="post-removed-banner"><span class="flex flex-row col-start-1 col-end-4 items-center text-16 m-md xs:mx-0 px-md py-xs min-h-[56px] box-border rounded-1 border-sm border-neutral-border-weak border-solid text-secondary-weak "> <svg rpl="" class="flex flex-none text-20 text-alert-negative" fill="currentColor" height="20" icon-name="delete" viewBox="0 0 20 20" width="20" xmlns="http://www.w3.org/2000/svg">
      <path d="M15.2 15.7c0 .83-.67 1.5-1.5 1.5H6.3c-.83 0-1.5-.67-1.5-1.5V7.6H3v8.1C3 17.52 4.48 19 6.3 19h7.4c1.82 0 3.3-1.48 3.3-3.3V7.6h-1.8v8.1ZM17.5 5.8c.5 0 .9-.4.9-.9S18 4 17.5 4h-3.63c-.15-1.68-1.55-3-3.27-3H9.4C7.68 1 6.28 2.32 6.13 4H2.5c-.5 0-.9.4-.9.9s.4.9.9.9h15ZM7.93 4c.14-.68.75-1.2 1.47-1.2h1.2c.72 0 1.33.52 1.47 1.2H7.93Z"></path>
    </svg>
    <span class="flex flex-auto flex-col justify-center text-14 ps-sm"> Sorry, this post was deleted by the person who originally posted it. </span> </span></div>

7. And use the snapshot for youtube to handle unavailable videos

9. Cards can overflow the screen and they don't scroll to see the rest of the post.

10. The popup menu that shows the playlist / current playing items will change width if the item has a long url rendered in the display.  That should just ellipsis, and the content should be a consistent width - with a decent width to show long-ish titles.

11. Make a preview button that shows what a page would look like in a slideshow, but with an X option to close it so we can test selectors more easily.