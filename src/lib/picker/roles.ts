import type { RoleName } from '../sites/schema';

export const ROLE_LABELS: Record<RoleName, string> = {
  video: 'Video',
  adIndicator: 'Ad indicator',
  skip: 'Skip button',
  playButton: 'Play button',
  title: 'Title',
  description: 'Description',
  keywords: 'Keywords',
  creator: 'Creator',
};

export const ROLE_HINTS: Record<RoleName, string> = {
  video: 'The main player. Picking its container works too.',
  adIndicator: 'Something that is only there (or only visible) while an ad plays. Pick it during an ad.',
  skip: 'The “Skip ad” button. It only shows mid-ad, so use the countdown.',
  playButton: 'The player’s own play / pause button.',
  title: 'The video or episode title.',
  description: 'The description text.',
  keywords: 'Usually a <meta name="keywords"> tag. Type the selector.',
  creator: 'The channel / author name.',
};
