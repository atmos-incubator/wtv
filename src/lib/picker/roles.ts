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
};
