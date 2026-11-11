import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  compilePlaylist,
  parseLine,
  parsePlaylist,
  renderEntry,
  serializePlaylist,
  formatVolume,
  parseVolume,
  withEntryOption,
  withEntryTitle,
  withoutEntries,
} from './format';
import { parseTimestamp } from './time';

const SAMPLE = `# Sunday night
[ads]
    20: Take a moment to breathe
    [img cats]

https://www.youtube.com/watch?v=abc | Some Title | t=1:37
[ads]
    20: Take a moment to breathe
    10: Dismiss your worries: all of them
    5: Relax

https://vimeo.com/123 | Another Title
  [ads]
    [img]
    [img grumpy cats 10]

// no title, no ads block: uses the default
https://example.com/show
`;

describe('round trip', () => {
  it.each([
    ['sample', SAMPLE],
    ['empty', ''],
    ['just a newline', '\n'],
    ['no trailing newline', 'https://a.com/x | A'],
    ['CRLF', 'https://a.com/x | A\r\n\r\n[ads]\r\n  5: hi\r\n'],
    ['odd spacing and junk kept', '   https://a.com/x|A|t=5   \n\tnonsense line\n\n\n[ADS]\n[IMG  cats   3 ]\n'],
  ])('%s', (_label, text) => {
    expect(serializePlaylist(parsePlaylist(text))).toBe(text);
  });
});

describe('parseLine', () => {
  it('reads entries with title and options', () => {
    expect(parseLine('  https://a.com/x?y=1 | My | Title |  t=1:37 ')).toMatchObject({
      kind: 'entry',
      url: 'https://a.com/x?y=1',
      title: 'My | Title',
      options: [{ key: 't', value: '1:37' }],
    });
    expect(parseLine('https://a.com/x | t=5')).toMatchObject({ title: null, options: [{ key: 't', value: '5' }] });
  });

  it('reads quotes; only the first colon is the prefix', () => {
    expect(parseLine('10: Dismiss: your worries')).toMatchObject({
      kind: 'quote',
      durationS: 10,
      text: 'Dismiss: your worries',
    });
  });

  it('reads image items', () => {
    expect(parseLine('[img]')).toMatchObject({ kind: 'img', keyword: null, durationS: null });
    expect(parseLine('[img cats]')).toMatchObject({ keyword: 'cats', durationS: null });
    expect(parseLine('[img grumpy cats 10]')).toMatchObject({ keyword: 'grumpy cats', durationS: 10 });
    expect(parseLine('[img 7]')).toMatchObject({ keyword: null, durationS: 7 });
    expect(parseLine('[img cats 0]').kind).toBe('invalid');
  });

  it('keeps junk as invalid lines', () => {
    expect(parseLine('ftp://a.com/x').kind).toBe('invalid');
    expect(parseLine('https://').kind).toBe('invalid');
    expect(parseLine('hello there').kind).toBe('invalid');
    expect(parseLine('0: never').kind).toBe('invalid');
  });
});

describe('compilePlaylist', () => {
  const { entries, defaultAds, problems } = compilePlaylist(parsePlaylist(SAMPLE));

  it('collects entries in order', () => {
    expect(entries.map((e) => [e.url, e.title, e.startS])).toEqual([
      ['https://www.youtube.com/watch?v=abc', 'Some Title', 97],
      ['https://vimeo.com/123', 'Another Title', null],
      ['https://example.com/show', null, null],
    ]);
    expect(problems).toEqual([]);
  });

  it('applies the default [ads] block unless an entry has its own', () => {
    expect(defaultAds).toEqual([
      { kind: 'text', text: 'Take a moment to breathe', durationS: 20 },
      { kind: 'img', keyword: 'cats', durationS: null },
    ]);
    expect(entries[0]!.ads).toHaveLength(3);
    expect(entries[1]!.ads).toEqual([
      { kind: 'img', keyword: null, durationS: null },
      { kind: 'img', keyword: 'grumpy cats', durationS: 10 },
    ]);
    expect(entries[2]!.ads).toBe(defaultAds);
  });

  it('has no ads program at all without any [ads] block', () => {
    expect(compilePlaylist(parsePlaylist('https://a.com/x')).entries[0]!.ads).toBeNull();
  });

  it('reports problems with line numbers', () => {
    const r = compilePlaylist(parsePlaylist('5: stray\nhttps://a.com/x | t=soon | z=1\nwhat'));
    expect(r.problems).toEqual([
      { line: 1, message: 'outside an [ads] or [show] block (ignored)' },
      { line: 2, message: 't=soon is not a timestamp' },
      { line: 2, message: 'unknown option z= (kept, ignored)' },
      { line: 3, message: expect.stringContaining('not a URL') },
    ]);
  });
});

