/**
 * Content-script side of the selector picker: answers the side panel.
 * Runs in every frame; the frame the user clicks in reports the pick.
 */
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { deepQueryAll, isElementVisible } from '../dom/query';
import type { MediaAgent } from '../media/agent';
import type { AdOverlay } from '../overlay/ad-overlay';
import { ROLE_DEFAULT_WHEN, ROLE_NAMES, effectiveWhen, type Condition } from '../sites/schema';
import { describeElement, generateCandidates } from './candidates';
import {
  PICK_CANCELLED,
  PICK_RESULT,
  parsePickRequest,
  type MatcherReport,
  type PickResult,
  type RolesReport,
  type TestResult,
} from './messages';
import { flashMatches, startPicker, type Picker } from './picker';
import { ROLE_LABELS } from './roles';

function evaluate(selector: string, when: Condition): Omit<MatcherReport, 'selector' | 'when'> & { elements: Element[] } {
  const { elements, error } = deepQueryAll(selector);
  const satisfied = when === 'visible' ? elements.some(isElementVisible) : elements.length > 0;
  return { elements, count: elements.length, satisfied, error: error ?? null };
}

function notifyPanel(message: unknown): void {
  // The panel may have been closed; nothing to do then.
  browser.runtime.sendMessage(message).catch(() => undefined);
}

export function startPickerService(ctx: ContentScriptContext, agent: MediaAgent, adOverlay: AdOverlay): void {
  let picker: Picker | null = null;

  function end(): void {
    picker?.stop();
    picker = null;
    adOverlay.suspend(false);
  }

  function rolesReport(): RolesReport {
    const profile = agent.profile();
    const site = profile.site;
    return {
      host: location.hostname,
      profileKind: profile.kind,
      siteId: site?.config.id ?? null,
      siteName: site?.config.name ?? null,
      roles: ROLE_NAMES.map((role) => {
        const matchers = (site?.config.roles[role] ?? []).map((m) => {
          const when = effectiveWhen(role, m);
          const { count, satisfied, error } = evaluate(m.selector, when);
          return { selector: m.selector, when, count, satisfied, error };
        });
        const hit = matchers.findIndex((m) => m.satisfied);
        return {
          role,
          source: site?.sources[role] ?? null,
          matchers,
          matchedIndex: hit >= 0 ? hit : null,
        };
      }),
    };
  }

  const onMessage = (raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
    const msg = parsePickRequest(raw);
    if (!msg) return undefined;
    switch (msg.type) {
      case 'wtv/pick/start':
        end();
        adOverlay.suspend(true);
        picker = startPicker({
          delayMs: msg.delayMs,
          roleLabel: ROLE_LABELS[msg.role],
          onPick(el) {
            picker = null;
            adOverlay.suspend(false);
            const result: PickResult = {
              type: PICK_RESULT,
              role: msg.role,
              host: location.hostname,
              element: describeElement(el),
              candidates: generateCandidates(el),
            };
            flashMatches([el], 1200);
            notifyPanel(result);
          },
          onCancel() {
            picker = null;
            adOverlay.suspend(false);
            notifyPanel({ type: PICK_CANCELLED });
          },
          togglePlayback() {
            const primary = agent.primary();
            if (!primary) return;
            if (primary.features(null).playing) primary.pause();
            else primary.play();
          },
        });
        break;
      case 'wtv/pick/cancel':
        end();
        break;
      case 'wtv/pick/key':
        picker?.key(msg.key);
        break;
      case 'wtv/pick/test': {
        const { elements, ...rest } = evaluate(msg.selector, msg.when ?? ROLE_DEFAULT_WHEN[msg.role]);
        flashMatches(elements);
        const result: TestResult = rest;
        sendResponse(result);
        break;
      }
      case 'wtv/pick/roles':
        sendResponse(rolesReport());
        break;
    }
    return undefined;
  };

  browser.runtime.onMessage.addListener(onMessage);
  ctx.onInvalidated(() => {
    browser.runtime.onMessage.removeListener(onMessage);
    end();
  });
}
