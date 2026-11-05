import { DEV_TOOLS } from '../lib/env';
import { startMediaAgent } from '../lib/media/agent';
import { BUNDLED_MATCHES } from '../lib/sites/bundled';

/**
 * ISOLATED-world media agent. Registered at runtime alongside media-hook.
 * See media-hook.content.ts for why `matches` is set.
 */
export default defineContentScript({
  registration: 'runtime',
  matches: BUNDLED_MATCHES,
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main(ctx) {
    startMediaAgent(ctx, { debug: DEV_TOOLS });
  },
});