describe('views and [show]', () => {
  const RADIO = `[view pictures]
[show]
  [img beach]
[ads]
  10: Fun fact

https://radio.example/a | Station A
https://www.youtube.com/watch?v=b | A video | view=video
https://radio.example/c | Station C
[show]
  [img night 8]
https://radio.example/d
[ads]
  5: Own ad quote
`;

  it('round-trips', () => {
    expect(serializePlaylist(parsePlaylist(RADIO))).toBe(RADIO);
    expect(parseLine('  [VIEW Pictures] ')).toEqual({ kind: 'view', raw: '  [VIEW Pictures] ', mode: 'pictures' });
    expect(parseLine('[Show]')).toEqual({ kind: 'show', raw: '[Show]' });
  });

  it('applies the playlist-wide view, which an entry can override', () => {
    const { entries, defaultView, problems } = compilePlaylist(parsePlaylist(RADIO));
    expect(problems).toEqual([]);
    expect(defaultView).toBe('pictures');
    expect(entries.map((e) => e.view)).toEqual(['pictures', 'video', 'pictures', 'pictures']);
  });

  it('picks the show pictures: own [show], playlist [show], then the ads program', () => {
    const { entries, defaultShow } = compilePlaylist(parsePlaylist(RADIO));
    expect(defaultShow).toEqual([{ kind: 'img', keyword: 'beach', durationS: null }]);
    expect(entries[0]!.show).toBe(defaultShow);
    expect(entries[2]!.show).toEqual([{ kind: 'img', keyword: 'night', durationS: 8 }]);
    // An entry's own [ads] doesn't beat the playlist's [show].
    expect(entries[3]!.show).toBe(defaultShow);
    expect(entries[3]!.ads).toEqual([{ kind: 'text', text: 'Own ad quote', durationS: 5 }]);

    const noShow = compilePlaylist(parsePlaylist('[ads]\n  [img cats]\nhttps://a.com/1 | view=pictures\nhttps://a.com/2'));
    expect(noShow.entries[0]!.show).toEqual([{ kind: 'img', keyword: 'cats', durationS: null }]);
    expect(noShow.entries[1]!.view).toBe('video');
    expect(compilePlaylist(parsePlaylist('https://a.com/1')).entries[0]!.show).toBeNull();
  });

  it('reports bad views and a [view] after the first entry', () => {
    const r = compilePlaylist(parsePlaylist('[view radio]\nhttps://a.com/1 | view=Pictures\n[view pictures]\nhttps://a.com/2 | view=tv'));
    expect(r.problems).toEqual([
      { line: 1, message: '[view radio]: expected video, pictures, read, scroll, card' },
      { line: 3, message: '[view …] goes before the first entry; use view= on an entry (ignored)' },
      { line: 4, message: 'view=tv: expected video, pictures, read, scroll, card' },
    ]);
    expect(r.entries.map((e) => e.view)).toEqual(['pictures', 'video']);
  });
});

describe('pages and posts', () => {
  const compile = (text: string) => compilePlaylist(parsePlaylist(text));

  it('reads view=read / scroll / card, with speeds', () => {
    const r = compile(
      [
        '[speed 220 wpm]',
        '[speed 45 px/s]',
        'https://a.com/story | Story | view=read',
        'https://a.com/story2 | view=read | speed=150',
        'https://a.com/page | view=scroll',
        'https://a.com/page2 | view=scroll | speed=12px/s | dur=1:00',
        'https://x.com/someone/status/123 | view=card | dur=20s',
        'https://www.youtube.com/watch?v=a',
      ].join('\n'),
    );
    expect(r.problems).toEqual([]);
    expect(r.defaultSpeed).toEqual({ wpm: 220, pxPerS: 45 });
    expect(r.entries.map((e) => [e.view, e.speed, e.endS])).toEqual([
      ['read', 220, null],
      ['read', 150, null],
      ['scroll', 45, null],
      ['scroll', 12, 60],
      ['card', null, 20],
      ['video', null, null],
    ]);
  });

  it('flags speeds that don\'t fit and t= on a page', () => {
    const r = compile(
      [
        '[speed 200]',
        'https://a.com/1 | view=read | speed=40px/s | t=1:00',
        'https://a.com/2 | speed=200',
        'https://a.com/3 | view=scroll | speed=5000',
        'https://a.com/4 | view=read | speed=fast',
        'https://forum.example/t/1 | view=card',
        '[speed 200 wpm]',
      ].join('\n'),
    );
    expect(r.problems.map((p) => [p.line, p.message])).toEqual([
      [1, '[speed 200]: expected a number and wpm or px/s, like [speed 200 wpm]'],
      [2, "t= doesn't apply to view=read (ignored)"],
      [2, 'speed=: view=read takes words per minute (wpm) (ignored)'],
      [3, 'speed= only applies to view=read and view=scroll (ignored)'],
      [4, 'speed=5000: expected between 1 and 2000 px/s (ignored)'],
      [5, 'speed=fast: expected a number, like speed=200 (wpm) or speed=40 (px/s)'],
      [7, '[speed …] goes before the first entry; use speed= on an entry (ignored)'],
    ]);
    expect(r.entries[0]!.startS).toBeNull();
    expect(r.entries.map((e) => e.speed)).toEqual([null, null, null, null, null]);
  });

  it('takes a playlist-wide [view read]', () => {
    const r = compile('[view read]\nhttps://a.com/1\nhttps://www.youtube.com/watch?v=a | view=video');
    expect(r.entries.map((e) => e.view)).toEqual(['read', 'video']);
    expect(parseLine('[Speed 40 px/s]')).toEqual({ kind: 'speed', raw: '[Speed 40 px/s]', value: '40 px/s' });
  });
});

