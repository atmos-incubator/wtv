import type { RoleName } from '../sites/schema';

export const ROLE_LABELS: Record<RoleName, string> = {
  video: 'Video',
  player: 'Player',
  adIndicator: 'Ad indicator',
  skip: 'Skip button',
  continuePrompt: 'Continue prompt',
  unavailable: 'Unavailable',
  playButton: 'Play button',
  progressBar: 'Progress bar',
  title: 'Title',
  description: 'Description',
  keywords: 'Keywords',
  creator: 'Creator',
  post: 'Post',
  postTitle: 'Post title',
  postAuthor: 'Post author',
  postText: 'Post text',
  postTime: 'Post time',
  postImage: 'Post pictures',
  postEmbed: 'Embed',
};

export const ROLE_HINTS: Record<RoleName, string> = {
  video: 'The main player. Picking its container works too.',
  player: 'The player’s outer box (video, controls, ads). The ad pictures cover it, and an unlisted Skip button is searched for inside it.',
  adIndicator: 'Something that is only there (or only visible) while an ad plays. Pick it during an ad.',
  skip: 'The “Skip ad” button. It only shows mid-ad, so use the countdown.',
  continuePrompt:
    'The “Yes” / “Continue” button of a “Still watching?” dialog. Clicked automatically after a pause, when nobody has used the page for a minute.',
  unavailable:
    'The player’s “Video unavailable” / “This video has been removed” message. In a playlist, Wtv marks the entry gone and moves on. Pick it on a removed video.',
  playButton: 'The player’s own play / pause button.',
  progressBar: 'The seek bar. Clicking just above it on the click shield jumps there.',
  title: 'The video or episode title.',
  description: 'The description text.',
  keywords: 'Usually a <meta name="keywords"> tag. Type the selector.',
  creator: 'The channel / author name.',
  post: 'The box around the one post a card shows: the first post on a thread page. The other post selectors are looked for inside it first. Optional, but it keeps the author and time from coming from a reply.',
  postTitle: 'The post’s title, on sites that have them (forum threads, Reddit).',
  postAuthor: 'The post author’s name.',
  postText: 'The post’s text. A post card needs this or the title.',
  postTime: 'When it was posted. A <time> element is read from its datetime.',
  postImage: 'The post’s pictures (up to 4): pick a picture, or the box they’re in.',
  postEmbed:
    'The post’s player, when it’s embedded from somewhere else (an <iframe>): pick it or the box it’s in. In a playlist it plays where it is, lifted over the card (view=card), or full screen when nothing else plays (view=video).',
};

/** How the side panel groups the roles. */
export const ROLE_GROUPS: readonly { title: string; note: string | null; roles: readonly RoleName[] }[] = [
  { title: 'Player', note: null, roles: ['video', 'player', 'playButton', 'progressBar'] },
  { title: 'Ads and prompts', note: null, roles: ['adIndicator', 'skip', 'continuePrompt', 'unavailable'] },
  { title: 'About the video', note: null, roles: ['title', 'creator', 'description', 'keywords'] },
  {
    title: 'Posts',
    note: 'For playlist entries with view=card on this site: Wtv opens the post’s page (signed in, as you are) and reads the card from it with these. Pick them on a post’s own page.',
    roles: ['post', 'postTitle', 'postAuthor', 'postText', 'postTime', 'postImage', 'postEmbed'],
  },
];
