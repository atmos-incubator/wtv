/**
 * The Credits dialog: the Wtv logo, name and version over the about text in
 * src/credits.html (edit that file to change what it says). Shared by the popup and the
 * settings page. A native modal <dialog>: Esc, Close or a click outside closes it.
 */
import { browser } from 'wxt/browser';
import about from '../../credits.html?raw';
import './credits.css';

let dialog: HTMLDialogElement | null = null;

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'wtv-credits';
  d.setAttribute('aria-labelledby', 'wtv-credits-title');

  const logo = Object.assign(document.createElement('img'), {
    src: browser.runtime.getURL('/wtv-logo.png'),
    alt: '',
    width: 128,
    height: 128,
    className: 'logo',
  });
  const title = Object.assign(document.createElement('h2'), { id: 'wtv-credits-title', textContent: 'Wtv' });
  const version = Object.assign(document.createElement('p'), {
    className: 'version',
    textContent: `Version ${browser.runtime.getManifest().version}`,
  });

  // Our own file, from the build: trusted.
  const body = Object.assign(document.createElement('div'), { className: 'about', innerHTML: about });
  for (const a of body.querySelectorAll('a')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }

  const form = Object.assign(document.createElement('form'), { method: 'dialog', className: 'close' });
  form.append(Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Close' }));

  d.append(logo, title, version, body, form);
  // A click on the backdrop lands on the <dialog> itself.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  return d;
}

export function openCredits(): void {
  if (!dialog?.isConnected) dialog = build();
  dialog.showModal();
}

/** A button that opens the dialog. */
export function creditsButton(text = 'Credits…'): HTMLButtonElement {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
  b.addEventListener('click', openCredits);
  return b;
}
