import { browser } from 'wxt/browser';
import { startAdWatcher } from '../lib/ads/watcher';
import { startSnapshotButton } from '../lib/dev/snapshot';
import { DEV_TOOLS } from '../lib/env';
import { startMediaAgent } from '../lib/media/agent';
import { MSG_PREVIEW_OVERLAY, MSG_SHOW_AD_PICTURES, isStatusRequest, type FrameStatus } from '../lib/messages';
import { startHealthMonitor } from '../lib/health/monitor';
import { pageMetadata } from '../lib/metadata/page';
import { startOverlay } from '../lib/overlay/controller';
import { installPickGuard } from '../lib/picker/guard';
import { startPickerService } from '../lib/picker/service';
import { startPlaylistClient } from '../lib/playlist/client';
import { startContinuePrompt } from '../lib/prompts/continue';
import { BUNDLED_MATCHES } from '../lib/sites/bundled';
import { startViewService } from '../lib/view/service';

const PREVIEW_MS = 12_000;
/** How often to check whether the extension was reloaded or removed under this page. */
const ORPHAN_CHECK_MS = 1000;

/**
 * ISOLATED-world media agent + ad watcher + view (maximize, play/pause) + playlist client
 * + overlay (blackout, ad pictures, click shield) + selector picker. Registered at runtime alongside
 * media-hook. See media-hook.content.ts for why `matches` is set.
 */
export default defineContentScript({
  registration: 'runtime',
  matches: BUNDLED_MATCHES,
  runAt: 'document_start',
  allFrames: true,
  noScriptStartedPostMessage: true,
  main(ctx) {
    // When the extension is reloaded, updated or turned off, this script keeps running
    // in tabs that were already open (MV3 doesn't inject the new one), but its overlay
    // iframe goes blank: a black box over the video. Nothing tells us. WXT only notices
    // when something reads `ctx.isInvalid`, which `ctx.setInterval` does on every tick;
    // then every `onInvalidated` cleanup runs and the overlay is removed.
    ctx.setInterval(() => undefined, ORPHAN_CHECK_MS);
    // First, before the page's scripts add listeners of their own (see guard.ts).
    installPickGuard(ctx.signal);

    const agent = startMediaAgent(ctx, { debug: DEV_TOOLS });
    const ads = startAdWatcher(ctx, agent, { debug: DEV_TOOLS });
    startHealthMonitor(ctx, agent, ads);
    startContinuePrompt(ctx, agent);
    const view = startViewService(ctx, agent, ads);
    const playlist = startPlaylistClient(ctx, agent, ads);
    const overlay = startOverlay(ctx, agent, ads, view, playlist);
    startPickerService(ctx, agent, overlay);
    if (DEV_TOOLS) startSnapshotButton(ctx, agent, ads);

    const onMessage = (msg: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (isStatusRequest(msg)) {
        let metadata: FrameStatus['metadata'] = null;
        if (window === window.top) {
          const { title, creator } = pageMetadata(agent.profile().site);
          metadata = { title, creator };
        }
        const status: FrameStatus = { media: agent.status(), ads: ads.status(), overlay: overlay.status(), metadata };
        sendResponse(status);
      } else if ((msg as { type?: unknown } | null)?.type === MSG_SHOW_AD_PICTURES) {
        overlay.showAdPictures();
      } else if (DEV_TOOLS && (msg as { type?: unknown } | null)?.type === MSG_PREVIEW_OVERLAY) {
        sendResponse(overlay.preview(PREVIEW_MS));
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));
  },
});
