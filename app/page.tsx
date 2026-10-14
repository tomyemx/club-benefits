import { splitName } from '../src/extract/rules.js';
import { foldName } from '../src/merchants/normalize.js';
import { bestFor, clubStatus, describeAssumption, merchantNames, topDeals, type RankedOffer } from '../src/rank/best.js';
import type { Badge } from '../src/rank/score.js';
import type { ClubId } from '../src/types.js';
import { aliases, baselines, db } from './data';

export const dynamic = 'force-dynamic';

const CLUBS: { id: ClubId; name: string; enabled: boolean; note?: string }[] = [
  { id: 'amex', name: 'אמריקן אקספרס', enabled: true },
  { id: 'isracard', name: 'ישראכרט', enabled: false, note: 'בבדיקה' },
];
const CLUB_NAME = Object.fromEntries(CLUBS.map((c) => [c.id, c.name])) as Record<ClubId, string>;

const BADGE: Record<Badge, { label: string; hint: string }> = {
  High: { label: 'אמינות גבוהה', hint: 'נבדק ב-14 הימים האחרונים, ההטבה מנוסחת במפורש' },
  Medium: { label: 'אמינות בינונית', hint: 'תנאי אחד חסר: ישן מ-14 יום, או ניסוח כללי' },
  Low: { label: 'אמינות נמוכה', hint: '"עד", ישן מ-60 יום, או שאין מספיק נתונים להערכה' },
};

type Search = { q?: string; club?: string | string[]; pv?: string };

function selectedClubs(raw: Search['club']): ClubId[] {
  const enabled = CLUBS.filter((c) => c.enabled).map((c) => c.id);
  const asked = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((c): c is ClubId => enabled.includes(c as ClubId));
  return asked.length ? asked : enabled;
}

const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Asia/Jerusalem' });

function shekels(x: number): string {
  return `${x.toLocaleString('he-IL', { maximumFractionDigits: x < 10 ? 1 : 0 })} ₪`;
}

/** How the estimate was reached, in one line: value × the factors that cut it. */
function breakdown(o: RankedOffer): string | null {
  const s = o.score;
  if (s.value == null) return null;
  const parts = [`שווי ${shekels(s.value)}`, `× ${s.pValid.toFixed(2)} סיכוי שההטבה עדיין בתוקף`];
  if (s.pApplicable < 1) parts.push(`× ${s.pApplicable} כי לא בטוח שהיא חלה עליך`);
  if (s.haircut < 1) parts.push(`× ${s.haircut} כי הניסוח כללי`);
  return parts.join(' ');
}

/** The offer line without the merchant name the card already shows above it. */
function offerText(o: RankedOffer): string {
  const { merchant, offer } = splitName(o.name);
  return merchant && foldName(merchant) === foldName(o.merchant) ? offer : o.name;
}