describe('end times, [shuffle] and [loop]', () => {
  const MIX = [
    '[shuffle]',
    'https://a.com/1 | One | t=1:00 | end=2:30',
    'https://a.com/2 | Two | t=30 | dur=45s',
    'https://a.com/3 | Three | dur=1m',
    'https://a.com/4 | Four',
    '[ads]',
    '  [img cats]',
    '[loop]',
    '',
  ].join('\n');

  it('round-trips and compiles', () => {
    expect(serializePlaylist(parsePlaylist(MIX))).toBe(MIX);
    const r = compilePlaylist(parsePlaylist(MIX));
    expect(r.problems).toEqual([]);
    expect(r.shuffle).toBe(true);
    expect(r.loop).toBe(true);
    expect(r.entries.map((e) => [e.startS, e.endS])).toEqual([
      [60, 150],
      [30, 75],
      [null, 60],
      [null, null],
    ]);
    // [loop] doesn't close the last entry's [ads] block.
    expect(r.entries[3]!.ads).toEqual([{ kind: 'img', keyword: 'cats', durationS: null }]);
  });

  it('is off without the lines', () => {
    const r = compilePlaylist(parsePlaylist('https://a.com/1'));
    expect([r.shuffle, r.loop]).toEqual([false, false]);
    expect(compilePlaylist(parsePlaylist('[loop]')).loop).toBe(false);
  });

  it('flags end= with dur=, bad times and ends before the start', () => {
    const r = compilePlaylist(
      parsePlaylist(
        [
          'https://a.com/1 | end=2:00 | dur=10',
          'https://a.com/2 | t=90 | end=1:00',
          'https://a.com/3 | end=soon',
          'https://a.com/4 | dur=0',
          'https://a.com/5 | dur=later',
        ].join('\n'),
      ),
    );
    expect(r.entries.map((e) => e.endS)).toEqual([120, null, null, null, null]);
    expect(r.problems).toEqual([
      { line: 1, message: 'end= and dur= both given; using end=2:00' },
      { line: 2, message: 'end=1:00 is not after the start time (ignored)' },
      { line: 3, message: 'end=soon is not a timestamp' },
      { line: 4, message: 'dur=0 must be more than 0 seconds (ignored)' },
      { line: 5, message: 'dur=later is not a duration' },
    ]);
  });

  it('flags [shuffle] after the first entry and [loop] before the last', () => {
    const r = compilePlaylist(parsePlaylist('https://a.com/1\n[SHUFFLE]\n[Loop]\nhttps://a.com/2'));
    expect(r.problems).toEqual([
      { line: 2, message: '[shuffle] goes before the first entry (ignored)' },
      { line: 3, message: '[loop] goes after the last entry (ignored)' },
    ]);
    expect([r.shuffle, r.loop]).toEqual([false, false]);
  });
});

describe('vol=', () => {
  it('reads a percentage as 0–1', () => {
    expect(parseVolume('60')).toBe(0.6);
    expect(parseVolume('60%')).toBe(0.6);
    expect(parseVolume(' 0 ')).toBe(0);
    expect(parseVolume('100')).toBe(1);
    expect(parseVolume('101')).toBeNull();
    expect(parseVolume('loud')).toBeNull();
    expect(formatVolume(0.6000000001)).toBe('60');
  });

  it('gives entries their volume, and flags a bad one', () => {
    const { entries, problems } = compilePlaylist(parsePlaylist('https://a.com/x | vol=40\nhttps://a.com/y | vol=loud\nhttps://a.com/z'));
    expect(entries.map((e) => e.volume)).toEqual([0.4, null, null]);
    expect(problems).toEqual([{ line: 2, message: 'vol=loud: expected 0 to 100, like vol=60' }]);
  });
});

