import { browser } from 'wxt/browser';
import { startAdWatcher } from '../lib/ads/watcher';
import { DEV_TOOLS } from '../lib/env';
import { startMediaAgent } from '../lib/media/agent';
import { MSG_PREVIEW_OVERLAY, isStatusRequest, type FrameStatus } from '../lib/messages';
import { startOverlay } from '../lib/overlay/controller';
import { startPickerService } from '../lib/picker/service';
import { BUNDLED_MATCHES } from '../lib/sites/bundled';
import { startViewService } from '../lib/view/service';

const PREVIEW_MS = 12_000;

/**
 * ISOLATED-world media agent + ad watcher + view (maximize, play/pause) + overlay (ad
 * pictures, click shield) + selector picker. Registered at runtime alongside
 * media-hook. See media-hook.content.ts for why `matches` is set.
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
    const view = startViewService(ctx, agent);
    const overlay = startOverlay(ctx, agent, ads, view);
    startPickerService(ctx, agent, overlay);

    const onMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (isStatusRequest(msg)) {
        const status: FrameStatus = { media: agent.status(), ads: ads.status() };
        sendResponse(status);
      } else if (DEV_TOOLS && (msg as { type?: unknown } | null)?.type === MSG_PREVIEW_OVERLAY) {
        sendResponse(overlay.preview(PREVIEW_MS));
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
