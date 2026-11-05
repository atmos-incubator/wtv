# TODO

New Plugin - wtv - Web TV - Wtv

Starting over on a project I have already released because I realize I did a terrible implementation, and so I'm starting fresh here before I publish this extension to the chrome store over the previous one.

The idea is to turn a browser into a tv, and every website / video is a show.  And eventually I'll publish an authoritative playlist as a "tv station" but until then I just want it to do the following:

- Ability to detect ads on video sites, mute the browser tab until the dom node that indicates an 'ad' is gone, then unmute when it's gone.

    - This will require a side-panel feature for a dom node finder / unique css selector system to extract the dom nodes that will be manipulated / watched in the UI. We'll need designated dom nodes for the video element, the ad-indicator element, and the skip element.  And ideally the title, description, keywords, creator elements to extract relevant playlist data.

    - Ability to automatically click on skip ad button when it appears and is clickable - also discovered / maintained as a source selector like the video element and ad-indicator.

    - Save will override what is used, by saving it to local storage config, and optionally send the findings back to a local server, that can write them to a file that can be imported here into the plugin source - so that we can maintain sites and publish updates when changes to their doms prevents finding these elements, but also allow people to quickly fix their session if a fix release hasn't been published yet. This will only be run by me, not offered to other people, so consider hiding it / not publishing it in the store version.

- Ability to jump to a specific video location using a hashtag #t=200s or #t=1:37 for accessing 200s in or at 1m 37s. 

- Ability to specify a generic folder of images, or a domain-specific folder, that render as a slideshow over the video when it's playing ads. I'd love if these could read that folder any time they need an option, but if we have to do a "load from this folder" workflow and import them into some cache storage that's fine too.

    - The filenames should allow for syntax that specifying how long the image should present in the filename itself with _d20s.png for duration 20 seconds.

- Ability to play / pause the video quickly with a click on the video itself without triggering accidental ad clicks.

- Ability to auto detect the primary video element, but use fall-back hard-coded selectors.

- Create an automated loop to check on websites daily for changes / breaks in functionality by playing a video from each site.

- Ability to "maximize" the video by moving it to the top of the z-index, and placing a 'letterbox' div behind it so that we can stretch the video to the largest aspect ratio it would allow.

    - With ability to fullscreen the video + letterbox divs

- Ability to load a playlist of videos / urls (by pasting the list), to play through and jump to the next entry when a video finishes

    - In playlist mode, have ability to jump back to a previous entry.

    - When in playlist mode - load a blackout div with the #d=title_of_video_underscore_escaped or via the title of the document until the page is loaded, resized, and ready to play.

    - Allow for updating the playlist titles / info and being able to export that playlist back out to clipboard.

    - Allow saving that playlist in storage for future playing

    - Allow automatically adding the current url to a playlist, with the option to manage additions across multiple playlists in the workflow, not just the "current" one.

- Ability to show quotes / sayings on blackout divs when ads are on using a duration prefix in seconds - 20: Take a moment to breath a little

    - These should just be line entries on the playlist, with a special keyword to denote when the ads in this list are to be selected from:
         [ads] 
            20: Take a moment to breath
            10: Dismiss your worries
            5: Relax

        In this case, each of these will display for as long as the number prefix allows and until the ad is over.

    - For images we would do this and let the image define a duration or default to 5s:
        [ads]
            [img <keyword>]

    - This way a playlist can do different things for each entry.  The [ads] keyword should be processed if it exists after the url that was just loaded and before another url entry.

- Eventually I will add the ability to lightbox posts and comments, and auto-scroll long-form content as entry items in playlists, but for now I plan on focusing exclusively on audio / video sources.