function OfferCard({ o, showMerchant }: { o: RankedOffer; showMerchant: boolean }) {
  const s = o.score;
  const valued = s.expected != null;
  return (
    <li className="card">
      <div className="value" aria-label={valued ? `חיסכון משוער: ${shekels(s.expected!)}` : 'לא ניתן להעריך'}>
        {valued ? (
          <bdi>
            <span className="approx">כ-</span>
            {shekels(s.expected!)}
          </bdi>
        ) : (
          <span className="unvalued">לא ניתן להעריך</span>
        )}
      </div>
      <div className="body">
        {showMerchant && (
          <a className="merchant" href={`/?q=${encodeURIComponent(o.merchant)}`}>
            {o.merchant}
          </a>
        )}
        <p className="name">{showMerchant ? offerText(o) : o.name}</p>
        <ul className="chips" aria-label="פרטים">
          <li className={`chip badge-${s.badge.toLowerCase()}`} title={BADGE[s.badge].hint}>
            {BADGE[s.badge].label}
          </li>
          <li className="chip">{CLUB_NAME[o.club]}</li>
          {o.pointsCost ? <li className="chip">{o.pointsCost.toLocaleString('he-IL')} נקודות</li> : null}
          {!o.pointsCost && o.pointsRequired ? <li className="chip">דורש נקודות</li> : null}
          {o.requiresBonus ? <li className="chip">דורש הטבת בונוס</li> : null}
          {o.tierRestricted ? <li className="chip">לדרגת כרטיס מסוימת</li> : null}
        </ul>
        {valued ? (
          <p className="assumption">
            {breakdown(o)}
            {o.assumption ? `, ${describeAssumption(o.assumption, 'he')}` : ''}
          </p>
        ) : null}
        <p className="meta">
          <a href={o.url} target="_blank" rel="noopener noreferrer">
            לפרטים באתר המועדון
          </a>
          <span aria-hidden="true"> · </span>
          <span>נבדק {dateFmt.format(o.lastSeen)}</span>
        </p>
      </div>
    </li>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 80);
  const clubs = selectedClubs(params.club);
  const pv = Math.max(0, Math.min(1, Number(params.pv) || 0));
  const sql = db();
  const base = baselines();

  const [results, deals, names, status] = await Promise.all([
    q ? bestFor(sql, q, aliases(), base, { clubs, pointValue: pv }) : Promise.resolve(null),
    q ? Promise.resolve(null) : topDeals(sql, base, { clubs, pointValue: pv, limit: 12 }),
    merchantNames(sql, clubs),
    clubStatus(sql),
  ]);

  return (
    <main>
      <header>
        <h1>איפה הכי משתלם?</h1>
        <p className="lead">הטבות המועדונים שלך, מדורגות לפי חיסכון משוער בשקלים.</p>
      </header>

      <form className="search" method="get" role="search">
        <label htmlFor="q">בית עסק</label>
        <div className="row">
          <input id="q" name="q" type="search" list="merchants" defaultValue={q} placeholder="למשל: סינמה סיטי" autoComplete="off" />
          <button type="submit">חיפוש</button>
        </div>
        <datalist id="merchants">
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <fieldset>
          <legend>המועדונים שלי</legend>
          {CLUBS.map((c) => (
            <label key={c.id} className={c.enabled ? '' : 'disabled'}>
              <input type="checkbox" name="club" value={c.id} defaultChecked={c.enabled && clubs.includes(c.id)} disabled={!c.enabled} />
              {c.name}
              {c.note ? <span className="note"> ({c.note})</span> : null}
            </label>
          ))}
        </fieldset>
        <details>
          <summary>שווי נקודה</summary>
          <label htmlFor="pv">כמה שווה לך נקודה, בשקלים</label>
          <input id="pv" name="pv" type="number" min="0" max="1" step="0.01" defaultValue={pv || ''} placeholder="0" inputMode="decimal" />
          <p className="hint">בלי ערך, הנקודות מוצגות ולא מנוכות מהחיסכון.</p>
        </details>
      </form>

      {results && (
        <section aria-labelledby="results-title">
          <h2 id="results-title">
            {results.length ? `${results.length} הטבות עבור ` : 'לא נמצאו הטבות פעילות עבור '}
            <bdi>"{q}"</bdi>
          </h2>
          {results.length === 0 && <p className="empty">נסו שם קצר יותר, או בחרו מהרשימה שנפתחת בתיבת החיפוש.</p>}
          <ol className="cards">
            {results.map((o, i) => (
              <OfferCard key={`${o.club}-${o.url}-${i}`} o={o} showMerchant={false} />
            ))}
          </ol>
        </section>
      )}

      {deals && (
        <section aria-labelledby="deals-title">
          <h2 id="deals-title">שווה לבדוק</h2>
          <p className="sub">ההטבה הטובה ביותר של כל בית עסק, מבין ההטבות שמציינות במפורש כמה חוסכים.</p>
          <ol className="cards">
            {deals.map((o, i) => (
              <OfferCard key={`${o.club}-${o.url}-${i}`} o={o} showMerchant />
            ))}
          </ol>
        </section>
      )}

      <footer>
        <ul className="status">
          {status
            .filter((s) => CLUBS.find((c) => c.id === s.club)?.enabled)
            .map((s) => (
              <li key={s.club}>
                {CLUB_NAME[s.club]}: {s.lastFinishedAt ? `נבדק ${dateFmt.format(s.lastFinishedAt)}` : 'טרם נבדק'}, {s.liveOffers} הטבות
                {s.needsReview ? `, ${s.needsReview} ממתינות לבדיקה ידנית` : ''}
                {s.lastFinishedAt && !s.lastComplete ? ' (הבדיקה האחרונה לא הושלמה)' : ''}
              </li>
            ))}
        </ul>
        <p>
          הערכות בלבד: התנאים המחייבים הם של המועדון. המידע נאסף מעמודים ציבוריים לשימוש אישי. הנחות החישוב (גודל סל, מחיר כרטיס)
          ניתנות לעריכה בקובץ <code>data/category-baselines.json</code>.
        </p>
      </footer>
    </main>
  );
}
