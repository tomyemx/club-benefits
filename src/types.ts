/** A benefit as a source page presents it, before any interpretation. */
export interface RawOffer {
  club: ClubId;
  /** The source's own stable id for the benefit (Amex/Isracard: BenefitId). */
  sourceOfferKey: string;
  /** Set when this benefit is a tier variant listed under a parent benefit. */
  parentKey: string | null;
  name: string;
  /** Plain text, HTML stripped. */
  conditions: string;
  category: string | null;
  /** Absolute URL of the benefit on the club's own site. */
  url: string;
  outOfStock: boolean;
  /**
   * A home-page tile (Categories[].HotBenefits[]) that carries only a short
   * label. The full listing from a category page replaces it.
   */
  teaser?: boolean;
}

export type ClubId = 'amex' | 'isracard';

export type OfferType =
  | 'percent'
  | 'fixed_off'
  | 'fixed_price'
  | 'bogo'
  | 'free_item'
  | 'voucher'
  | 'other';

/** The closed schema every extractor (rules today, an LLM later) must fill. */
export interface ExtractedTerms {
  merchantRaw: string | null;
  type: OfferType;
  percent: number | null;
  amountOff: number | null;
  /** What the member pays (fixed_price, voucher). */
  price: number | null;
  /** The regular price when the offer states it ("במקום 31 ש"ח"). */
  regularPrice: number | null;
  /** A voucher's face value ("בשווי 200"). */
  faceValue: number | null;
  minSpend: number | null;
  pointsCost: number | null;
  /** Points are required but the amount isn't stated (parent listings). */
  pointsRequired: boolean;
  requiresBonus: boolean;
  /** "עד N" - the headline is a ceiling, not the deal. */
  upTo: boolean;
  /** "החל מ" - the headline is a floor price. */
  fromPrice: boolean;
  /** More than one benefit in one listing ("... וגם ..."). */
  multi: boolean;
  /** Limited to a card tier (Platinum, Centurion, Gold, FlyCard...). */
  tierRestricted: boolean;
  noStacking: boolean;
  status: 'parsed' | 'needs_review';
  /** Why the extractor could not finish, when status is needs_review. */
  reviewReason: string | null;
}

export interface Extractor {
  readonly name: string;
  extract(offer: RawOffer, parent: RawOffer | null): ExtractedTerms;
}
