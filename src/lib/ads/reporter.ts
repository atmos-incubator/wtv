/**
 * Content-script side of ad reporting. Holds a port to the background only while an
 * ad is active. If the port drops mid-ad (service worker restarted), reconnect and
 * re-send, which also wakes the worker.
 */
import { browser } from 'wxt/browser';
import { AD_PORT, type AdPortMessage } from './protocol';

const RECONNECT_DELAY_MS = 250;

type Port = ReturnType<typeof browser.runtime.connect>;

export interface AdReporter {
  set(active: boolean, mute: boolean): void;
  close(): void;
}

export function createAdReporter(signal: AbortSignal): AdReporter {
  let port: Port | null = null;
  let state: AdPortMessage = { type: 'state', active: false, mute: false };

  function open(): Port | null {
    if (port || signal.aborted) return port;
    try {
      const p = browser.runtime.connect({ name: AD_PORT });
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        // Still in an ad: the worker went away. Re-establish so it can re-mute/unmute.
        if (state.active && !signal.aborted) setTimeout(send, RECONNECT_DELAY_MS);
      });
      port = p;
    } catch {
      port = null; // Extension context gone (reloaded); nothing to report to.
    }
    return port;
  }

  function send(): void {
    if (signal.aborted) return;
    if (!state.active) {
      if (port) {
        try {
          port.postMessage(state);
        } catch {
          // Already disconnected; closing does the same job.
        }
        const p = port;
        port = null;
        p.disconnect();
      }
      return;
    }
    const p = open();
    try {
      p?.postMessage(state);
    } catch {
      port = null;
    }
  }

  return {
    set(active, mute) {
      if (state.active === active && state.mute === mute) return;
      state = { type: 'state', active, mute };
      send();
    },
    close() {
      state = { ...state, active: false };
      const p = port;
      port = null;
      try {
        p?.disconnect();
      } catch {
        // Already gone.
      }
    },
  };
}
