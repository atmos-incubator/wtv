import { DEV_TOOLS } from '../lib/env';
import { startMediaAgent } from '../lib/media/agent';

/** ISOLATED-world media agent. Registered at runtime alongside media-hook. */
export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main(ctx) {
    startMediaAgent(ctx, { debug: DEV_TOOLS });
  },
});
