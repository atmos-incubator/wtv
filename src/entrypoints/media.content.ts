import { browser } from 'wxt/browser';
import { startAdWatcher } from '../lib/ads/watcher';
import { DEV_TOOLS } from '../lib/env';
import { startMediaAgent } from '../lib/media/agent';
import { isStatusRequest, type FrameStatus } from '../lib/messages';
import { BUNDLED_MATCHES } from '../lib/sites/bundled';

/**
 * ISOLATED-world media agent + ad watcher. Registered at runtime alongside media-hook.
 * See media-hook.content.ts for why `matches` is set.
 */
export default defineContentScript({
  registration: 'runtime',
  matches: BUNDLED_MATCHES,
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main(ctx) {
    const agent = startMediaAgent(ctx, { debug: DEV_TOOLS });
    const ads = startAdWatcher(ctx, agent, { debug: DEV_TOOLS });

    const onMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (!isStatusRequest(msg)) return undefined;
      const status: FrameStatus = { media: agent.status(), ads: ads.status() };
      sendResponse(status);
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
