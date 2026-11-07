/** Dev builds only: content script → background, capture the visible tab as a PNG. */
export const DEV_SCREENSHOT = 'wtv/dev/screenshot';

export type ScreenshotReply = { ok: true; dataUrl: string } | { ok: false; error: string };