describe('edits', () => {
  it('sets an option on one entry: in place, else at the end, null removes it', () => {
    const text = 'https://a.com/x | Title | vol=20 | t=5\n  https://a.com/y | Other\n';
    const set = serializePlaylist(withEntryOption(parsePlaylist(text), 0, 'vol', '60'));
    expect(set).toBe('https://a.com/x | Title | vol=60 | t=5\n  https://a.com/y | Other\n');
    const added = serializePlaylist(withEntryOption(parsePlaylist(text), 1, 'vol', '60'));
    expect(added).toBe('https://a.com/x | Title | vol=20 | t=5\n  https://a.com/y | Other | vol=60\n');
    const removed = serializePlaylist(withEntryOption(parsePlaylist(text), 0, 'vol', null));
    expect(removed).toBe('https://a.com/x | Title | t=5\n  https://a.com/y | Other\n');
    const dupes = serializePlaylist(withEntryOption(parsePlaylist('https://a.com/x | vol=1 | vol=2'), 0, 'vol', '3'));
    expect(dupes).toBe('https://a.com/x | vol=3');
  });

  it('retitles one entry and leaves every other line untouched', () => {
    const doc = withEntryTitle(parsePlaylist(SAMPLE), 1, 'Renamed');
    const out = serializePlaylist(doc);
    expect(out).toBe(SAMPLE.replace('https://vimeo.com/123 | Another Title', 'https://vimeo.com/123 | Renamed'));
  });

  it('keeps indentation and options when retitling', () => {
    const doc = withEntryTitle(parsePlaylist('  https://a.com/x | Old | t=5\n'), 0, null);
    expect(serializePlaylist(doc)).toBe('  https://a.com/x | t=5\n');
  });

  it('never lets a title read back as an option or span lines', () => {
    const doc = withEntryTitle(parsePlaylist('https://a.com/x'), 0, 'a=b\nc');
    const reparsed = compilePlaylist(parsePlaylist(serializePlaylist(doc)));
    expect(reparsed.entries[0]!.title).toBe('a = b c');
  });

  it('appends entries after a blank line', () => {
    expect(serializePlaylist(appendEntry(parsePlaylist('https://a.com/1\n'), 'https://a.com/2', 'Two'))).toBe(
      'https://a.com/1\n\nhttps://a.com/2 | Two\n',
    );
    expect(serializePlaylist(appendEntry(parsePlaylist(''), 'https://a.com/2', null))).toBe('https://a.com/2\n');
    expect(() => appendEntry(parsePlaylist(''), 'chrome://settings', null)).toThrow();
  });

  it('removes entries with their own blocks, keeping comments and [loop]', () => {
    const text = [
      '[ads]',
      '  [img cats]',
      '',
      'https://a.com/1 | One',
      '[ads]',
      '  5: Own quote',
      '# about two',
      '',
      'https://a.com/2 | Two',
      '',
      'https://a.com/3 | Three',
      '[show]',
      '  [img night]',
      '[loop]',
      '',
    ].join('\n');
    const out = (gone: number[]) => serializePlaylist(withoutEntries(parsePlaylist(text), new Set(gone)));
    expect(out([0])).toBe(['[ads]', '  [img cats]', '', '# about two', '', 'https://a.com/2 | Two', '', 'https://a.com/3 | Three', '[show]', '  [img night]', '[loop]', ''].join('\n'));
    expect(out([1])).toBe(text.replace('https://a.com/2 | Two\n\n', ''));
    expect(out([2])).toBe(text.replace('\nhttps://a.com/3 | Three\n[show]\n  [img night]', ''));
    expect(out([])).toBe(text);
    const all = compilePlaylist(withoutEntries(parsePlaylist(text), new Set([0, 1, 2])));
    expect(all.entries).toEqual([]);
  });

  it('drops the blank lines before an entry removed at the end', () => {
    const doc = withoutEntries(parsePlaylist('https://a.com/1\n\nhttps://a.com/2\n'), new Set([1]));
    expect(serializePlaylist(doc)).toBe('https://a.com/1\n');
  });

  it('renders entries', () => {
    expect(renderEntry('https://a.com', 'T', [{ key: 't', value: '5' }], '  ')).toBe('  https://a.com | T | t=5');
  });
});

describe('parseTimestamp', () => {
  it.each([
    ['200', 200],
    ['200s', 200],
    ['1.5', 1.5],
    ['1:37', 97],
    ['1:02:03', 3723],
    ['1h2m3s', 3723],
    ['2m', 120],
    ['1h', 3600],
    [' 90 ', 90],
  ])('%s → %s', (text, seconds) => {
    expect(parseTimestamp(text)).toBe(seconds);
  });

  it.each(['', 'soon', '1:60', '1::2', 'h', '-5', '1m2h'])('rejects %j', (text) => {
    expect(parseTimestamp(text)).toBeNull();
  });
});
