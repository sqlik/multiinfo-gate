import { gsmSlotsFor } from '../../text/gsm-alphabet.ts';
import { measureText, type Measurement } from '../../text/measure.ts';
import { segmentText, type Segmentation } from '../../text/segment.ts';
import { esc } from './layout.ts';

/** Odmiana: 1 segment, 2-4 segmenty, 5+ segmentów (z wyjątkiem 12-14). */
export function segmentsWord(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return '1 segment';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} segmenty`;
  return `${n} segmentów`;
}

function freeSlotsWord(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (n === 1) return '1 wolne miejsce';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} wolne miejsca`;
  return `${n} wolnych miejsc`;
}

/** Liczba miejsc zajętych w każdej części: wszystkie pełne poza ostatnią. */
function slotsPerPart(s: Segmentation): number[] {
  return Array.from({ length: s.parts }, (_, i) =>
    (i === s.parts - 1 ? s.slotsPerPart - s.slotsRemaining : s.slotsPerPart));
}

/** Linijka: tekst z zaznaczonymi znakami rozszerzonymi i granicami części. */
function ruler(text: string, m: Measurement, s: Segmentation): string {
  const cuts = new Set(s.boundaries);
  let html = '';
  let part = 1;
  let index = 0;
  let shaded = false;
  for (const ch of text) {
    if (cuts.has(index)) {
      if (shaded) html += '</span>';
      part += 1;
      html += `<span class="cut"><i>${part}</i></span>`;
      shaded = part % 2 === 0;
      if (shaded) html += '<span class="s2">';
    }
    html += m.encoding === 'gsm' && gsmSlotsFor(ch) === 2 ? `<span class="x2">${esc(ch)}</span>` : esc(ch);
    index += ch.length;
  }
  if (shaded) html += '</span>';
  return html;
}

/** Słowo, w którym wypada granica, albo null, gdy granica trafia na białe znaki. */
function wordAt(text: string, boundary: number): string | null {
  const before = text[boundary - 1] ?? '';
  const after = text[boundary] ?? '';
  if (!/\S/.test(before) || !/\S/.test(after)) return null;
  let start = boundary;
  while (start > 0 && /\S/.test(text[start - 1]!)) start -= 1;
  let end = boundary;
  while (end < text.length && /\S/.test(text[end]!)) end += 1;
  return text.slice(start, end);
}

function note(tone: 'signal' | 'wait' | 'muted' | 'fail', html: string): string {
  return `<div class="note"><div class="sq" style="background: var(--${tone});"></div><div>${html}</div></div>`;
}

function notes(text: string, m: Measurement, s: Segmentation): string[] {
  const out: string[] = [];

  if (m.encoding === 'gsm') {
    const extended = [...text].filter((ch) => gsmSlotsFor(ch) === 2).length;
    if (extended > 0) {
      out.push(note('signal', `${esc(extended)} ${extended === 1 ? 'znak jest' : 'znaki są'} w alfabecie GSM-7 `
        + `liczone podwójnie - ${extended === 1 ? 'zajmuje' : 'zajmują'} ${esc(extended * 2)} miejsc zamiast ${esc(extended)}.`));
    }
  }

  const split = s.boundaries.map((b) => wordAt(text, b)).filter((w): w is string => w !== null);
  if (split.length > 0) {
    out.push(note('wait', `Granica segmentu wypada wewnątrz słowa „${esc(split[0]!)}”. Telefony sklejają części `
      + 'poprawnie, ale jeśli któraś część nie dotrze, odbiorca zobaczy urwane zdanie.'));
  }

  if (s.slotsRemaining > 0) {
    out.push(note('muted', `${s.parts === 1 ? 'Zostało' : 'W ostatnim segmencie zostało'} `
      + `<strong>${esc(freeSlotsWord(s.slotsRemaining))}</strong> - dopisanie tekstu nic tu nie kosztuje.`));
  }

  if (m.encoding === 'gsm') {
    const unicode = measureText(text, 'unicode');
    let after: string;
    try {
      after = segmentsWord(segmentText(text, unicode, 9).parts);
    } catch {
      after = 'ponad 9 segmentów';
    }
    out.push(note('fail', 'Jeden polski znak diakrytyczny przełączy kodowanie na UCS-2, gdzie limit to 70 znaków '
      + `w jednej części i 67 w każdej z wielu - ta sama treść zajmie wtedy <strong>${esc(after)}</strong>.`));
  }

  return out;
}

/** Panel „Podgląd segmentów” z makiety: linijka, pasek na każdą część, uwagi, które mają zastosowanie. */
export function segmentPanel(text: string, m: Measurement, s: Segmentation): string {
  const rows = slotsPerPart(s).map((used, i) => {
    const full = used === s.slotsPerPart;
    return `<div class="segrow"${i === s.parts - 1 ? ' style="padding-bottom: 14px;"' : ''}>
      <span class="segno">${i + 1}</span>
      <div class="meter"><b style="width: ${((used / s.slotsPerPart) * 100).toFixed(1)}%;"></b></div>
      <div class="m dim" style="width: 190px; text-align: right;">${esc(used)} / ${esc(s.slotsPerPart)} miejsc${full ? ' - pełny' : ''}</div>
    </div>`;
  }).join('');

  const extra = notes(text, m, s);
  return `<div class="panel">
    <div class="panel-h">
      <div class="lab">Podgląd segmentów</div>
      <div class="m dim">${esc(m.characters)} znaków · ${esc(m.slots)} miejsc ${esc(m.encoding === 'gsm' ? 'GSM-7' : 'UCS-2')}
        · ${esc(segmentsWord(s.parts))}</div>
    </div>
    <div class="ruler">${ruler(text, m, s)}</div>
    ${rows}
    ${extra.length === 0 ? '' : `<div class="notes">${extra.join('')}</div>`}
  </div>`;
}
