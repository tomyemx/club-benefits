import type { ExtractedTerms, Extractor, OfferType, RawOffer } from '../types.js';

/**
 * Rule-based extraction for the Amex/Isracard naming convention:
 * "<merchant> - <offer>", with tier variants listed as children whose
 * names often lead with the offer ("1+1 לכרטיס תמורת 290 נקודות לספארי").
 * Anything the rules can't read is marked needs_review, never guessed.
 */

const SHEKEL = '₪';
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)';

/** Fold the many ways the sources write "shekel" into one symbol. */
export function normalizeText(s: string): string {
  return s
    .replace(/ש\s*["'״׳]{1,2}\s*ח/g, SHEKEL)
    .replace(/שקלים|שקל/g, SHEKEL)
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function num(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function match(text: string, re: RegExp): RegExpMatchArray | null {
  return text.match(re);
}

// A segment that begins the offer part of a name.
const OFFER_SEGMENT =
  /\d|%|אחוז|הנחה|כרטיס|1\s*(\+|פלוס)\s*1|חינם|במחיר|מחיר מיוחד|הטבה|הטבת|שובר|ארוחת|מנוי|משלמים|כניסה|ביטוח|חברות|תוכנית|תכנית|ספר |מגוון/;

// One-letter Hebrew prefixes written with a dash: "ב- 99", "ל-6", "ו-FlyCard".
const PREFIX_LETTERS = new Set(['ב', 'ל', 'מ', 'ו', 'ה', 'כ', 'ש']);

/**
 * Split on dashes that separate name parts. A dash separates when it has
 * whitespace before it ("ברנר -50", "סופר - פארם"), or whitespace after it
 * and a real word before it ("GRAY- הנחה"). A dash glued on both sides
 * ("בא-לגן") or after a one-letter prefix ("ב- 99") does not.
 */
function splitOnSeparators(text: string): string[] {
  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '-') continue;
    const before = i > 0 && /\s/.test(text[i - 1]!);
    const after = i + 1 < text.length && /\s/.test(text[i + 1]!);
    let separates = before;
    if (!before && after) {
      const word = text.slice(last, i).split(/\s+/).pop() ?? '';
      separates = !(word.length <= 1 || PREFIX_LETTERS.has(word));
    }
    if (separates) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Program banners that stand where a merchant name would. */
const PROGRAM_BANNER = /^הטבה ללקוחות ת[ו]?כנית GOLD$/i;

/**
 * Split a name into merchant and offer text. Returns merchant null when
 * the name has no separator or the offer part can't be located.
 */
export function splitName(name: string): { merchant: string | null; offer: string } {
  const text = normalizeText(name);
  const parts = splitOnSeparators(text);
  if (parts.length < 2) return { merchant: null, offer: text };
  for (let i = 1; i < parts.length; i++) {
    const seg = (parts[i] ?? '').replace(/\b20\d\d\b/g, '');
    if (OFFER_SEGMENT.test(seg)) {
      const merchant = parts
        .slice(0, i)
        .join(' - ')
        .replace(/\s*\b20\d\d\b\s*$/, '')
        .trim();
      if (PROGRAM_BANNER.test(merchant)) return { merchant: null, offer: parts.slice(i).join(' - ') };
      return { merchant: merchant || null, offer: parts.slice(i).join(' - ') };
    }
  }
  return { merchant: null, offer: text };
}

const TIER =
  /ללקוחות\s+(?:ה)?(?:פלטינה|פלטינום|סנטוריון|גולד|GOLD|Platinum|Centurion|FlyCard|TIME OFF|ת[ו]?כנית GOLD)|סנטוריון|פלטינה ו|ו-FlyCard/i;

// Start of a price phrase. JavaScript's \b ignores Hebrew letters, so word
// starts are written as (?:^|[\s(]) instead.
const WS = '(?:^|[\\s(])';

export function extractTerms(offerText: string, conditions = ''): Omit<ExtractedTerms, 'merchantRaw' | 'status' | 'reviewReason'> {
  const t = normalizeText(offerText);
  const c = normalizeText(conditions);
  const both = `${t} | ${c}`;

  const points = match(t, new RegExp(`(?:בתוספת|תמורת)\\s*${NUM}\\s*נקודות`));
  const pointsRequired = !points && /(?:בתוספת|תמורת)\s*נקודות|משלמים בנקודות/.test(t);
  const requiresBonus = /הטבת בונוס/.test(t);
  const upTo = new RegExp(`עד\\s*${NUM}\\s*(?:${SHEKEL}|%|אחוז)`).test(t);
  const fromPrice = /החל מ/.test(t);
  const multi = /\sוגם\s|\sו-\s*\d/.test(t);
  const tierRestricted = TIER.test(t);
  const noStacking = /ללא כפל/.test(both);
  const minSpendM = match(both, new RegExp(`(?:ברכישה|בקנייה|בקניה|בהזמנה)\\s*(?:מעל|מ-?|בסך)\\s*${NUM}\\s*${SHEKEL}`));
  const regularM = match(t, new RegExp(`במקום\\s*${NUM}\\s*${SHEKEL}`));
  const voucherM = match(t, new RegExp(`בשווי\\s*${NUM}\\s*${SHEKEL}\\s*ב-?\\s*${NUM}\\s*${SHEKEL}`));
  const fixedOffM =
    match(t, new RegExp(`${NUM}\\s*${SHEKEL}\\s*הנחה`)) ??
    match(t, new RegExp(`הנחה\\s*(?:של\\s*)?${NUM}\\s*${SHEKEL}`)) ??
    // A statement credit: "קרדיט רבעוני בסך 100 ₪ (400 ₪ שנתי)".
    match(t, new RegExp(`קרדיט[^|]*?בסך\\s*${NUM}\\s*${SHEKEL}`));
  const percentM = match(t, new RegExp(`${NUM}\\s*(?:%|אחוז)`));
  const bogo = /1\s*(?:\+|פלוס)\s*1|חינם ברכישת|מבוגר חינם/.test(t);
  // A price the member pays: "כרטיס ב 49 ₪", "ב- 75 ₪", "במחיר 109 ₪",
  // "החל מ 59 ₪", or a leading "59 ₪ לכרטיס".
  const priceM =
    match(t, new RegExp(`${WS}(?:ב-?|במחיר|החל מ-?|מ-)\\s*${NUM}\\s*${SHEKEL}`)) ??
    match(t, new RegExp(`${WS}${NUM}\\s*${SHEKEL}\\s*ל`));
  const free = /ללא עלות|חינם|מתנה/.test(t);

  let type: OfferType = 'other';
  let percent: number | null = null;
  let amountOff: number | null = null;
  let price: number | null = null;
  let faceValue: number | null = null;
  const regularPrice = regularM ? num(regularM[1]!) : null;

  if (voucherM) {
    type = 'voucher';
    faceValue = num(voucherM[1]!);
    price = num(voucherM[2]!);
  } else if (fixedOffM) {
    type = 'fixed_off';
    amountOff = num(fixedOffM[1]!);
  } else if (percentM) {
    type = 'percent';
    percent = num(percentM[1]!);
  } else if (bogo) {
    type = 'bogo';
  } else if (priceM) {
    type = 'fixed_price';
    price = num(priceM[1]!);
  } else if (free) {
    type = 'free_item';
  }

  return {
    type,
    percent,
    amountOff,
    price,
    regularPrice,
    faceValue,
    minSpend: minSpendM ? num(minSpendM[1]!) : null,
    pointsCost: points ? num(points[1]!) : null,
    pointsRequired,
    requiresBonus,
    upTo,
    fromPrice,
    multi,
    tierRestricted,
    noStacking,
  };
}

export const rulesExtractor: Extractor = {
  name: 'rules-v1',
  extract(offer: RawOffer, parent: RawOffer | null): ExtractedTerms {
    const own = splitName(offer.name);
    // A tier variant inherits its parent's merchant; its own name usually
    // leads with the offer and names the merchant somewhere in the middle.
    const merchantRaw = parent ? splitName(parent.name).merchant ?? own.merchant : own.merchant;
    const offerText = parent && !own.merchant ? normalizeText(offer.name) : own.offer;
    const terms = extractTerms(offerText, offer.conditions);

    let reviewReason: string | null = null;
    if (!merchantRaw) reviewReason = 'no merchant in name';
    else if (terms.type === 'other') reviewReason = 'offer type not recognised';

    return { merchantRaw, ...terms, status: reviewReason ? 'needs_review' : 'parsed', reviewReason };
  },
};
