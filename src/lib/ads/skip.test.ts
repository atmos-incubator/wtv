import { describe, expect, it } from 'vitest';
import { looksLikeSkip } from './skip';

const el = (o: { id?: string; className?: string; label?: string; text?: string }) => ({
  id: o.id ?? '',
  className: o.className ?? '',
  getAttribute: (name: string) => (name === 'aria-label' ? (o.label ?? null) : null),
  textContent: o.text ?? '',
});

describe('looksLikeSkip', () => {
  it('recognises Skip buttons by class, id, label or text', () => {
    expect(looksLikeSkip(el({ className: 'ytp-skip-ad-button ytp-button' }))).toBe(true);
    expect(looksLikeSkip(el({ id: 'skip-button:6' }))).toBe(true);
    expect(looksLikeSkip(el({ label: 'Skip ad' }))).toBe(true);
    expect(looksLikeSkip(el({ text: '  Skip  ' }))).toBe(true);
    expect(looksLikeSkip(el({ text: 'Werbung überspringen' }))).toBe(true);
  });

  it('ignores seek, intro and navigation buttons, and unrelated ones', () => {
    expect(looksLikeSkip(el({ label: 'Skip forward 10 seconds' }))).toBe(false);
    expect(looksLikeSkip(el({ className: 'skip-intro-button', text: 'Skip intro' }))).toBe(false);
    expect(looksLikeSkip(el({ id: 'skip-navigation', text: 'Skip navigation' }))).toBe(false);
    expect(looksLikeSkip(el({ className: 'ytp-play-button', label: 'Pause (k)' }))).toBe(false);
    expect(looksLikeSkip(el({ text: 'Skip this paragraph of a much longer piece of text that is not a button' }))).toBe(
      false,
    );
  });
});
