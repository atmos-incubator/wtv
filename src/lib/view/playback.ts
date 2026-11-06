/**
 * Play / pause the frame's primary media. Content script.
 *
 * Prefers clicking the site's `playButton` role: calling play() / pause() directly
 * can leave the site's player UI out of sync. If the click didn't change anything
 * (wrong button, or the site ignores untrusted clicks), falls back to the element.
 */
import { matchRole } from '../dom/query';
import type { MediaAgent } from '../media/agent';

const VERIFY_MS = 400;

export function togglePlayback(agent: MediaAgent): void {
  const primary = agent.primary();
  if (!primary) return;
  const wasPlaying = primary.features(null).playing;
  const direct = () => (wasPlaying ? primary.pause() : primary.play());

  const matchers = agent.profile().site?.config.roles.playButton;
  const button = matchers ? matchRole('playButton', matchers).match?.element : null;
  if (!(button instanceof HTMLElement)) {
    direct();
    return;
  }
  button.click();
  setTimeout(() => {
    if (primary.features(null).playing === wasPlaying) direct();
  }, VERIFY_MS);
}
