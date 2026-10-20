import {
  ARCHITECTURE,
  COLOURS,
  CONTEXT_PRODUCTS,
  CONTEXTUAL_MAKERS,
  DESCRIPTORS,
  DESIGN,
  FASHION,
  FILM,
  FILM_PHRASES,
  FOOD,
  FOOD_EVIDENCE,
  FOOD_NAME_ENDINGS,
  FOOD_PHRASES,
  GARMENTS,
  GENERIC_NOUNS,
  GENERIC_QUALIFIERS,
  MAKERS,
  MATERIALS,
  MUSIC,
  MUSIC_PHRASES,
  NATIONALITIES,
  SPORT_EQUIPMENT,
  SPORT_QUALIFIERS,
  STOP,
  STYLE_MOVEMENTS,
  foldText,
  hasPhrase,
  isNonLatin,
  nameTokens,
} from './lexicons';
import { ENGLISH_WORDS } from './english-words';
import {
  candidateNameKey,
  type VlmAnalysis,
  type VlmCandidate,
  type VlmDomain,
  type VlmEvidence,
  type VlmMergeContext,
  type VLM_CATEGORIES,
} from './types';

/**
 * Deterministic reading guardrails (docs/quality-plan.md §4, guard-v2).
 *
 * The model proposes; this module decides what may reach Qloo or the screen.
 * It is pure (no I/O, no clock, no randomness): the same reading always gets
 * the same decisions, and every decision names the rules that fired, so the
 * compiler can record them in the analysis trace for the inspector and the
 * scorer.
 *
 * Hold, then confirm: risky stage-1 claims (brands, names of places or works
 * that do not match the text read, low-certainty resemblances, styles read
 * off a sign) are held instead of published. Stage 2's verdict on a held
 * claim is binding because nothing was published from it; if stage 2 is off
 * or fails, held claims are dropped (fail closed). A card that is already
 * published is never removed (FAST-02): a stage-2 "unsupported" on it stays
 * an advisory veto.
 *
 * guard-v8 (docs/requalification-plan.md, round 3, "Publish by evidence
 * class, not by word list"): what may publish is decided by the class of
 * evidence a claim rests on and by what the claim is about, not by extending
 * closed word lists:
 *  - G-EVIDENCE: a stage-2 addition whose only support is "context" never
 *    publishes. A stage-1 claim on context publishes in the first section
 *    only with independent support: the different-family verifier's "yes"
 *    when vision_verify is on (verify.ts); with the verifier off (the
 *    default until Tune decides) it publishes as in guard-v7, because
 *    holding every context claim for stage 2 empties the first section
 *    (FAST-01, M15; docs/quality-plan.md §18);
 *  - a stage-2 "weak" or "unsupported" verdict on a held claim never
 *    publishes (guard-v7 published a weak style or tradition as a
 *    non-anchor resemblance);
 *  - G-PEOPLE-CLAIM: on a photo with people, a tradition or style claim
 *    whose subject is the people themselves (an occasion, an event, a role,
 *    a tradition, an identity or a style of the person; the model's own
 *    domain says so: "people" or "other", no thing domain) publishes only
 *    when it rests on read text. Clothing and objects still publish;
 *  - claims withheld this way are kept as private observations (action
 *    `observe`): recorded in the analysis trace for the inspector, never
 *    shown as a reference, a card or an observation;
 *  - a maker read in the photo ("BMW") is kept as a text-only brand
 *    reference when the longer model name it was claimed with was not read.
 * Every guard-v7 safety rule stays.
 *
 * guard-v10 (round-3 review, after the failed h50–h79 blind run; docs/quality-plan.md §18.20):
 *  - the headline (title, interpretation) passes the people test too: it may
 *    not name a relationship or role of the people, an occasion, team, league
 *    or unit on a photo with people, or a claim withheld as being about them;
 *    such a line is replaced (stage 1, and again at stage 2 with what stage 2
 *    shows: `headlineChanged`);
 *  - a claim about the people "rests on read text" only when the text names
 *    it (claimReadIn): the model's own evidence label is not enough;
 *  - a claim naming a relationship, role, occasion, team, league or unit of
 *    the people (PEOPLE_CLAIM_RE) is about them whatever type or domain the
 *    model filed it under (a backstop to the class rules, a closed list).
 *
 * guard-v11 (round 4, owner option C "hold until confirmed"; docs/quality-plan.md §19):
 *  - at stage 1, on a photo with people, every style or tradition claim is
 *    held for stage 2, unless it names a garment (GARMENTS) or a sport named
 *    alone (sportActivity); at stage 1, every style, tradition or place
 *    claim whose only support is context is held, with the same two
 *    exceptions. A held claim publishes only on a "supported" stage-2 verdict
 *    that passes the stage-2 rules; it was never shown, so stage 2's "weak"
 *    or "unsupported" retracts nothing (FAST-02 by construction). Objects,
 *    food, vehicles, brands (G-BRAND), places with read text or a
 *    distinctive form, and read text keep their stage-1 rules;
 *  - people presence (peopleShown) is read from the words of the title, the
 *    interpretation, the observations, the region labels and the claim names
 *    (people, relationship and presence words), never from the model's domain
 *    label alone;
 *  - read model: a brand claim whose model name was transcribed at stage 2
 *    ("Z4") but whose maker was not publishes the model name as written, as a
 *    text-only brand reference (readModel), the counterpart of readMaker;
 *  - brand residue keeps only the naming words of a brand claim (written with
 *    a capital or a digit), not its lower-case describing words, so
 *    "checkerboard slip-on sneakers" next to a held "Vans Old Skool
 *    checkerboard slip-on" is a garment, not the brand claim again;
 *  - a well-known artwork or building named by its title on its form
 *    (titledWork) is held at stage 1 as before (its capitalized title makes it
 *    brand-like) and publishes on a supported stage-2 verdict as a
 *    resemblance, without a transcription of its title.
 *
 * guard-v12 (round 4, after the model sweep; docs/quality-plan.md §19.8). Each rule by class:
 *  - one people test on every shown surface: on a photo with people, a "What
 *    caught your eye?" label with a people, relationship, role, presence or
 *    occasion word is dropped (G-SUBJECT tested role nouns only), and an
 *    observation that refers to a person (a people or presence word, a
 *    pronoun, "one wears") is not shown (personObservation);
 *  - a headline line in the first person or about instructions, prompts or the
 *    assistant (metaCommentary) is replaced by the neutral line;
 *  - G-BRAND's unknown-lead test no longer fires on a fashion or sport object
 *    named only with general English words (ENGLISH_WORDS, SCOWL 50) that the
 *    model did not read ("Checkerboard slip-on sneakers", "Bell sleeve
 *    dress"); a letter-shape compound ("T-shirt", "V-neck") is not a proper
 *    name;
 *  - the rules follow the vlm-quick-v3 prompt contract: a qualified garment or
 *    sport-equipment type (wornOrGear, qualifiedThingType) is neither G-GENERIC
 *    nor a play-style claim, whatever type the model gave it, and a sport named
 *    alone may arrive typed as a style; an art-domain claim whose only medium
 *    word is "painting" names the painting in the photo and is held for stage
 *    2 (paintingSubject) instead of being dropped;
 *  - titled works: a stage-2 "<Title> by <Creator>" whose title repeats a
 *    stage-1 work claim is that claim read twice and publishes as a
 *    resemblance; the creator appears only inside the work's name;
 *  - read text made of common words (a brand or a signage work whose naming
 *    words are all general English words, a place named by one) is visible
 *    text only, never a reference (commonWordsRead);
 *  - one depicted work per reading: a work title read at stage 2 next to a
 *    stage-1 work claim is a mention (a credit line), never a reference;
 *  - a stage-2 reading whose overall uncertainty is "high" confirms nothing:
 *    no held claim and no addition publishes from it.
 */
export const GUARDRAIL_VERSION = 'guard-v12';

/** Neutral analysis title when G-MEDIUM leaves too little of the model's title and nothing is publishable. */
export const NEUTRAL_TITLE = 'What stood out in your photo';
/** Neutral interpretation when G-MEDIUM leaves too little of the model's sentence. */
export const NEUTRAL_INTERPRETATION = 'A few references stood out in this photo.';
/**
 * guard-v10: the neutral title and interpretation that replace a headline line
 * claiming something about the people in a photo that shows people. They say
 * only that people are in it, which keeps that fact for stage 2's people test
 * (it reads the published headline) without the claim.
 */
export const NEUTRAL_PEOPLE_TITLE = 'People in your photo';
export const NEUTRAL_PEOPLE_INTERPRETATION = 'A few references stood out in this photo of people.';

/**
 * `observe` (guard-v8): the claim never publishes; it is kept only as a
 * private observation in the analysis trace (the inspector's "Reading
 * decisions"), for claims withheld by evidence class (context only, a weak or
 * unsupported stage-2 verdict, a claim about the people in the photo, a
 * verifier "no" or "unsure").
 */
export type GuardAction = 'publish' | 'hold' | 'demote' | 'drop' | 'observe';
export type GuardRule =
  | 'G-QUAL'
  | 'G-MEDIUM'
  | 'G-PERSON-ROLE'
  | 'G-IDENTITY'
  | 'G-STYLE-OF'
  | 'G-CUISINE-FOOD'
  | 'G-FLOOR'
  | 'G-DEPICTED'
  | 'G-GENERIC'
  | 'G-BRAND'
  | 'G-PLACE'
  | 'G-TEXT-ECHO'
  | 'G-LOWCERT'
  | 'G-ADDITION-FLOOR'
  | 'G-VERDICT'
  | 'G-BRAND-CORROBORATE'
  | 'G-CATEGORY'
  /**
   * guard-v4 (docs/requalification-plan.md decision 2): a brand or person name
   * that only the stage-2 reply contains, with every word transcribed, is
   * published as a text-only reference (note TEXT_ONLY_NOTE) instead of being
   * dropped as a single read.
   */
  | 'G-TEXT-ONLY'
  /** guard-v8: a claim whose only support is context waits for a second reading; never published on context alone. */
  | 'G-EVIDENCE'
  /** guard-v8: on a photo with people, a claim about the people themselves needs read text. */
  | 'G-PEOPLE-CLAIM'
  /** guard-v8: the independent verifier (vision_verify) answered "no" or "unsure", or could not answer: not published. */
  | 'G-VERIFY'
  // Additive (not candidate rules): visible_text and observation filters, counted in `dropped`.
  | 'G-VTEXT'
  | 'G-PERSON-OBS';

export interface GuardDecision {
  candidateId: string;
  /** The candidate's name; '[withheld]' when a person rule dropped it, so no name reaches the trace. */
  name: string;
  action: GuardAction;
  rules: GuardRule[];
  note?: string;
}

/** A candidate after the guardrails: domain and evidence are always filled (schema value or §4.4 inference). */
export type GuardedCandidate = VlmCandidate & { domain: VlmDomain; evidence: VlmEvidence };

type Category = (typeof VLM_CATEGORIES)[number];

export interface Stage1Guard {
  /** Publish-only candidates, sanitized (relation, categories, domain, evidence, tag query); demoted ones as observations. */
  analysis: VlmAnalysis;
  /** Claims kept back for stage-2 confirmation; never published, resolved or anchored before it. */
  held: VlmCandidate[];
  /** Generic objects kept only as `object` observations; never resolved or anchored. */
  demoted: VlmCandidate[];
  decisions: GuardDecision[];
  /** The title or the interpretation was rewritten by G-MEDIUM or (guard-v10) the people test. */
  titleChanged: boolean;
  /** Visible-text entries, observations and competing subjects removed (counts only; their text never reaches the trace). */
  dropped: { visibleText: number; observations: number; subjects: number };
}

export interface Stage2Guard {
  /** Held claims that passed stage 2, then additions that passed, in that order (to append after published cards). */
  publishNow: VlmCandidate[];
  /** Names of published stage-1 candidates stage 2 does not support: advisory only (certainty x 0.5), never removed. */
  advisoryVetoes: string[];
  /** Ids in publishNow that publish only as a resembling, non-anchor reference. Always empty since guard-v8 (a weak verdict never publishes). */
  nonAnchorIds: string[];
  /**
   * guard-v4: ids in publishNow that publish only as text-only references
   * (G-TEXT-ONLY): never resolved in Qloo, never anchors or signals, shown
   * with the text they were read from (their evidence_text).
   */
  textOnlyIds: string[];
  /**
   * Published candidates, then publishNow; sanitized visible text and observations; the published
   * title and interpretation, unless guard-v10's people test replaced them (`headlineChanged`).
   */
  analysis: VlmAnalysis;
  decisions: GuardDecision[];
  /**
   * guard-v10: stage 2 replaced the published title or interpretation because, with what stage 2
   * shows, it claims something about the people (G-PEOPLE-CLAIM on the headline). A retraction only.
   */
  headlineChanged: boolean;
  dropped: { visibleText: number; observations: number; subjects: number };
}

// ---- rule patterns (§4.2, exact) -------------------------------------------

/**
 * G-VTEXT: a visible-text entry that describes text instead of transcribing it.
 * guard-v9 (round-3 Tune, p05): "... labels in a non-Latin script" names the
 * script with a space ("in a <word> script"), which the guard-v5 hyphen form
 * ("Persian-script") missed; a name that merely contains the word ("Script
 * Fixture Coffee", "Manuscripts") is still a transcription.
 */
export const VTEXT_RE =
  /illegib|unreadabl|blur|placard|label cards?|resolution|characters are|text (is |on )|appears to|written in|licen[cs]e plate|number plate|registration|\blegible\b|transcri|\b\p{L}+-script\b|\bin (?:an? )?[\p{L}-]+(?: [\p{L}-]+)? script\b/iu;
/** The plan's list plus mouth/lips/teeth/grimace (the v2 smoke described "his mouth open mid-gesture"). */
export const PERSON_OBS_RE =
  /\b(hair|haired|bald|shaved|beard|moustache|mustache|face|facial|expression|smil\w*|frown\w*|grimac\w*|mouth|lips|teeth|serious|age[ds]?|young|elderly|middle-aged|teen\w*|skin|complexion|eyes|physique|build|body)\b/i;
/**
 * Medium words in a title or interpretation (G-MEDIUM): words that call the
 * photo a picture. guard-v3 adds artwork, nature morte, engraving,
 * lithograph, etching, woodcut and art/canvas prints. "Poster" is not one:
 * a poster is a physical subject people photograph (the film poster in the
 * held-out set), and its title is checked by the text rules instead.
 *
 * guard-v6 (requalification round 2): inflections of the medium words, not
 * only the noun. The blind run kept "… sports car photographed at dusk"
 * because only "photograph(s)" matched; now "photographed", "photography",
 * "photographic", "rendered", "renderings", "sketched", "watercolours",
 * "painterly", "gouache", "linocut", "hand-drawn" and the plurals match too
 * (at least everything the scorer counts as a medium word). "Painted" on a
 * craft, a building, a garment or a vehicle stays decoration (DECORATION_RE).
 *
 * guard-v7 (round-2 review): "engraved", "etched" and "water-colour" (any
 * hyphenation of watercolour) match as well. The list is closed: a medium
 * word it does not name still passes, so the scorer keeps its own copy.
 * "Photographic" before a physical product ("photographic film", "…paper",
 * "…plates", "…equipment") names the object in the photo, not the photo's
 * medium, and does not match.
 */
const PHOTOGRAPHIC_PRODUCT = String.raw`(?!ic[- ](?:film|films|paper|papers|plates?|equipment|gear|lens(?:es)?|chemicals?|enlargers?|flash(?:es)?|tripods?)\b)`;
export const MEDIUM_RE = new RegExp(
  String.raw`\b(still[- ]?lifes?|nature mortes?|paintings?|painted|painterly|illustrat\w*|drawings?|hand[- ]drawn|sketch\w*|render(?:s|ed|ings?)?|water[- ]?colou?r(?:s|ed)?|gouache|oil on canvas|vectors?|cartoon\w*|clip ?art|photograph${PHOTOGRAPHIC_PRODUCT}\w*|digital art|artworks?|engrav(?:ed|ings?)|lithograph\w*|etch(?:ed|ings?)|woodcuts?|linocuts?|woodblock prints?|(?:art|canvas|fine[- ]art|giclee|giclée) prints?)\b`,
  'i',
);
/**
 * Medium words in a candidate name or tag query: the headline words plus a
 * bare "print" or "canvas" ("Vanitas print"), which a headline may use for a
 * garment ("a leopard print coat"); in a candidate they are a medium unless
 * the domain is decorative.
 */
const CANDIDATE_MEDIUM_RE = new RegExp(`${MEDIUM_RE.source}|\\b(prints?|canvas(es)?)\\b`, 'i');
/**
 * "Painted", "print" and "canvas" name the medium of a picture, but on a
 * craft, a piece of furniture, a building, a garment or a vehicle they name
 * the decoration or the material ("hand-painted wooden stools", "batik
 * print", "canvas sneakers"). In those domains G-MEDIUM ignores them; every
 * other medium word still applies. guard-v7: "engraved" and "etched" (an
 * engraved silver ring, etched glass) are decoration there too.
 */
export const DECORATIVE_DOMAINS: ReadonlySet<string> = new Set(['craft', 'design', 'interior', 'architecture', 'fashion', 'vehicle']);
const DECORATION_RE = /\b(?:(?:hand[- ]?)?painted|(?:hand[- ]?|block[- ]?)?prints?|printed|canvas(?:es)?|(?:hand[- ]?)?engraved|etched)\b/gi;
/** G-MEDIUM test for a candidate name or tag query in its domain. */
export function hasMediumWord(text: string, domain?: string | null): boolean {
  return CANDIDATE_MEDIUM_RE.test(domain && DECORATIVE_DOMAINS.has(domain) ? text.replace(DECORATION_RE, ' ') : text);
}
/**
 * "Player" names a person except in a playback device ("record player", "DVD
 * players") or a "player piano"; the device forms are neither a role nor
 * people in the photo.
 */
const PLAYER = String.raw`(?<!\b(?:record|cd|dvd|blu-?ray|mp3|media|cassette|tape|vinyl|disc|minidisc)[- ])players?\b(?![- ]pianos?\b)`;
/**
 * guard-v7: role nouns that also name a thing, each without the thing: a Coach
 * bag or a coach (bus), a Singer sewing machine, a bowler hat, tempura
 * batter, a captain's chair, a water pitcher, a golf driver, a café racer, a
 * rider mower, a Land Rover Defender, boxer shorts or a boxer dog, a fighter
 * jet, Jockey underwear, a watch reference ("Ref. 5513"), the Champions League
 * and Champion sportswear.
 */
const OBJECT_ROLES = {
  coach: String.raw`coach(?:es|ing)?(?![- ](?:bags?|handbags?|purses?|wallets?|totes?|leather|bus(?:es)?|station|tours?|trips?|travel|house|lamps?|builders?|works)\b)`,
  singer: String.raw`singers?(?![- ](?:sewing|machines?|featherweight)\b)`,
  bowler: String.raw`bowlers?(?![- ]hats?\b)`,
  batter: String.raw`(?<!\b(?:tempura|pancake|beer|cake|crepe|crêpe|waffle|fritter|frying|light|thick|thin|crisp|crispy|golden|in|of|with|and)[- ])batters?`,
  captain: String.raw`captains?(?!(?:'s|’s)?[- ](?:chairs?|hats?|caps?|beds?|tables?|desks?|wheels?)\b)(?![- ]morgan\b)`,
  pitcher: String.raw`(?<!\b(?:water|glass|ceramic|milk|beer|cream|clay|pottery|enamel|enamelware|metal|silver|copper|pewter|stoneware|porcelain|earthenware|terracotta|plastic|crystal|lemonade|sangria|tea|juice|wine)[- ])pitchers?(?![- ]of\b)`,
  driver: String.raw`(?<!\bgolf[- ])drivers?(?![- ](?:clubs?|heads?)\b)`,
  racer: String.raw`(?<!\bcaf[eé][- ])racers?(?![- ](?:bikes?|motorcycles?|jackets?|style)\b)`,
  rider: String.raw`(?<!\beasy[- ])riders?(?![- ](?:mowers?|jackets?)\b)`,
  defender: String.raw`(?<!\brover[- ])defenders?(?![- ]?\d)`,
  boxer: String.raw`boxers?(?![- ](?:shorts|briefs|dogs?|pupp(?:y|ies)|breed)\b)`,
  fighter: String.raw`fighters?(?![- ](?:jets?|planes?|aircraft|kites?)\b)`,
  jockey: String.raw`jockeys?(?![- ](?:briefs|underwear|shorts|boxers)\b)`,
  ref: String.raw`refs?(?!\.|\s*\d)`,
  champion: String.raw`champions?(?![- ](?:league|hoodies?|sweatshirts?|sweatpants|t-?shirts?|tees?|jackets?|shorts|sneakers|brand|logo)\b)`,
};
/** Sports and public roles that name nothing else: they always mean people. */
const PERSON_ROLES = String.raw`athletes?|referees?|umpires?|politicians?|celebrit(?:y|ies)|actors?|actress(?:es)?|batsm[ae]n|batswom[ae]n|footballers?|cricketers?|goalkeepers?|goalies?|goaltenders?|quarterbacks?|strikers?|midfielders?|linesm[ae]n|lineswom[ae]n|sportsm[ae]n|sportswom[ae]n|sportspe(?:rson|ople)|wrestlers?|gymnasts?|golfers?|officials|(?:match|game|race|court|line|track|technical)[- ]officials?`;
/**
 * Roles inferred for people in the photo (G-PERSON-ROLE, G-SUBJECT).
 * guard-v6: singular and plural ("background players", "referees"), and the
 * scorer's sports roles. guard-v7: the common synonyms (strikers, defenders,
 * pitchers, refs, linesmen, officials, drivers, riders, racers, boxers,
 * sportsmen, batswomen …). Only applied when the reading shows people.
 */
export const ROLE_RE = new RegExp(
  String.raw`\b(?:${PERSON_ROLES}|${Object.values(OBJECT_ROLES).join('|')}|${PLAYER}|managers?|presidents?|ministers?|officers?|soldiers?)\b`,
  'i',
);
/**
 * Words that say the reading shows people (singular or plural). guard-v6: the
 * blind run's "Tennis player on outdoor court" did not count as people, so the
 * competing subjects "main player" / "background players" passed G-SUBJECT.
 * Players, athletes, crowds, spectators and other words for people in a scene
 * count now. guard-v7: the role nouns that always mean people (PERSON_ROLES),
 * riders, drivers, racers, boxers, fighters, skiers, soldiers, fans and
 * supporters, brides and grooms, guests, adults and more; the object forms of
 * the ambiguous ones (OBJECT_ROLES, "ceiling fans") do not count. Words that
 * usually name things ("couple of", "kid leather", "family-style") are left
 * out, and a role noun alone (a "Coach bag", a "bowler hat") is not people.
 */
export const PEOPLE_RE = new RegExp(
  String.raw`\b(?:man|men|woman|women|person|persons|people|crowds?|${PLAYER}|${PERSON_ROLES}|${OBJECT_ROLES.driver}|${OBJECT_ROLES.rider}|${OBJECT_ROLES.racer}|${OBJECT_ROLES.boxer}|${OBJECT_ROLES.fighter}|${OBJECT_ROLES.jockey}|spectators?|onlookers?|audiences?|pedestrians?|passers-?by|bystanders?|shoppers?|diners?|tourists?|visitors?|commuters?|runners?|joggers?|cyclists?|bikers?|skaters?|skateboarders?|skiers?|snowboarders?|surfers?|swimmers?|divers?|climbers?|hikers?|dancers?|musicians?|performers?|workers?|vendors?|soldiers?|troops|police(?:m[ae]n|wom[ae]n)?|(?<!\b(?:ceiling|electric|desk|table|exhaust|cooling|box|pedestal|tower|hand|paper|folding|wall|floor|attic|window|bathroom|kitchen|extractor)[- ])fans|supporters?|brides?|bride-?grooms?|grooms?|bridesmaids?|newlyweds?|guests?|adults?|toddlers?|babies|children|child|kids|boys?|girls?|teenagers?|students?|someone|somebody|teammates?|opponents?)\b`,
  'i',
);
/**
 * "Eames-style lounge chair", "Shaker-inspired cabinet", "Eames style chair".
 * Narrower than the plan's /^(\S+)[- ](style|inspired)\b/: a bare style name
 * such as "Empire style" (a real style the plan keeps, §4.5) does not match.
 */
export const STYLE_OF_RE = /^(\S+)(?:-(?:style|inspired)\b|\s(?:style|inspired)\s+\S)/i;

/**
 * guard-v8, G-PEOPLE-CLAIM: the claim's subject is the people in the photo,
 * by claim class and domain rather than by word: a tradition or style (the
 * classes an occasion, an event, a custom, a role or a person's look arrive
 * as) whose domain names no thing: "people", or "other" (no garment, food,
 * craft, building, vehicle, sport, music, film, art, place or sign). "Prom"
 * on two people in formal wear (tradition, other) is about them; "Test
 * cricket" (sport), "Streetwear" (fashion) or "Victorian terraced houses"
 * (architecture) are about what they do, wear or stand in front of. Creators
 * and people-domain names are identity claims (G-IDENTITY). Only the model's
 * own domain counts (reading v2): a legacy reading's inferred domain falls
 * back to "other" for anything outside the category lexicons, which says
 * nothing about its subject.
 */
export const PERSON_SUBJECT_DOMAINS: ReadonlySet<string> = new Set(['people', 'other']);
export function aboutPeople(c: Pick<VlmCandidate, 'type'> & { domain?: VlmDomain | null }): boolean {
  return (c.type === 'tradition' || c.type === 'style') && !!c.domain && PERSON_SUBJECT_DOMAINS.has(c.domain);
}

/**
 * guard-v9 (round-3 Tune, h46 "Professional basketball"): on a photo that
 * shows people, a *style* in the sport domain is a claim about how those
 * people play (their level, league or manner of play), so it is a claim about
 * the people. The sport itself arrives as a tradition ("Basketball", "Test
 * cricket", "association football") and stays a thing, and a sport style on a
 * photo without people ("Running shoes" on a studio sneaker) is about the
 * object. Again by class and the model's own domain, not by word. Unlike
 * aboutPeople it applies only once the reading shows people: a quick read of a
 * sneaker or a hoop is not held on the chance that people appear at stage 2.
 */
export function playStyleOfPeople(
  c: Pick<VlmCandidate, 'type'> & { name?: string; domain?: VlmDomain | null },
  mentionsPeople: boolean,
): boolean {
  if (!mentionsPeople || c.type !== 'style' || c.domain !== 'sport') return false;
  // guard-v12: a garment or a piece of equipment ("Black-and-white striped football kit") and a sport named
  // alone ("basketball" typed as a style) are what the vlm-quick-v3 prompt asks for: things, not the play.
  if (c.name !== undefined && (plainThing(c.name) || sportActivity({ name: c.name, type: c.type, domain: c.domain }))) return false;
  return true;
}

/**
 * guard-v10 (round-3 review, after the h50–h79 blind run): words that name a
 * relationship between the people in a photo. They always mean people ("Two
 * friends in orange sweatshirts" says there are people and what they are to
 * each other), so a headline or a claim using them is a claim about the
 * people. "A couple of chairs" and "family-style" dining are not.
 */
const RELATIONSHIP_WORDS = String.raw`couples?(?![- ]of\b)|friends?|best[- ]friends?|girlfriends?|boyfriends?|husbands?|wi(?:fe|ves)|spouses?|fianc[eé]e?s?|newlyweds?|brides?|bridesmaids?|bride-?grooms?|grooms?|groomsm[ae]n|siblings?|brothers|sisters|twins|colleagues?|co-?workers?|classmates?|bandmates?|famil(?:y|ies)(?![- ](?:style|size[d]?|room|car|run|owned|restaurant)\b)`;
/**
 * guard-v10: roles of a person that name nothing else (a waiter, a guardsman),
 * beyond ROLE_RE's sports and public roles. They also mean people.
 */
const PERSON_ROLE_WORDS = String.raw`waiters?|waitress(?:es)?|baristas?|bartenders?|employees?|customers?|patrons?|nurses?|doctors?|surgeons?|teachers?|students?|guardsm[ae]n|cavalrym[ae]n|troopers?|horsem[ae]n|horsewom[ae]n|policem[ae]n|policewom[ae]n|firefighters?|monks?|nuns?|priests?|influencers?|rappers?`;
/**
 * guard-v10: words that name a claim about people only when the photo shows
 * people: an occasion or life event ("wedding", "prom"), a group, team, league
 * or unit the people belong to, the sideline (on a photo with people it casts
 * them as a team's staff: tune p11), and roles whose word also names a thing
 * ("a server", "the staff"; "a chef's knife" is excluded). On a photo without
 * people a "Wedding cake" or a "server rack" is about the thing.
 */
const PEOPLE_CONTEXT_WORDS = String.raw`weddings?|proms?|engagements?|marriage|proposals?|anniversar(?:y|ies)|birthdays?|graduations?|quincea[ñn]eras?|mitzvahs?|baptisms?|christenings?|funerals?|honeymoons?|reunions?|homecomings?|formal dances?|school dances?|winter formals?|bachelor(?:ette)?s?|retirements?|sidelines?|teams?|squads?|leagues?|regiments?|battalions?|platoons?|brigades?|cavalry|infantry|fraternit(?:y|ies)|sororit(?:y|ies)|servers?|staff|chefs?(?!(?:'s|’s)?[- ]knife|[- ]knives)`;
/**
 * guard-v11: words that say a person is in the photo without naming who they
 * are: someone wearing, dressed in or posing in something, a hand ("Hand with
 * ring in field"; "hand-painted", "hand made" and a hand towel are not hands), fielders and
 * catchers, youths, and personal pronouns ("her dress"). Read with PEOPLE_RE
 * and PEOPLE_NOUN_RE by peopleShown().
 */
export const PRESENCE_RE =
  /\b(?:wear(?:s|ing)|worn by|dressed (?:in|up|as)|posing|poses|(?<!-)hands?(?!-)(?! (?:made|painted|crafted|drawn|carved|woven|thrown|built|blown|stitched|lettered|dyed|knit(?:ted)?|sewn|forged|tooled|rolled|towels?|soap|cream|dryers?|trucks?|carts?|saws?|tools?)\b)|fielders?|catchers?|youths?|he|she|his|her|hers|him|himself|herself)\b/i;

/** guard-v10: a relationship or a person's role: always about people (headline and claims). */
export const PEOPLE_NOUN_RE = new RegExp(String.raw`\b(?:${RELATIONSHIP_WORDS}|${PERSON_ROLE_WORDS})\b`, 'i');
/**
 * guard-v10: a claim about the people in a photo, by word, whatever the
 * model's type or domain for it (finding: h73 "Croatia national football
 * team" typed as a sport tradition, h74 "Wedding cake" typed as food, both
 * outside aboutPeople()). Applied only when the reading shows people. This is
 * a closed list and a backstop to the class rules (aboutPeople,
 * playStyleOfPeople), not a replacement: a synonym it does not name still
 * reaches the class rules only.
 */
export const PEOPLE_CLAIM_RE = new RegExp(String.raw`\b(?:${RELATIONSHIP_WORDS}|${PERSON_ROLE_WORDS}|${PEOPLE_CONTEXT_WORDS})\b`, 'i');

/**
 * guard-v11: a text says that people are in the photo (a people word, a
 * relationship or role of a person, or a presence word).
 */
export function peopleWordIn(text: string): boolean {
  return PEOPLE_RE.test(text) || PEOPLE_NOUN_RE.test(text) || PRESENCE_RE.test(text);
}

/**
 * guard-v11: the reading shows people, from what it says about the photo (the
 * title, the interpretation, the observations and the region labels) and the
 * names of its claims, never from the model's domain label alone (round 3:
 * h73 and h74 filed claims about people under "sport" and "food"). A
 * `people`-domain claim still counts as one more signal.
 */
export function peopleShown(
  a: Pick<VlmAnalysis, 'title' | 'interpretation' | 'observations' | 'candidates'> & { regions?: VlmAnalysis['regions'] },
  observations: VlmAnalysis['observations'] = a.observations,
): boolean {
  return (
    peopleWordIn(`${a.title} ${a.interpretation}`) ||
    observations.some((o) => o.kind === 'person_style' || peopleWordIn(o.text)) ||
    (a.regions ?? []).some((r) => peopleWordIn(r.label)) ||
    a.candidates.some((c) => c.domain === 'people' || PEOPLE_RE.test(c.name))
  );
}

/**
 * guard-v11: the claim names something worn: its last naming word (outside
 * parentheses) is a garment or accessory noun ("Floral print dress", "Varsity
 * jacket", "Running shoes"). Such a claim is about the thing in the photo, so
 * the stage-1 holds of guard-v11 do not apply to it.
 */
export function namesGarment(name: string): boolean {
  const tokens = contentTokens(stripParens(name));
  return tokens.length > 0 && GARMENTS.has(tokens[tokens.length - 1]!);
}

/**
 * guard-v12: the claim's last naming word is a garment or accessory (GARMENTS) or a piece of sport
 * equipment (SPORT_EQUIPMENT: "Cricket pads", "Hockey stick"): a thing worn, held or played with.
 */
export function wornOrGear(name: string): boolean {
  const tokens = contentTokens(stripParens(name));
  const last = tokens[tokens.length - 1];
  return !!last && (GARMENTS.has(last) || SPORT_EQUIPMENT.has(last));
}

/**
 * guard-v12: a garment or equipment type named by more than a colour, a material or a size
 * ("Football boots", "Bell sleeve dress", "Low-top sneakers"), the named type the vlm-quick-v3
 * prompt asks for. "White leather sneakers" or "Shoes" alone stay generic objects (G-GENERIC).
 */
export function qualifiedThingType(name: string): boolean {
  if (!wornOrGear(name)) return false;
  return contentTokens(stripParens(name))
    .slice(0, -1)
    .some((t) => !COLOURS.has(t) && !MATERIALS.has(t) && !GENERIC_QUALIFIERS.has(t) && !/^\d+$/.test(t));
}

/**
 * guard-v11: a sport named alone, the activity in the photo ("Baseball",
 * "association football", "Test cricket", "streetball"): a tradition in the
 * sport domain whose name says nothing about who plays it, i.e. no level, age
 * group, league, team or nationality (SPORT_QUALIFIERS, NATIONALITIES,
 * PEOPLE_CLAIM_RE), no name of an organisation (an acronym, a capitalized
 * word after the first, a maker) and no number. "Little League baseball",
 * "Professional basketball", "Croatia national football team" and "Brazilian
 * football" are claims about the players.
 */
export function sportActivity(c: Pick<VlmCandidate, 'name' | 'type'> & { domain?: VlmDomain | null }): boolean {
  // guard-v12: the sport may arrive typed as a style too ("basketball", "Association football").
  if ((c.type !== 'tradition' && c.type !== 'style') || c.domain !== 'sport') return false;
  return contentTokens(stripParens(c.name)).length > 0 && !namesWhoPlays(c.name);
}

/**
 * guard-v11/v12: the name says who plays or wears it: a level, age group, league, team or nationality
 * (SPORT_QUALIFIERS, NATIONALITIES, PEOPLE_CLAIM_RE), an organisation (an acronym, a capitalized word
 * after the first, a maker) or a number. "Professional basketball", "Croatian football jersey".
 */
function namesWhoPlays(name: string): boolean {
  const tokens = contentTokens(stripParens(name));
  if (PEOPLE_CLAIM_RE.test(name) || acronymTokens(name).length || properTokensAfterFirst(name).length) return true;
  return tokens.some((t) => SPORT_QUALIFIERS.has(t) || NATIONALITIES.has(t) || MAKERS.has(t) || /\d/.test(t));
}

/** guard-v12: a garment or a piece of equipment whose name says nothing about who wears or plays with it. */
export function plainThing(name: string): boolean {
  return wornOrGear(name) && !namesWhoPlays(name);
}

/**
 * guard-v11 (round 4, h61 "Girl with a Pearl Earring" shape): a well-known
 * artwork or building named by its title on its form: a work in the art or
 * architecture domain, evidence distinctive_form, whose name holds no maker, no
 * model code, no number and no acronym. Its capitalized title words make it
 * brand-like (G-BRAND holds it at stage 1), but a title is not a brand: no text
 * in the photo is expected to name it. It publishes on a supported stage-2
 * verdict, as a resemblance, instead of needing a transcription. A stage-2
 * addition of this kind still has nothing to confirm it and is not published.
 */
export function titledWork(c: Pick<VlmCandidate, 'name' | 'type'> & { domain?: VlmDomain | null; evidence?: VlmEvidence | null }): boolean {
  if (c.type !== 'work' || c.evidence !== 'distinctive_form' || (c.domain !== 'art' && c.domain !== 'architecture')) return false;
  const tokens = contentTokens(stripParens(c.name));
  return tokens.length > 0 && !acronymTokens(c.name).length && !tokens.some((t) => MAKERS.has(t) || /\d/.test(t));
}

/**
 * guard-v12: read text that names nothing (docs/quality-plan.md §19.8): a claim the model says it read
 * (its own evidence read_text) that is a brand, or a work it filed under signage, whose naming words are
 * all general English words (generalWordsOnly: "Specialties", "internal review notice"), or a place named
 * by one such word ("Harbour", "Exit"). A maker (MAKERS, CONTEXTUAL_MAKERS) is a name, not a common word.
 */
export function commonWordsRead(
  c: Pick<VlmCandidate, 'name' | 'type'> & { evidence?: VlmEvidence | null },
  modelDomain: VlmDomain | null | undefined,
): boolean {
  if (c.evidence !== 'read_text' || !generalWordsOnly(c.name)) return false;
  const single = contentTokens(stripParens(c.name)).length === 1;
  // A name of several general words written as a name ("Agricultural Bank of China", "Latin Biorhythm
  // Mate": a capital after the first word) is a name; written as a description ("internal review
  // notice") it describes the text.
  const described = single || !/\s\p{Lu}/u.test(stripParens(c.name).trim());
  if (!described) return false;
  if (c.type === 'brand') return true;
  if (c.type === 'work') return modelDomain === 'signage';
  return c.type === 'place' && single;
}

/** guard-v12: "painting" and its plural, the one medium word that names a subject in the art domain. */
const PAINTING_RE = /\bpaintings?\b/i;
const PAINTING_ALL_RE = /\bpaintings?\b/gi;
/**
 * guard-v12: a claim the model filed under art whose only medium word, in its name and tag queries,
 * is "painting": it names the painting the photo shows (a reproduction, a scroll, a framed canvas),
 * not the photo's medium. Any other medium word ("illustration", "photograph", "render", "print") still
 * drops it, and so does "painting" in any other domain (G-MEDIUM).
 */
export function paintingSubject(c: Pick<VlmCandidate, 'name' | 'tag_queries'>, modelDomain: VlmDomain | null | undefined): boolean {
  if (modelDomain !== 'art') return false;
  const texts = [c.name, ...c.tag_queries];
  return texts.some((t) => PAINTING_RE.test(t)) && texts.every((t) => !hasMediumWord(t.replace(PAINTING_ALL_RE, ' '), 'art'));
}

/** guard-v12: the title of a work named "<Title> by <Creator>" ("David by Michelangelo" -> "David"); other names unchanged. */
export function workTitle(name: string): string {
  const m = /^(.+?)\s+by\s+\S.*$/i.exec(name.trim());
  return m ? m[1]!.trim() : name.trim();
}

/**
 * guard-v10: a claim about the people rests on read text only when the text
 * names it: every naming word of the claim (3+ letters, 2 for non-Latin, no
 * generic or describing word) is a whole token of one of `texts`. The model's
 * own evidence label ("read_text") is not enough: a "Wedding ceremony" read
 * off an "EXIT" sign is not backed by what was read.
 */
export function claimReadIn(name: string, texts: readonly (string | null | undefined)[]): string | null {
  const read = texts.filter((t): t is string => !!t && !!t.trim());
  const words = contentTokens(stripParens(name)).filter(
    (t) => !isGenericToken(t) && !/^\d+$/.test(t) && (t.length >= 3 || (isNonLatin(t) && t.length >= 2)),
  );
  if (!words.length || !words.every((w) => read.some((t) => textHasToken(t, w)))) return null;
  return read.find((t) => textHasToken(t, words[0]!)) ?? null;
}

/** Inspector reason codes of guard-v8 (decision notes). */
export const EVIDENCE_NOTES = {
  contextOnly: 'context_only',
  peopleClaim: 'people_claim',
  readMaker: 'read_maker_text_only',
  /** guard-v11: the model name was read, the maker was not (readModel). */
  readModel: 'read_model_text_only',
  /** guard-v11: held at stage 1 because the photo shows people (a style or tradition). */
  heldPeople: 'held_people_present',
  /** guard-v11: held at stage 1 because the claim rests only on context. */
  heldContext: 'held_context_only',
  /** guard-v11: a well-known work named by its form, held at stage 1, published on a supported second reading. */
  workByForm: 'work_title_by_form',
  /** guard-v12: an art-domain claim whose only medium word is "painting", held for stage 2 (paintingSubject). */
  paintingSubject: 'held_painting_subject',
  /** guard-v12: read text made of common words is visible text only (commonWordsRead). */
  commonWordsRead: 'read_text_common_words',
  /** guard-v12: a second work title read at stage 2 next to a stage-1 work claim (a credit line). */
  workMention: 'work_mention',
  /** guard-v12: stage 2 reported high overall uncertainty; nothing publishes from it. */
  uncertainSecondReading: 'uncertain_second_reading',
  verifierNo: 'verifier_no',
  verifierUnsure: 'verifier_unsure',
  verifierUnanswered: 'verifier_unanswered',
} as const;

const FLOOR = 0.25;
const DEPICTED_MIN = 0.5;
const PLACE_MIN = 0.5;
const LOWCERT_MAX = 0.35;
const ADDITION_MIN = 0.5;
const DEPICTED_EVIDENCE: ReadonlySet<VlmEvidence> = new Set(['read_text', 'logo', 'distinctive_form']);

// ---- token helpers -----------------------------------------------------------

const contentTokens = (name: string): string[] => nameTokens(name).filter((t) => !STOP.has(t));
const isGenericToken = (t: string): boolean =>
  GENERIC_NOUNS.has(t) || COLOURS.has(t) || MATERIALS.has(t) || GENERIC_QUALIFIERS.has(t);

/** `token` (already folded) occurs in `text` as a whole token; non-Latin tokens may occur inside a longer run. */
function textHasToken(text: string, token: string): boolean {
  if (!token) return false;
  if (nameTokens(text).includes(token)) return true;
  return isNonLatin(token) && foldText(text).includes(token);
}

/** First content token of a name (not a stop word). */
function headContentToken(name: string): string | null {
  return contentTokens(name)[0] ?? null;
}

const stripParens = (name: string) => name.replace(/\([^)]*\)/g, ' ');
/** Leading words that describe rather than name ("Vintage Nissan", "Red Ferrari"). */
const isFillerToken = (t: string) => GENERIC_QUALIFIERS.has(t) || COLOURS.has(t) || MATERIALS.has(t);
/** Trailing words that name the product, not the maker ("Trek road bike", "Supreme streetwear"). */
const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set(['co', 'inc', 'ltd', 'llc', 'plc', 'corp', 'company', 'corporation', 'group', 'gmbh', 'sa', 'ag']);
const isProductToken = (t: string) =>
  isFillerToken(t) ||
  GENERIC_NOUNS.has(t) ||
  FASHION.has(t) ||
  CONTEXT_PRODUCTS.has(t) ||
  CORPORATE_SUFFIXES.has(t) ||
  ['brand', 'logo', 'official'].includes(t);

/**
 * The brand part of a name (guard-v3): content tokens without parentheses,
 * leading qualifiers, colours and materials, and trailing product nouns.
 * "Blue Bottle Coffee cup" -> [bottle, coffee]; "Spalding NBA basketball" ->
 * [spalding, nba]; "Nissan X-Trail" -> [nissan, x, trail]; "Jordan 1
 * sneakers" -> [jordan, 1]; "Trek road bike" -> [trek].
 */
export function brandWords(name: string): string[] {
  const tokens = contentTokens(stripParens(name));
  while (tokens.length > 1 && isFillerToken(tokens[0]!)) tokens.shift();
  while (tokens.length > 1 && isProductToken(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.length === 1 && isProductToken(tokens[0]!) && !MAKERS.has(tokens[0]!) ? [] : tokens;
}

/** A brand word that must be read for the brand to count as read: 2+ characters, or a number. */
const requiredWord = (t: string) => t.length >= 2 || /^\d+$/.test(t) || isNonLatin(t);
/** A word that can head a brand: 3+ letters (2 for non-Latin script), not a bare number. */
const headWord = (t: string) => !/^\d+$/.test(t) && (t.length >= 3 || (isNonLatin(t) && t.length >= 2));

/**
 * The brand's own word: the first brand word (brandWords) that can head a
 * name. "Spalding NBA basketball" -> spalding, "Cannondale CAAD8" ->
 * cannondale, "Blue Bottle Coffee cup" -> bottle (never the colour).
 */
export function brandHeadToken(name: string): string | null {
  return brandWords(name).find(headWord) ?? null;
}

/**
 * G-BRAND-CORROBORATE (a), guard-v3: every brand word ("Nissan" and "Trail"
 * of "Nissan X-Trail", "Jordan" and "1" of "Jordan 1") is a whole token of
 * some transcription, so a make read on a badge never vouches for a model
 * guessed from the shape, and "BLUE MONDAY SALE" never vouches for "Blue
 * Bottle Coffee". Returns the transcription holding the head word, or null.
 */
export function brandReadIn(name: string, texts: readonly string[]): string | null {
  const words = brandWords(name).filter(requiredWord);
  const head = words.find(headWord);
  if (!head) return null;
  if (!words.every((w) => texts.some((t) => textHasToken(t, w)))) return null;
  return texts.find((t) => textHasToken(t, head)) ?? null;
}

/** The words of a person's or creator's name that must be read: 3+ letters (2 for non-Latin). */
function personWords(name: string): string[] {
  return contentTokens(stripParens(name)).filter((t) => (t.length >= 3 && !/^\d+$/.test(t)) || (isNonLatin(t) && t.length >= 2));
}
/** Every word of the name is a whole token of some transcription; returns the first matching text, or null. */
export function personReadIn(name: string, texts: readonly string[]): string | null {
  const words = personWords(name);
  if (!words.length || !words.every((w) => texts.some((t) => textHasToken(t, w)))) return null;
  return texts.find((t) => textHasToken(t, words[0]!)) ?? null;
}

/** Words after the first that are written with a capital (or in caps/digits) and are not generic. */
function properTokensAfterFirst(name: string): string[] {
  const words = name.trim().split(/\s+/).slice(1);
  const out: string[] = [];
  for (const word of words) {
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    // "X-Trail", "NBA", "CAAD8", "911S": a capital first letter, or a digit-led code with capitals.
    const capital = /^\p{Lu}/u.test(clean) || (/^\p{N}/u.test(clean) && /\p{Lu}/u.test(clean));
    if (!capital) continue;
    // guard-v12: a letter-shape compound ("T-shirt", "V-neck", "U-bend") is a shape, not a name: its
    // single leading letter does not count ("X-Trail" still counts for "Trail").
    const shape = /^\p{L}-/u.test(clean);
    for (const [i, t] of nameTokens(clean).entries()) {
      if (shape && i === 0) continue;
      if (!STOP.has(t) && !isGenericToken(t)) out.push(t);
    }
  }
  return out;
}

// ---- domain, categories, evidence (§4.3, §4.4) -------------------------------

function inferDomain(c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'>): VlmDomain {
  if (c.type === 'cuisine') return 'food';
  const folded = foldText([c.name, ...c.tag_queries].join(' '));
  const tokens = folded ? folded.split(' ') : [];
  const any = (words: ReadonlySet<string>, phrases: readonly string[] = []) =>
    tokens.some((t) => words.has(t)) || phrases.some((p) => hasPhrase(folded, p));
  if (any(FOOD, FOOD_PHRASES)) return 'food';
  if (any(FASHION)) return 'fashion';
  if (any(MUSIC, MUSIC_PHRASES)) return 'music';
  if (any(FILM, FILM_PHRASES)) return 'film';
  return 'other';
}

/** Domains that place a reference in a discovery category (G-CATEGORY). */
const CATEGORY_DOMAINS: ReadonlySet<VlmDomain> = new Set(['food', 'fashion', 'music', 'film']);

/** The domains the words of a text point to (lexicons only; empty when none does). */
function wordDomains(text: string): Set<VlmDomain> {
  const folded = foldText(text);
  const tokens = folded ? folded.split(' ') : [];
  const any = (words: ReadonlySet<string>, phrases: readonly string[] = []) =>
    tokens.some((t) => words.has(t)) || phrases.some((p) => hasPhrase(folded, p));
  const out = new Set<VlmDomain>();
  if (any(FOOD, FOOD_PHRASES)) out.add('food');
  if (any(FASHION)) out.add('fashion');
  if (any(MUSIC, MUSIC_PHRASES)) out.add('music');
  if (any(FILM, FILM_PHRASES)) out.add('film');
  if (any(ARCHITECTURE)) out.add('architecture');
  if (any(DESIGN)) out.add('design');
  return out;
}
const nameDomains = (c: Pick<VlmCandidate, 'name' | 'tag_queries'>) => wordDomains([c.name, ...c.tag_queries].join(' '));

/**
 * The candidate's domain: the schema value (reading v2), else lexicon
 * inference (§4.4). guard-v3 cross-checks a model domain that would place
 * the reference in a category against its own words: when the name points
 * elsewhere and not to the claimed domain ("Bossa Nova" claimed as food,
 * "Gothic Revival" claimed as fashion), the words win (one other domain),
 * or the domain is "other" (several). Non-category domains, people above
 * all, are never overridden.
 */
export function domainOf(c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'> & { domain?: VlmDomain | null }): VlmDomain {
  if (!c.domain) return inferDomain(c);
  if (!CATEGORY_DOMAINS.has(c.domain)) return c.domain;
  const words = nameDomains(c);
  if (!words.size || words.has(c.domain)) return c.domain;
  return words.size === 1 ? [...words][0]! : 'other';
}

/**
 * What the reading itself shows, by domain: food (G-CUISINE-FOOD's food
 * evidence), clothing (fashion words, a person_style observation), music and
 * film words in the title, interpretation or observations.
 */
export interface DomainSignals {
  domains: ReadonlySet<VlmDomain>;
}
export function readingSignals(
  a: Pick<VlmAnalysis, 'title' | 'interpretation' | 'observations'>,
  opts: { foodText?: boolean } = {},
): DomainSignals {
  const text = [a.title, a.interpretation, ...a.observations.map((o) => o.text)].join(' ');
  const domains = wordDomains(text);
  domains.delete('food');
  if (opts.foodText) domains.add('food');
  if (a.observations.some((o) => o.kind === 'person_style')) domains.add('fashion');
  return { domains };
}

/**
 * G-CATEGORY (§4.3): a fixed table from domain (or type cuisine) to discovery
 * categories. Architecture, interiors, design, craft, art, vehicles, sport,
 * places, signage, people and other get none: they stay under "Explore the
 * references" and still act as cross-domain taste signals.
 *
 * guard-v3: a model-supplied domain is not taken on trust. The category is
 * set only when the candidate's own words name that domain (a lexicon word),
 * or the reading shows it (`signals`: food, clothing, music or film in the
 * photo's description); otherwise the candidate gets no category. Legacy
 * readings infer the domain from those same words, so they always agree.
 */
export function categoriesFor(
  c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'> & { domain?: VlmDomain | null },
  signals?: DomainSignals,
): Category[] {
  const domain = c.type === 'cuisine' ? 'food' : domainOf(c);
  const category: Category | null =
    domain === 'food' ? 'eat' : domain === 'fashion' ? 'wear' : domain === 'music' ? 'play' : domain === 'film' ? 'watch' : null;
  if (!category) return [];
  if (!c.domain || c.type === 'cuisine') return [category];
  return nameDomains(c).has(domain) || signals?.domains.has(domain) ? [category] : [];
}

/** Evidence for a candidate: the schema value, else read_text when a specific name token is in the visible text (§4.4). */
function evidenceFor(c: VlmCandidate, texts: readonly string[]): { evidence: VlmEvidence; evidence_text: string | null } {
  if (c.evidence) {
    const withText = c.evidence === 'read_text' || c.evidence === 'logo';
    return { evidence: c.evidence, evidence_text: withText ? (c.evidence_text?.trim() || null) : null };
  }
  const specific = contentTokens(c.name).filter((t) => !isGenericToken(t) && (t.length >= 3 || isNonLatin(t)));
  // The entry that names the head word wins; otherwise the one sharing the most specific words.
  const head = headContentToken(c.name);
  let best: { text: string; score: number } | null = null;
  for (const text of texts) {
    const shared = specific.filter((t) => textHasToken(text, t)).length;
    if (!shared) continue;
    const score = shared + (head && textHasToken(text, head) ? 100 : 0);
    if (!best || score > best.score) best = { text, score };
  }
  return best ? { evidence: 'read_text', evidence_text: best.text.slice(0, 60) } : { evidence: 'context', evidence_text: null };
}

const DECADE_RE = /^\d{2,4}s$/;
const ORDINAL_RE = /^\d+(?:st|nd|rd|th)$/;
const UNIT_RE = /^\d+(?:mm|cm|m|km|kg|g|ml|l|k|d|p|hp|cc|v|w|mph|kmh|in|ft|x)$/;
/** A model code: letters and digits in one token ("caad8", "a4", "911s"), not a decade, ordinal or unit ("1950s", "19th", "35mm"). */
export function isModelCode(token: string): boolean {
  if (!/^[a-z0-9]+$/.test(token) || !/\d/.test(token) || !/[a-z]/.test(token)) return false;
  return !DECADE_RE.test(token) && !ORDINAL_RE.test(token) && !UNIT_RE.test(token);
}
/** Any lexicon knows the word: it describes, it does not name a maker. */
export function knownWord(t: string): boolean {
  return (
    STOP.has(t) || isGenericToken(t) || DESCRIPTORS.has(t) || FASHION.has(t) || FOOD.has(t) || FOOD_EVIDENCE.has(t) ||
    MUSIC.has(t) || FILM.has(t) || ARCHITECTURE.has(t) || DESIGN.has(t) || STYLE_MOVEMENTS.has(t) || CONTEXT_PRODUCTS.has(t)
  );
}
/**
 * guard-v12: a general English word (ENGLISH_WORDS, SCOWL 50: in most dictionaries, no proper
 * names) or a word any lexicon knows. Not a maker the reading could have read.
 */
export function commonWord(t: string): boolean {
  return ENGLISH_WORDS.has(t) || knownWord(t);
}

/**
 * guard-v12: the claim is named with general words only: every naming word is a common word
 * (commonWord) or a single letter ("T" of "T-shirt"), and none is a maker, an everyday-word maker
 * (CONTEXTUAL_MAKERS), a model code or a number.
 */
export function generalWordsOnly(name: string): boolean {
  const tokens = contentTokens(stripParens(name));
  return (
    tokens.length > 0 &&
    tokens.every(
      (t) => (commonWord(t) || (t.length === 1 && /\p{L}/u.test(t))) && !MAKERS.has(t) && !CONTEXTUAL_MAKERS.has(t) && !/\d/.test(t),
    )
  );
}

/** Capitals that are not an organisation: countries, cities and roman numerals. */
const NON_ORG_ACRONYMS: ReadonlySet<string> = new Set([
  'usa', 'us', 'uk', 'eu', 'uae', 'nyc', 'la', 'dc', 'ussr', 'prc', 'roc', 'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii', 'xx', 'xxi', 'diy', 'tv', 'ok',
]);
/** Words written in capitals, 2-5 letters, that are not a country, a city or a roman numeral ("EMT", "NBA", "IKEA"). */
function acronymTokens(name: string): string[] {
  return stripParens(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /^\p{Lu}{2,5}$/u.test(w))
    .map((w) => foldText(w))
    .filter((t) => !NON_ORG_ACRONYMS.has(t) && !STOP.has(t));
}

/**
 * Product domains where an unknown leading word is most likely a maker.
 * Vehicles are not one: a vehicle object is usually led by a place ("London
 * double-decker bus", "Lisbon tram"), and car and motorbike makers are on
 * the MAKERS list.
 */
const PRODUCT_DOMAINS: ReadonlySet<string> = new Set(['fashion', 'sport']);
const PRODUCT_TYPES: ReadonlySet<string> = new Set(['object', 'style', 'tradition', 'work']);

/**
 * Brand-like (G-BRAND), guard-v3. Any of:
 *  - type brand, or evidence logo;
 *  - a maker name (MAKERS), or an everyday-word maker next to a product noun
 *    of its trade ("Supreme streetwear", "Trek road bike", "Vans sneakers");
 *  - an object or style with a model code or a numbered model ("Jordan 1",
 *    "Golf GTI", "CAAD8");
 *  - an object or work with a capitalized, non-generic word after the first
 *    ("Nissan X-Trail", "London Routemaster");
 *  - fail closed: a fashion or sport object whose leading word no
 *    lexicon knows, followed by a product noun ("Fixturo road bike"). Words
 *    of a place named in the same reading (`knownWords`) are descriptions;
 *  - guard-v5, brand residue: an object, style, tradition or work that
 *    repeats a naming word of a brand-like claim in the same reading
 *    (`brandResidue`): "Beetle" next to "Volkswagen Beetle" is the same
 *    model claim without its maker, not a new description.
 */
export function isBrandLike(
  c: Pick<VlmCandidate, 'name' | 'type'> & { evidence?: VlmEvidence | null; domain?: VlmDomain | null; tag_queries?: readonly string[] },
  ctx: { knownWords?: ReadonlySet<string>; brandResidue?: ReadonlySet<string> } = {},
): boolean {
  if (c.type === 'brand' || c.evidence === 'logo') return true;
  const tokens = contentTokens(stripParens(c.name));
  if (tokens.some((t) => MAKERS.has(t))) return true;
  if (PRODUCT_TYPES.has(c.type) && ctx.brandResidue?.size && tokens.some((t) => ctx.brandResidue!.has(t))) return true;
  // A place named with an acronym in capitals is an organisation ("EMT Madrid", the transit operator).
  if (!PRODUCT_TYPES.has(c.type)) return c.type === 'place' && acronymTokens(c.name).length > 0;
  if (tokens.some((t, i) => CONTEXTUAL_MAKERS.has(t) && tokens.some((u, j) => j !== i && CONTEXT_PRODUCTS.has(u)))) return true;
  if (c.type === 'object' || c.type === 'style') {
    if (tokens.some(isModelCode)) return true;
    // A number right after a naming word: "Jordan 1", "Model 3" (not a year, not after a generic word).
    if (
      tokens.some((t, i) => i > 0 && /^\d{1,4}$/.test(t) && !(t.length === 4 && +t >= 1000 && +t <= 2099) && !knownWord(tokens[i - 1]!))
    )
      return true;
  }
  if ((c.type === 'object' || c.type === 'work') && properTokensAfterFirst(c.name).length > 0) return true;
  // An acronym written in capitals names an organisation or a brand ("NBA court"), not a style.
  if (acronymTokens(c.name).length > 0) return true;
  if (c.type === 'object' && tokens.length >= 2) {
    const domain = c.domain ?? inferDomain({ name: c.name, type: c.type, tag_queries: [...(c.tag_queries ?? [])] });
    const lead = tokens[0]!;
    // guard-v12: not when the model did not read it and every word of the name is a general English
    // word ("Checkerboard slip-on sneakers", "Bell sleeve dress"): an unknown maker is a name a
    // dictionary does not hold. Makers, model codes, acronyms and capitalized names were tested above.
    if (
      PRODUCT_DOMAINS.has(domain) &&
      !knownWord(lead) &&
      !ctx.knownWords?.has(lead) &&
      isProductToken(tokens[tokens.length - 1]!) &&
      !(c.evidence !== 'read_text' && generalWordsOnly(c.name))
    )
      return true;
  }
  return false;
}

/**
 * guard-v5: the naming words of the brand-like claims of one reading, without
 * maker names (a maker already makes a claim brand-like), words any lexicon
 * knows, words of places the reading names, and short or numeric tokens. A
 * model or product name left after its maker ("beetle" of "Volkswagen
 * Beetle") is in here, so the same model claimed again without the maker is
 * still a brand claim (h02: "Beetle" added at stage 2 next to a held
 * "Volkswagen Beetle", with no badge legible).
 */
export function brandResidue(
  candidates: readonly (Pick<VlmCandidate, 'name' | 'type'> & { evidence?: VlmEvidence | null; domain?: VlmDomain | null; tag_queries?: readonly string[] })[],
  knownWords: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  for (const c of candidates) {
    if (c.type === 'place' || !isBrandLike(c, { knownWords })) continue;
    // guard-v11: only the words the claim writes as names (a capital or a digit: "Beetle", "Old
    // Skool"), not its lower-case describing words ("checkerboard slip-on"), h70.
    const naming = namingTokens(c.name);
    for (const t of brandWords(c.name))
      if (naming.has(t) && !MAKERS.has(t) && !knownWord(t) && !knownWords.has(t) && headWord(t) && !isModelCode(t)) out.add(t);
  }
  return out;
}

/** guard-v11: tokens of the words of a name written with a capital letter or a digit (a name, not a description). */
function namingTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const word of stripParens(name).split(/\s+/)) {
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/^[\p{Lu}\p{N}]/u.test(clean) || (isNonLatin(clean) && !/\p{Ll}/u.test(clean))) for (const t of nameTokens(clean)) out.add(t);
  }
  return out;
}

// ---- visible text, observations, title (G-VTEXT, G-PERSON-OBS, G-MEDIUM) ----

/** G-VTEXT: visible_text holds verbatim transcriptions only; descriptions of text are dropped. */
/**
 * G-VTEXT (plates, guard-v2): a transcription shaped like a registration
 * plate: only capitals and digits in at most three groups, 4 to 10 characters,
 * at least two letters and two digits ("RK 492 AU", "AB12 CDE"). Applied only
 * when the reading shows a vehicle, so codes on signs or products stay.
 */
export const PLATE_RE = /^(?=(?:[^0-9]*[0-9]){2})(?=(?:[^A-Z]*[A-Z]){2})[A-Z0-9]{1,10}(?:[ .·-][A-Z0-9]{1,8}){0,2}$/;
export const VEHICLE_RE =
  /\b(cars?|vans?|trucks?|lorr(?:y|ies)|bus(?:es)?|taxis?|cabs?|motorbikes?|motorcycles?|scooters?|vehicles?|suvs?|sedans?|hatchbacks?|pickups?|parked|driving)\b/i;
export function looksLikePlate(text: string): boolean {
  const t = text.trim();
  const len = t.replace(/[ .·-]/g, '').length;
  return len >= 4 && len <= 10 && PLATE_RE.test(t);
}
/** The reading shows a vehicle: a vehicle-domain candidate or a vehicle word in its title, sentence or observations. */
export function readingShowsVehicle(a: Pick<VlmAnalysis, 'title' | 'interpretation' | 'observations' | 'candidates'>): boolean {
  return (
    a.candidates.some((c) => domainOf(c) === 'vehicle') ||
    VEHICLE_RE.test(`${a.title} ${a.interpretation}`) ||
    a.observations.some((o) => VEHICLE_RE.test(o.text))
  );
}

export function sanitizeVisibleText(texts: readonly string[], ctx: { vehicle?: boolean } = {}): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const text of texts) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const longPlain = words > 12 && !/["'“”‘’«»\d]/.test(text);
    const plate = ctx.vehicle === true && looksLikePlate(text);
    (VTEXT_RE.test(text) || longPlain || plate ? dropped : kept).push(text);
  }
  return { kept, dropped };
}

/** guard-v12: words that refer to the people in an observation beyond peopleWordIn ("they wear", "their jackets"). */
const PERSON_REF_RE = /\b(?:wear|they|them|their|theirs|themselves)\b/i;
/**
 * guard-v12 (G-PERSON-OBS on every observation): on a photo with people an observation that refers to a
 * person is not shown, whatever it says about them: a person_style observation, a people, relationship,
 * role or presence word (peopleWordIn: "The player wears ...", "Two older men ...", "One wears slim
 * jeans ..."), an occasion, team or role word (PEOPLE_CLAIM_RE), or a pronoun for them. guard-v11 only
 * removed the physical descriptions of PERSON_OBS_RE, so a garment observation could still describe the
 * person ("a brown braided ponytail", "slim jeans") or name a role ("Standing server ...").
 */
export function personObservation(o: Pick<VlmAnalysis['observations'][number], 'text' | 'kind'>, people: boolean): boolean {
  if (!people) return false;
  return o.kind === 'person_style' || peopleWordIn(o.text) || PEOPLE_CLAIM_RE.test(o.text) || PERSON_REF_RE.test(o.text);
}

/**
 * G-PERSON-OBS: no hair, face, skin, age, body or expression descriptions; guard-v12: on a photo with
 * people (`people`), no observation that refers to a person (personObservation).
 */
export function sanitizeObservations(
  obs: VlmAnalysis['observations'],
  opts: { people?: boolean } = {},
): { kept: VlmAnalysis['observations']; dropped: VlmAnalysis['observations'] } {
  const kept: VlmAnalysis['observations'] = [];
  const dropped: VlmAnalysis['observations'] = [];
  for (const o of obs) (PERSON_OBS_RE.test(o.text) || personObservation(o, opts.people === true) ? dropped : kept).push(o);
  return { kept, dropped };
}

const MEDIUM_PHRASE_RE = new RegExp(
  `(\\b(?:a|an|the)\\s+)?${MEDIUM_RE.source}(\\s+(?:of|with|in)\\b(?:\\s+(a|an|the)\\b)?)?`,
  'gi',
);
/** A medium word used as a participle ("photographed at dusk", "rendered in blue"): only the word goes. */
const PARTICIPLE_RE = /ed$/i;
/** Dangling words left at either end after a medium phrase is removed (articles only at the end). */
const LEADING_CONNECTORS = /^(?:and|or|of|with|in|&|-|–|,|:|;)$/i;
const TRAILING_CONNECTORS = /^(?:and|or|of|with|in|a|an|the|&|-|–|,|:|;)$/i;

/** Removes medium phrases and tidies the connectors left behind. */
function stripMedium(text: string): string {
  // "A watercolour of a bike" keeps "a bike"; "Dutch artwork of a fruit bowl" becomes "Dutch fruit bowl".
  const groups = (MEDIUM_RE.source.match(/\((?!\?)/g) ?? []).length;
  const words = text
    .replace(MEDIUM_PHRASE_RE, (...m: unknown[]) => {
      const lead = m[1] as string | undefined;
      const word = m[2] as string;
      const phrase = m[2 + groups] as string | undefined;
      const trailing = m[3 + groups] as string | undefined;
      // guard-v6: "a car photographed in a studio" keeps "a car in a studio".
      if (PARTICIPLE_RE.test(word)) return ` ${lead ?? ''}${phrase ?? ''} `;
      return lead && trailing ? ` ${trailing} ` : ' ';
    })
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\b(and|or)\s+\1\b/gi, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length && LEADING_CONNECTORS.test(words[0]!)) words.shift();
  while (words.length && TRAILING_CONNECTORS.test(words[words.length - 1]!.replace(/[.,;:]$/, ''))) words.pop();
  const out = words.join(' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}
const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// ---- candidate rules (§4.2) ----------------------------------------------------

interface ReadingFacts {
  title: string;
  interpretation: string;
  mentionsPeople: boolean;
  /** Food words in the title/interpretation, or (stage 2) an observation of kind food. */
  foodText: boolean;
  /** The candidates that can show depicted food (by id). */
  candidates: readonly VlmCandidate[];
  texts: readonly string[];
  /** What the reading shows, by domain (G-CATEGORY support). */
  signals: DomainSignals;
  /** Words of the places this reading names: a "London bus" is described by a place, not made by a maker. */
  knownWords: ReadonlySet<string>;
  /** guard-v5: naming words of this reading's brand-like claims (brandResidue). */
  brandResidue: ReadonlySet<string>;
}

/** A candidate that is itself depicted food with real evidence ("Xiaolongbao" on a steamer). */
function depictedFood(c: VlmCandidate): boolean {
  return (
    c.relation === 'depicted' &&
    domainOf(c) === 'food' &&
    c.certainty >= DEPICTED_MIN &&
    !!c.evidence &&
    DEPICTED_EVIDENCE.has(c.evidence)
  );
}

interface Verdict {
  action: GuardAction;
  rules: GuardRule[];
  candidate: VlmCandidate;
  /** Set by G-STYLE-OF when the dropped "X-style" candidate is replaced by its tag query as a style. */
  replacement?: VlmCandidate;
  note?: string;
}

/**
 * `peopleObservations`: the observations the people test reads. Stage 1 passes
 * the reading's own observations, before sanitizeObservations() removes the
 * person descriptions ("A young man with a beard"): those are exactly the
 * observations that show people (guard-v7; guard-v6 tested the sanitized
 * list, so a person_style observation never counted at stage 1).
 */
function readingFacts(
  a: Pick<VlmAnalysis, 'title' | 'interpretation' | 'observations' | 'candidates'> & { regions?: VlmAnalysis['regions'] },
  texts: readonly string[],
  stage2: boolean,
  peopleObservations: VlmAnalysis['observations'] = a.observations,
): ReadingFacts {
  const head = `${a.title} ${a.interpretation}`;
  const headTokens = nameTokens(head);
  const foodText =
    headTokens.some((t) => FOOD_EVIDENCE.has(t)) ||
    FOOD_PHRASES.some((p) => hasPhrase(foldText(head), p)) ||
    (stage2 && a.observations.some((o) => o.kind === 'food'));
  const knownWords = new Set(a.candidates.filter((c) => c.type === 'place').flatMap((c) => contentTokens(c.name)));
  return {
    title: a.title,
    interpretation: a.interpretation,
    // guard-v6: people words in the observations ("Additional players in the background")
    // count as people too. guard-v7: a role noun alone does not (a "Coach bag", a "bowler
    // hat", "tempura batter" on a table); the role nouns that always mean people
    // ("Referee signals a foul") are people words. A candidate named with a people word
    // ("Olympic athletes") counts, and stage 1 reads the unsanitized observations.
    // guard-v11: relationship, role and presence words count too ("Two friends", "Hand with ring",
    // "batter and catcher"), and so do the stage-2 region labels (peopleShown).
    mentionsPeople: peopleShown(a, peopleObservations),
    foodText,
    candidates: a.candidates,
    texts,
    signals: readingSignals(a, { foodText: foodText || a.candidates.some(depictedFood) }),
    knownWords,
    brandResidue: brandResidue(a.candidates, knownWords),
  };
}

function isFoodReference(c: VlmCandidate): boolean {
  if (c.type === 'cuisine') return true;
  const tokens = nameTokens(c.name);
  return tokens.length > 0 && FOOD_NAME_ENDINGS.has(tokens[tokens.length - 1]!);
}

/** "Kanye-style outfit" -> the words that attribute the style to someone (not a known movement or descriptor). */
function styleAttribution(name: string): string[] {
  const m = STYLE_OF_RE.exec(name);
  if (!m) return [];
  return nameTokens(m[1]!).filter(
    (t) => !STOP.has(t) && !isGenericToken(t) && !STYLE_MOVEMENTS.has(t) && !DESCRIPTORS.has(t) && t !== 'style' && t !== 'inspired',
  );
}

/**
 * Applies the candidate rules in plan order. The first drop wins (later
 * rules are not evaluated); every rule that fired before it is recorded.
 * Hold beats demote; both continue through the remaining rules.
 */
function evaluate(
  input: VlmCandidate,
  facts: ReadingFacts,
  opts: { stage: 1 | 2; twoStage: boolean; addition: boolean },
): Verdict {
  const rules: GuardRule[] = [];
  const ev = evidenceFor(input, facts.texts);
  let c: VlmCandidate = {
    ...input,
    ...ev,
    domain: domainOf(input),
    tag_queries:
      ['style', 'tradition', 'cuisine'].includes(input.type) && !input.tag_queries.some((t) => t.trim())
        ? [input.name]
        : input.tag_queries,
  };
  let replacement: VlmCandidate | undefined;
  const drop = (rule: GuardRule, note?: string): Verdict => ({
    action: 'drop',
    rules: [...rules, rule],
    candidate: c,
    ...(replacement ? { replacement } : {}),
    ...(note ? { note } : {}),
  });
  let hold = false;
  let demote = false;
  let heldNote: string | undefined;
  const observe = (rule: GuardRule, note: string): Verdict => ({
    action: 'observe',
    rules: [...rules, rule],
    candidate: c,
    ...(replacement ? { replacement } : {}),
    note,
  });

  // G-MEDIUM, G-PERSON-ROLE and G-IDENTITY run on the candidate and again on a G-STYLE-OF replacement.
  const personRules = (): Verdict | null => {
    // G-MEDIUM: medium words in the name or tag query, unless a labelled artwork.
    const labelledArt = (c.type === 'work' || c.type === 'creator') && c.evidence === 'read_text';
    if (!labelledArt && (hasMediumWord(c.name, c.domain) || c.tag_queries.some((t) => hasMediumWord(t, c.domain)))) {
      // guard-v12: in the art domain "painting" names the painting in the photo ("Plum blossom painting",
      // "Dutch Golden Age painting"): it waits for stage 2 to support it instead of being dropped.
      if (!(opts.stage === 1 && opts.twoStage && paintingSubject(c, input.domain))) return drop('G-MEDIUM');
      if (!rules.includes('G-MEDIUM')) rules.push('G-MEDIUM');
      hold = true;
      heldNote = EVIDENCE_NOTES.paintingSubject;
    }
    // G-PERSON-ROLE: roles inferred for people in the photo.
    if (ROLE_RE.test(c.name) && facts.mentionsPeople) return drop('G-PERSON-ROLE');
    // G-IDENTITY: no creator or person unless their name is read in the photo. guard-v3: the
    // model's own evidence_text is one read, so the claim is held until stage 2 transcribes the
    // name (personReadIn); without a stage 2 it is dropped.
    if (c.type === 'creator' || c.domain === 'people') {
      const named =
        c.evidence === 'read_text' &&
        !!c.evidence_text &&
        contentTokens(c.name).some((t) => textHasToken(c.evidence_text!, t));
      if (!named) return drop('G-IDENTITY');
      if (opts.stage === 1) {
        if (!opts.twoStage) return drop('G-IDENTITY', 'no_stage_2');
        rules.push('G-IDENTITY');
        hold = true;
      }
    }
    // G-PEOPLE-CLAIM (guard-v8): on a photo with people, a claim about the people themselves
    // (an occasion, event, role, tradition or style of the person) publishes only on read text.
    // The stage-1 quick read has no observations, so people may only show at stage 2 (h47:
    // "Formal dance attire" at stage 1, "A young man wears ..." at stage 2): a claim about
    // people is held until stage 2 can tell, never published from stage 1 on context.
    // guard-v10: "rests on read text" means the text names the claim (claimReadIn), not only that
    // the model labelled its evidence read_text: stage 1 checks the model's own evidence_text (the
    // claim is then held by G-TEXT-ECHO for a second reading), a stage-2 addition the transcriptions.
    const readBacked =
      c.evidence === 'read_text' && claimReadIn(c.name, opts.stage === 1 ? [c.evidence_text, ...facts.texts] : facts.texts) !== null;
    if (playStyleOfPeople({ name: c.name, type: c.type, domain: input.domain }, facts.mentionsPeople) && !readBacked)
      return observe('G-PEOPLE-CLAIM', EVIDENCE_NOTES.peopleClaim);
    // guard-v10: a claim that names a relationship, a role, an occasion, a team, a league or a unit
    // of the people (PEOPLE_CLAIM_RE) is about them whatever type and domain the model gave it
    // ("Wedding cake" as food, "… national football team" as a sport tradition). Brands, creators
    // and people-domain names have their own rules (G-BRAND, G-IDENTITY).
    const namesPeople = c.type !== 'brand' && c.type !== 'creator' && input.domain !== 'people' && PEOPLE_CLAIM_RE.test(c.name);
    if ((aboutPeople({ type: c.type, domain: input.domain }) || namesPeople) && !readBacked) {
      if (facts.mentionsPeople || PEOPLE_NOUN_RE.test(c.name)) return observe('G-PEOPLE-CLAIM', EVIDENCE_NOTES.peopleClaim);
      if (opts.stage === 1) {
        rules.push('G-PEOPLE-CLAIM');
        hold = true;
      }
    }
    return null;
  };
  const early = personRules();
  if (early) return early;
  // guard-v12: read text made of common words ("Specialties", "internal review notice") is visible text,
  // not the name of a brand, a sign or a place: it stays in visible_text and is never a reference.
  if (commonWordsRead({ ...c, evidence: input.evidence ?? null }, input.domain)) return drop('G-TEXT-ECHO', EVIDENCE_NOTES.commonWordsRead);
  // G-STYLE-OF: "Eames-style lounge chair" -> the style itself, if a tag query names it.
  if (STYLE_OF_RE.test(c.name)) {
    const tq = c.tag_queries.find((t) => t.trim());
    if (!tq) return drop('G-STYLE-OF');
    // guard-v3: a tag query that repeats the attributed name ("Kanye-style" -> "Kanye West",
    // "Eames-style" -> "Eames") names a person or maker, not a style: G-IDENTITY.
    const attribution = styleAttribution(c.name);
    if (attribution.some((t) => nameTokens(tq).includes(t))) return drop('G-IDENTITY', 'style_of_attribution');
    rules.push('G-STYLE-OF');
    replacement = {
      ...c,
      name: tq.trim(),
      type: 'style',
      relation: 'resembles',
      tag_queries: [tq.trim()],
      evidence: 'context',
      evidence_text: null,
      domain: domainOf({ name: tq, type: 'style', tag_queries: [tq], domain: input.domain ?? null }),
    };
    c = replacement;
    const again = personRules();
    if (again) return again;
  }
  // G-CUISINE-FOOD: a cuisine, or anything about food (guard-v3: any food-domain claim), needs
  // food in the photo. A dish that is itself depicted with real evidence is its own evidence.
  if (isFoodReference(c) || (domainOf(c) === 'food' && !depictedFood(c))) {
    const otherFood = facts.candidates.some(
      (o) => o.id !== input.id && o.relation === 'depicted' && domainOf(o) === 'food',
    );
    if (!facts.foodText && !otherFood) return drop('G-CUISINE-FOOD');
  }
  // G-FLOOR.
  if (c.certainty < FLOOR) return drop('G-FLOOR');
  // G-DEPICTED: "depicted" needs real evidence.
  if (c.relation === 'depicted' && (c.certainty < DEPICTED_MIN || !DEPICTED_EVIDENCE.has(c.evidence!))) {
    rules.push('G-DEPICTED');
    // guard-v2: a named place or work claimed as seen on nothing but context
    // contradicts the evidence rule; it waits for stage 2 (an addition, which
    // nothing can confirm any more, is dropped below).
    // Only when the model itself said "context" (reading v2): an inferred
    // evidence on a legacy reading is not the model's own contradiction.
    if ((c.type === 'place' || c.type === 'work') && input.evidence === 'context') hold = true;
    c = { ...c, relation: 'resembles' };
  }
  // G-GENERIC: every content token is generic -> an observation, not a reference.
  // Also for styles and traditions ("Kraft paper", "Marble staircase"): the plan maps
  // filler activities (E4/E5) to this rule, and they arrive typed as style or tradition.
  if (c.type === 'object' || c.type === 'cuisine' || c.type === 'style' || c.type === 'tradition') {
    // guard-v12: a qualified garment or equipment type in the fashion or sport domain ("Football boots") is
    // the named type the prompt asks for, and a sport named alone ("Basketball") is the activity, not a ball.
    const wornType = qualifiedThingType(c.name) && (c.domain === 'fashion' || c.domain === 'sport');
    if (contentTokens(c.name).every(isGenericToken) && !wornType && !sportActivity({ name: c.name, type: c.type, domain: input.domain })) {
      rules.push('G-GENERIC');
      demote = true;
    }
  }
  // G-BRAND: brands never publish from stage 1 alone.
  const brandLike = isBrandLike(c, { knownWords: facts.knownWords, brandResidue: facts.brandResidue });
  if (brandLike && opts.stage === 1) {
    if (!opts.twoStage) return drop('G-BRAND', 'no_stage_2');
    rules.push('G-BRAND');
    hold = true;
  }
  // G-PLACE: an uncertain resembled place is not a reference.
  if (c.type === 'place' && c.relation === 'resembles' && c.certainty < PLACE_MIN && c.evidence !== 'read_text')
    return drop('G-PLACE');
  // G-TEXT-ECHO: a name that does not match the text it was read from, or a style read off a sign.
  if (c.evidence === 'read_text') {
    if (c.type === 'place' || c.type === 'work' || c.type === 'creator') {
      const head = headContentToken(c.name);
      if (!head || !c.evidence_text || !textHasToken(c.evidence_text, head)) {
        rules.push('G-TEXT-ECHO');
        hold = true;
      }
    } else if (c.type === 'style' || c.type === 'tradition') {
      rules.push('G-TEXT-ECHO');
      hold = true;
    }
  }
  // guard-v11, hold until confirmed (owner option C): at stage 1 a style or tradition on a photo
  // with people, and a style, tradition or place resting only on context, wait for stage 2, unless
  // the claim names a garment or a sport named alone. Only readings v2 (the model's own evidence)
  // are concerned, as for G-EVIDENCE: a legacy reading's inferred evidence is not the model's claim.
  if (opts.stage === 1 && input.evidence) {
    const judgement = c.type === 'style' || c.type === 'tradition';
    const thing = plainThing(c.name) || sportActivity({ name: c.name, type: c.type, domain: input.domain });
    // Read text that names the claim: the text rules (G-TEXT-ECHO) decide, not the people rule.
    const named = c.evidence === 'read_text' && claimReadIn(c.name, [c.evidence_text, ...facts.texts]) !== null;
    if (!thing && !named && judgement && facts.mentionsPeople && !rules.includes('G-PEOPLE-CLAIM')) {
      rules.push('G-PEOPLE-CLAIM');
      hold = true;
      heldNote = EVIDENCE_NOTES.heldPeople;
    }
    if (!thing && (judgement || c.type === 'place') && input.evidence === 'context') {
      rules.push('G-EVIDENCE');
      hold = true;
      heldNote ??= EVIDENCE_NOTES.heldContext;
    }
  }
  // G-LOWCERT: low-certainty resemblances wait for stage 2.
  if (c.relation === 'resembles' && c.certainty <= LOWCERT_MAX) {
    rules.push('G-LOWCERT');
    hold = true;
  }
  if (opts.stage === 2 && opts.addition) {
    if (c.certainty < ADDITION_MIN) return drop('G-ADDITION-FLOOR');
    // guard-v5: a place the stage-2 reply adds on context alone (no sign read, no landmark
    // form) is one unconfirmed guess at a district or street ("Mong Kok" for a neon street
    // with no name legible); nothing after stage 2 can confirm it, so it is dropped (a held
    // one is dropped as held_at_stage_2 by the caller).
    if (c.type === 'place' && input.evidence === 'context' && !hold) return drop('G-PLACE', 'context_addition');
  }
  // G-EVIDENCE (guard-v8): a claim whose only support is context never publishes on that alone.
  // A stage-2 addition on context alone has nothing left to confirm it (guardEnrichment keeps it
  // as a private observation). A stage-1 claim on context is the first section's content
  // (FAST-01): it publishes there only through the independent verifier when that is on (a "yes"
  // is the second, independent support; verifyTargets), and as in guard-v7 when it is off.
  // Only the model's own evidence (reading v2) counts, as for G-DEPICTED: a legacy reading's
  // inferred "context" only means no text matched, which is not the model's claim.
  if (input.evidence === 'context' && opts.stage === 2 && opts.addition) {
    rules.push('G-EVIDENCE');
    hold = true;
  }
  // A generic thing is never a reference, whatever stage 2 would say about it: demote beats hold.
  const action: GuardAction = demote ? 'demote' : hold ? 'hold' : 'publish';
  const note = action === 'hold' ? heldNote : undefined;
  return { action, rules, candidate: c, ...(replacement ? { replacement } : {}), ...(note ? { note } : {}) };
}

/**
 * G-BRAND-CORROBORATE (a): the stage-2 transcription that holds the brand's
 * head word, when every brand word was transcribed (brandReadIn), or null.
 */
const corroboratingText = (name: string, stage2Texts: readonly string[]): string | null => brandReadIn(name, stage2Texts);

/**
 * Text from the stage-1 call: its title and interpretation and the names and
 * evidence texts of the claims it made (published and held). A stage-2
 * addition that names a brand or a person needs its words here too, so two
 * separate readings agree; the addition's own reply (claim, evidence_text
 * and visible_text together) is one reading and never confirms itself.
 */
function stage1Texts(published: VlmAnalysis, held: readonly VlmCandidate[]): string[] {
  return [
    published.title,
    published.interpretation,
    ...[...published.candidates, ...held].flatMap((c) => [c.name, c.evidence_text ?? '']),
  ].filter((t) => t.trim());
}

// ---- competing subjects (G-SUBJECT) ------------------------------------------

/**
 * G-SUBJECT (guard-v3): competing subjects become "What caught your eye?"
 * buttons, so they pass the same checks as a published name. A label is kept
 * only when it has no medium word, no role or person descriptor, and every
 * name-like word in it (a capitalized word after the first, a maker, a model
 * code, or a single unknown capitalized word) is already published as a
 * candidate's name or read in the photo's kept visible text. A brand-like
 * label must have its brand read (brandReadIn) and, since guard-v9, every
 * other word of it too, unless it is a published name or its brand words name
 * a published reference that is not a brand (subjectBrandRead). Anything else
 * is dropped.
 */
/**
 * guard-v9 (round-3 Tune, h40 "OCBC Bank column sign"): a brand-like
 * "What caught your eye?" label repeats only what was read. Its brand words
 * are read (brandReadIn) and so is every other word of it, as for a brand
 * claim (G-BRAND-CORROBORATE), unless the label is itself a published name or
 * its brand words name a published reference that is not a brand (a place or
 * a sign read in the photo: "Fixture Harbour sign" next to the published place
 * "Fixture Harbour"). guard-v3 to v8 kept a label once its brand words were
 * read, so a read brand vouched for the object words around it ("column sign").
 */
function subjectBrandRead(
  label: string,
  texts: readonly string[],
  published: readonly (Pick<VlmCandidate, 'name'> & { type?: VlmCandidate['type'] })[],
): boolean {
  if (published.some((c) => candidateNameKey(c.name) === candidateNameKey(label))) return true;
  if (brandReadIn(label, texts) === null) return false;
  const brand = brandWords(label);
  const namesThing = published.some((c) => c.type !== undefined && c.type !== 'brand' && brand.every((w) => contentTokens(c.name).includes(w)));
  if (namesThing) return true;
  const words = contentTokens(stripParens(label)).filter(requiredWord);
  return words.every((w) => texts.some((t) => textHasToken(t, w)));
}

export function guardSubjects(
  labels: readonly string[],
  ctx: {
    /** Published references; `type` (when given) lets a read place or sign name vouch for a label (guard-v9). */
    published: readonly (Pick<VlmCandidate, 'name'> & { type?: VlmCandidate['type'] })[];
    texts: readonly string[];
    mentionsPeople?: boolean;
    /**
     * guard-v4: person names published only as text-only references. They
     * never become a "What caught your eye?" choice: a label sharing any word
     * of such a name is dropped, even though the name was read.
     */
    withheldPersons?: readonly string[];
  },
): { kept: string[]; dropped: string[] } {
  const known = [...ctx.published.map((c) => c.name), ...ctx.texts];
  const withheld = new Set((ctx.withheldPersons ?? []).flatMap(personWords));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const label of labels) {
    const words = label.trim().split(/\s+/);
    const tokens = contentTokens(label);
    const single = tokens.length === 1 && /^\p{Lu}/u.test(words[0] ?? '') && !knownWord(tokens[0]!);
    const nameLike = [...new Set([...properTokensAfterFirst(label), ...(single ? tokens : [])])];
    const brand = isBrandLike({ name: label, type: 'object' });
    const bad =
      !tokens.length ||
      MEDIUM_RE.test(label) ||
      hasMediumWord(label) ||
      (ctx.mentionsPeople !== false && ROLE_RE.test(label)) ||
      // guard-v12: the people test of the claims and the headline, on the labels too ("standing server
      // taking an order", "two seated customers"): a people, relationship, role or presence word always,
      // an occasion, team or role word (PEOPLE_CLAIM_RE) on a photo with people.
      peopleWordIn(label) ||
      (ctx.mentionsPeople === true && PEOPLE_CLAIM_RE.test(label)) ||
      PERSON_OBS_RE.test(label) ||
      VTEXT_RE.test(label) ||
      (brand && !subjectBrandRead(label, ctx.texts, ctx.published)) ||
      !nameLike.every((t) => known.some((k) => textHasToken(k, t))) ||
      tokens.some((t) => withheld.has(t));
    (bad ? dropped : kept).push(label);
  }
  return { kept, dropped };
}

function guardCompetingSubjects(
  a: VlmAnalysis,
  published: readonly Pick<VlmCandidate, 'name' | 'type'>[],
  texts: readonly string[],
  withheldPersons: readonly string[] = [],
  peopleObservations: VlmAnalysis['observations'] = a.observations,
): { subjects: VlmAnalysis['competing_subjects']; dropped: number } {
  // A role word is a person's role only when the reading shows people ("record player" on a shelf is a device).
  const mentionsPeople = readingFacts(a, texts, true, peopleObservations).mentionsPeople;
  const g = guardSubjects(
    a.competing_subjects.map((s) => s.label),
    { published, texts, mentionsPeople, withheldPersons },
  );
  const keep = new Set(g.kept);
  return {
    subjects: a.competing_subjects.filter((s) => keep.has(s.label)).map((s) => ({ ...s, region_ids: [...s.region_ids] })),
    dropped: g.dropped.length,
  };
}

function finalize(c: VlmCandidate, signals: DomainSignals): VlmCandidate {
  return { ...c, suggested_categories: categoriesFor(c, signals) };
}

const PERSON_RULES: ReadonlySet<GuardRule> = new Set(['G-IDENTITY', 'G-PERSON-ROLE']);
function decision(c: VlmCandidate, action: GuardAction, rules: GuardRule[], note?: string): GuardDecision {
  const withheld = action === 'drop' && rules.some((r) => PERSON_RULES.has(r));
  return { candidateId: c.id, name: withheld ? '[withheld]' : c.name, action, rules, ...(note ? { note } : {}) };
}

function demotedObservation(c: VlmCandidate, id: string): VlmAnalysis['observations'][number] {
  return { id, text: c.name, kind: 'object', region_ids: [...c.region_ids] };
}

function nextObservationId(used: readonly { id: string }[]): string {
  const taken = new Set(used.map((o) => o.id));
  let n = used.length + 1;
  while (taken.has(`o${n}`)) n++;
  return `o${n}`;
}

/**
 * guard-v10, G-PEOPLE-CLAIM on the headline: the title and the interpretation
 * are always shown, so they may not carry a claim about the people that the
 * candidate rules withhold (round-3 review: "Couple at their prom" stayed in
 * the headline while the "Prom" candidate was kept private; the h50–h79 blind
 * headlines said "wedding-style", "engagement-style", "Two friends",
 * "guardsman", "a server taking an order"). A headline line claims something
 * about the people when
 *  - it names a relationship or a person's role (PEOPLE_NOUN_RE), or
 *  - the reading shows people and it names a role (ROLE_RE) or an occasion,
 *    team, league or unit (PEOPLE_CLAIM_RE), or
 *  - it repeats a naming word of a claim withheld as being about the people
 *    (`withheld`: G-PEOPLE-CLAIM, a people-domain G-IDENTITY drop), other than
 *    a word a published claim also uses ("Basketball game" next to a withheld
 *    "Professional basketball" and a published "Basketball").
 * Such a line is replaced, not edited (removing the word leaves the inference
 * in the sentence: "a person taking an order"): on a photo that shows people
 * by NEUTRAL_PEOPLE_TITLE / NEUTRAL_PEOPLE_INTERPRETATION, otherwise the
 * title by the first publishable name or NEUTRAL_TITLE and the interpretation
 * by NEUTRAL_INTERPRETATION.
 */
function headlineClaimsPeople(
  text: string,
  ctx: { mentionsPeople: boolean; withheld: readonly Pick<VlmCandidate, 'name'>[]; publishable: readonly Pick<VlmCandidate, 'name'>[] },
): boolean {
  if (PEOPLE_NOUN_RE.test(text)) return true;
  if (ctx.mentionsPeople && (ROLE_RE.test(text) || PEOPLE_CLAIM_RE.test(text))) return true;
  const kept = new Set(ctx.publishable.flatMap((c) => contentTokens(stripParens(c.name))));
  return ctx.withheld.some((c) =>
    contentTokens(stripParens(c.name)).some(
      (t) => (t.length >= 3 || (isNonLatin(t) && t.length >= 2)) && !/^\d+$/.test(t) && !knownWord(t) && !kept.has(t) && textHasToken(text, t),
    ),
  );
}

interface HeadlineContext {
  mentionsPeople: boolean;
  /** Claims withheld because they are about the people (their naming words may not stay in the headline). */
  withheld: readonly Pick<VlmCandidate, 'name'>[];
}

/**
 * guard-v12: a headline line that talks as the assistant instead of describing the photo: the first
 * person ("which I will not follow", "my instructions") or instructions, prompts, rules or the assistant
 * (round-4 sweep h78: "a text card asking to print system instructions, which I will not follow").
 * Text inside quotation marks is a transcription and does not count.
 */
const META_SELF_RE =
  /\bI(?:['’](?:m|ll|ve|d)\b|\s+(?:am|will|won['’]t|would|cannot|can['’]t|can|do|don['’]t|did|have|must|should|need|see|note|refuse|decline)\b)|(?<![\p{L}'’-])(?:[Mm]e|[Mm]y|[Mm]yself)(?![\p{L}'’-])/u;
const META_TOPIC_RE =
  /\b(?:system|developer|hidden|initiali[sz]ation|previous|prior|original)\s+(?:instructions?|prompts?|rules|messages?)\b|\bsystem prompts?\b|\bprompt[- ]injections?\b|\bjailbreak\w*|\b(?:ignor|disregard|reveal|print|repeat|follow)\w*\s+(?:(?:all|the|any|these|those|my|your|its|previous|prior|above)\s+)*instructions?\b|\b(?:as an?|this|the) (?:AI|assistant|language model|chatbot)\b/i;
const QUOTED_RE = /"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’|(^|\s)'[^']*'(?=[\s.,;:!?]|$)/g;
export function metaCommentary(text: string): boolean {
  const unquoted = text.replace(QUOTED_RE, ' ');
  return META_SELF_RE.test(unquoted) || META_TOPIC_RE.test(unquoted);
}

function sanitizeHeadline(
  a: Pick<VlmAnalysis, 'title' | 'interpretation'>,
  publishable: readonly VlmCandidate[],
  people: HeadlineContext = { mentionsPeople: false, withheld: [] },
): { title: string; interpretation: string; changed: boolean; peopleClaim: boolean } {
  let title = a.title;
  let interpretation = a.interpretation;
  if (MEDIUM_RE.test(title)) {
    const stripped = stripMedium(title);
    title = wordCount(stripped) >= 2 ? stripped : (publishable[0]?.name.slice(0, 60) ?? NEUTRAL_TITLE);
  }
  if (MEDIUM_RE.test(interpretation)) {
    const stripped = stripMedium(interpretation);
    interpretation = wordCount(stripped) >= 2 ? stripped : NEUTRAL_INTERPRETATION;
  }
  const ctx = { ...people, publishable };
  // The replacement says that people are in the photo when the reading shows them (the people test
  // of stage 2 reads the published headline), and nothing about them.
  const shown = people.mentionsPeople || PEOPLE_NOUN_RE.test(`${a.title} ${a.interpretation}`);
  // guard-v12: a line in which the model talks about itself, its instructions or the prompt is replaced.
  if (metaCommentary(title)) title = shown ? NEUTRAL_PEOPLE_TITLE : (publishable[0]?.name.slice(0, 60) ?? NEUTRAL_TITLE);
  if (metaCommentary(interpretation)) interpretation = shown ? NEUTRAL_PEOPLE_INTERPRETATION : NEUTRAL_INTERPRETATION;
  let peopleClaim = false;
  if (headlineClaimsPeople(title, ctx)) {
    peopleClaim = true;
    title = shown ? NEUTRAL_PEOPLE_TITLE : (publishable.find((c) => !headlineClaimsPeople(c.name, ctx))?.name.slice(0, 60) ?? NEUTRAL_TITLE);
  }
  if (headlineClaimsPeople(interpretation, ctx)) {
    peopleClaim = true;
    interpretation = shown ? NEUTRAL_PEOPLE_INTERPRETATION : NEUTRAL_INTERPRETATION;
  }
  return { title, interpretation, changed: title !== a.title || interpretation !== a.interpretation, peopleClaim };
}

/** guard-v10: candidates a decision withheld as claims about the people (their words may not stay in the headline). */
function peopleWithheldBy(decisions: readonly GuardDecision[], candidates: readonly VlmCandidate[]): VlmCandidate[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return decisions
    .filter(
      (d) =>
        d.rules.includes('G-PEOPLE-CLAIM') ||
        (d.action === 'drop' && d.rules.includes('G-IDENTITY') && byId.get(d.candidateId)?.type !== 'creator'),
    )
    .map((d) => byId.get(d.candidateId))
    .filter((c): c is VlmCandidate => !!c);
}

// ---- stage 1 -------------------------------------------------------------------

/**
 * Guards a stage-1 reading (a two-stage quick read, a v2 frame aggregate, or
 * the legacy full reading) before anything is resolved or published.
 * `twoStage` says whether a stage-2 enrichment can still confirm held claims;
 * without it, claims that would be held are dropped.
 */
export function guardQuickRead(a: VlmAnalysis, ctx: { twoStage: boolean }): Stage1Guard {
  const texts = sanitizeVisibleText(a.visible_text.map((t) => t.text), { vehicle: readingShowsVehicle(a) });
  const keptText = new Set(texts.kept);
  // guard-v12: the people test reads the reading before anything is removed (peopleShown).
  const obs = sanitizeObservations(a.observations, { people: peopleShown(a, a.observations) });
  const base: VlmAnalysis = {
    ...structuredClone(a),
    visible_text: a.visible_text.filter((t) => keptText.has(t.text)).map((t) => ({ ...t })),
    observations: obs.kept.map((o) => ({ ...o, region_ids: [...o.region_ids] })),
  };
  const decisions: GuardDecision[] = [];

  // G-QUAL: an unusable or flawed photo publishes no candidates at all.
  if (!a.quality.usable || a.quality.issue !== null) {
    for (const c of a.candidates) decisions.push(decision(c, 'drop', ['G-QUAL']));
    // guard-v10: an unusable photo's headline is still shown, so it passes the people test too.
    const headline = sanitizeHeadline(base, [], { mentionsPeople: readingFacts(base, texts.kept, false, a.observations).mentionsPeople, withheld: [] });
    const subjects = guardCompetingSubjects(base, [], texts.kept, [], a.observations);
    const dropped = { visibleText: texts.dropped.length, observations: obs.dropped.length, subjects: subjects.dropped };
    return {
      analysis: {
        ...base,
        title: headline.title,
        interpretation: headline.interpretation,
        candidates: [],
        competing_subjects: subjects.subjects,
        quality: { usable: false, issue: a.quality.issue },
      },
      held: [],
      demoted: [],
      decisions,
      titleChanged: headline.changed,
      dropped,
    };
  }

  // guard-v7: the people test reads the observations before person descriptions are removed.
  const facts = readingFacts(base, texts.kept, false, a.observations);
  const publish: VlmCandidate[] = [];
  const held: VlmCandidate[] = [];
  const demoted: VlmCandidate[] = [];
  const names = new Set<string>();
  for (const original of base.candidates) {
    const v = evaluate(original, facts, { stage: 1, twoStage: ctx.twoStage, addition: false });
    let rules = v.rules;
    if (v.replacement) {
      // The "X-style" candidate is dropped; its replacement gets its own decision.
      decisions.push(decision(original, 'drop', ['G-STYLE-OF'], 'replaced_by_tag_query'));
      rules = rules.filter((r) => r !== 'G-STYLE-OF');
    }
    if (v.action === 'drop' || v.action === 'observe') {
      decisions.push(decision(v.candidate, v.action, rules, v.note));
      continue;
    }
    // A replacement that repeats another candidate's name adds nothing.
    const key = candidateNameKey(v.candidate.name);
    if (names.has(key)) {
      decisions.push(decision(v.candidate, 'drop', rules, 'duplicate'));
      continue;
    }
    names.add(key);
    decisions.push(decision(v.candidate, v.action, rules, v.note));
    const out = finalize(v.candidate, facts.signals);
    if (v.action === 'hold') held.push(out);
    else if (v.action === 'demote') demoted.push(out);
    else publish.push(out);
  }
  for (const d of decisions) if (d.action === 'publish') d.rules.push('G-CATEGORY');

  const observations = [...base.observations];
  for (const c of demoted) observations.push(demotedObservation(c, nextObservationId(observations)));
  const headline = sanitizeHeadline(base, publish, {
    mentionsPeople: facts.mentionsPeople,
    withheld: peopleWithheldBy(decisions, base.candidates),
  });
  const subjects = guardCompetingSubjects(base, publish, texts.kept, [], a.observations);
  const dropped = { visibleText: texts.dropped.length, observations: obs.dropped.length, subjects: subjects.dropped };
  return {
    analysis: {
      ...base,
      title: headline.title,
      interpretation: headline.interpretation,
      observations,
      candidates: publish,
      competing_subjects: subjects.subjects,
    },
    held,
    demoted,
    decisions,
    titleChanged: headline.changed,
    dropped,
  };
}

/**
 * What stage 2 is asked to check, exactly as production sends it: the
 * published title and the published candidates followed by the held claims
 * (the only way a held claim can publish). Shared by the compiler, the
 * qualification harness and the live evaluation so all three send the same
 * stage-2 input.
 */
export function stage2Request(published: VlmAnalysis, held: readonly VlmCandidate[]): { title: string; candidates: string[] } {
  return { title: published.title, candidates: [...published.candidates, ...held].map((c) => c.name) };
}

/**
 * Ids of the candidates that published with G-BRAND-CORROBORATE (their brand
 * word was transcribed at stage 2 and the claim was confirmed). Only these
 * brand-like candidates may be searched in Qloo as brands (grounding §5).
 */
export function brandCorroboratedIds(
  decisions: readonly { candidateId: string; action: string; rules: readonly string[] }[],
): Set<string> {
  return new Set(
    decisions
      // A text-only reference (G-TEXT-ONLY) is never searched in Qloo, corroborated or not.
      .filter((d) => d.action === 'publish' && d.rules.includes('G-BRAND-CORROBORATE') && !d.rules.includes('G-TEXT-ONLY'))
      .map((d) => d.candidateId),
  );
}

/** Decision note of a G-TEXT-ONLY publication (the inspector's reason code). */
export const TEXT_ONLY_NOTE = 'single_read_text_only';

/**
 * guard-v8: a maker named in a brand claim (MAKERS: "bmw" of "BMW Vision
 * EfficientDynamics", "nissan" of "Nissan X-Trail") whose word is a whole
 * token of a stage-2 transcription. Returns the maker as it is written there
 * ("BMW") and the transcription, or null. Used when the full name was not
 * read, so the reading still lists what the photo says (a text-only brand
 * reference), never the model name it could not read.
 */
export function readMaker(name: string, texts: readonly string[]): { maker: string; text: string } | null {
  for (const token of contentTokens(stripParens(name))) {
    if (!MAKERS.has(token)) continue;
    for (const text of texts) {
      if (!textHasToken(text, token)) continue;
      const written = text.split(/[^\p{L}\p{N}]+/u).find((w) => foldText(w) === token);
      if (written) return { maker: written, text };
    }
  }
  return null;
}

/**
 * guard-v11 (round 4, h67 "BMW Z4" with only "Z4" read): the counterpart of
 * readMaker. A brand claim whose maker (MAKERS) was not transcribed, but whose
 * other brand words were, each a whole token of one stage-2 transcription,
 * with at least one of them a model code (letters and digits: "Z4", "A4",
 * "CAAD8"; a word such as "NBA" or "Beetle" is not enough): returns those words as they are written there ("Z4") and the
 * transcription, or null. The words are published as a text-only brand
 * reference, never the maker the reading could not read.
 */
export function readModel(name: string, texts: readonly string[]): { model: string; text: string } | null {
  const words = brandWords(name);
  const makers = words.filter((t) => MAKERS.has(t));
  if (!makers.length || texts.some((text) => makers.some((t) => textHasToken(text, t)))) return null;
  const naming = namingTokens(name);
  const model = words.filter((t) => !MAKERS.has(t) && requiredWord(t));
  if (!model.length || !model.some((t) => isModelCode(t) && naming.has(t))) return null;
  for (const text of texts) {
    if (!model.every((t) => textHasToken(text, t))) continue;
    const written = model.map((t) => text.split(/[^\p{L}\p{N}]+/u).find((w) => foldText(w) === t)).filter((w): w is string => !!w);
    if (written.length === model.length) return { model: written.join(' '), text };
  }
  return null;
}

// ---- stage 2 -------------------------------------------------------------------

/**
 * Guards a merged stage-2 reading. `published` is the stage-1 guard's
 * analysis (what was published), `held` its held claims, and `merged`/`merge`
 * the result of mergeEnrichmentContext(published, enrichment, held).
 *  - published candidates stay, in order (FAST-02); an unsupported verdict is
 *    reported as an advisory veto;
 *  - held claims: no entry -> drop; weak or unsupported -> a private
 *    observation (guard-v8; never published, whatever the type); supported ->
 *    publish, brand-like only with G-BRAND-CORROBORATE (G-VERDICT);
 *  - additions: the stage-1 rules plus G-ADDITION-FLOOR; a claim that would
 *    be held has nothing left to confirm it and is dropped (on context alone:
 *    a private observation, G-EVIDENCE); brand-like additions publish only
 *    with G-BRAND-CORROBORATE;
 *  - a brand claim whose full name was not read but whose maker was keeps
 *    the maker as a text-only brand reference (guard-v8, readMaker).
 * `nonAnchorIds` stays in the result for compatibility and is always empty
 * since guard-v8 (a weak verdict no longer publishes).
 */
export function guardEnrichment(input: {
  published: VlmAnalysis;
  held: VlmCandidate[];
  merged: VlmAnalysis;
  merge: VlmMergeContext;
}): Stage2Guard {
  const { published, merged, merge } = input;
  const firstRead = stage1Texts(published, input.held);
  const texts = sanitizeVisibleText(merged.visible_text.map((t) => t.text), { vehicle: readingShowsVehicle(merged) });
  const keptText = new Set(texts.kept);
  const stage2Texts = merge.stage2Text.filter((t) => keptText.has(t));
  const obs = sanitizeObservations(merged.observations, {
    people: peopleShown({ ...merged, title: published.title, interpretation: published.interpretation }, merged.observations),
  });
  const usable = published.quality.usable && published.quality.issue === null;
  const byId = new Map(merged.candidates.map((c) => [c.id, c]));
  const verdictOf = (c: VlmCandidate) => merge.verdicts[candidateNameKey(c.name)];
  const decisions: GuardDecision[] = [];
  // guard-v12: a highly uncertain second reading confirms nothing (sonnet h49: a blurred photo).
  const uncertain = merged.uncertainty?.overall === 'high';

  const publishedIds = new Set(published.candidates.map((c) => c.id));
  const kept = merged.candidates.filter((c) => publishedIds.has(c.id));
  const advisoryVetoes = kept.filter((c) => verdictOf(c) === 'unsupported').map((c) => c.name);

  const facts = readingFacts(
    { ...merged, title: published.title, interpretation: published.interpretation, observations: merged.observations },
    texts.kept,
    true,
  );
  const publishNow: VlmCandidate[] = [];
  const nonAnchorIds: string[] = [];
  const textOnlyIds: string[] = [];
  const withheldPersons: string[] = [];
  const peopleWithheld: VlmCandidate[] = [];
  const demotedObs: VlmCandidate[] = [];
  const names = new Set(kept.map((c) => candidateNameKey(c.name)));
  const accept = (c: VlmCandidate, rules: GuardRule[], note?: string) => {
    const key = candidateNameKey(c.name);
    if (names.has(key)) {
      decisions.push(decision(c, 'drop', rules, 'duplicate'));
      return false;
    }
    names.add(key);
    decisions.push(decision(c, 'publish', [...rules, 'G-CATEGORY'], note));
    publishNow.push(finalize(c, facts.signals));
    return true;
  };
  /**
   * G-TEXT-ONLY (guard-v4, decision 2): a stage-2 addition naming a brand or
   * a person whose every word is transcribed at stage 2, but which the
   * stage-1 call never said (a single read). It publishes as a text-only
   * reference: the text it was read from becomes its evidence_text, it gets
   * no category (never a discovery signal), and the compiler never resolves,
   * anchors or researches it. A person's name stays "resembles" (a credit on
   * a poster is not the person) and never becomes a subject choice.
   */
  const acceptTextOnly = (c: VlmCandidate, read: string, rules: GuardRule[], person: boolean) => {
    const key = candidateNameKey(c.name);
    if (names.has(key)) {
      decisions.push(decision(c, 'drop', rules, 'duplicate'));
      return;
    }
    names.add(key);
    decisions.push(decision(c, 'publish', [...rules, 'G-TEXT-ONLY'], TEXT_ONLY_NOTE));
    publishNow.push({
      ...c,
      evidence: 'read_text',
      evidence_text: read.slice(0, 60),
      relation: person ? 'resembles' : c.relation,
      suggested_categories: [],
      tag_queries: [],
      text_only: true,
    });
    textOnlyIds.push(c.id);
    if (person) withheldPersons.push(c.name);
  };
  /**
   * guard-v8: a brand claim whose full name was not transcribed at stage 2,
   * but whose maker was ("BMW" for "BMW Vision EfficientDynamics"): the maker
   * publishes as a text-only brand reference named as written, and the claim
   * itself is dropped. Returns false when no maker was read.
   */
  const acceptReadMaker = (c: VlmCandidate, rules: GuardRule[]): boolean => {
    const read = readMaker(c.name, stage2Texts);
    if (!read) return false;
    const key = candidateNameKey(read.maker);
    if (names.has(key)) return false;
    names.add(key);
    decisions.push({ candidateId: c.id, name: read.maker, action: 'publish', rules: [...rules, 'G-TEXT-ONLY'], note: EVIDENCE_NOTES.readMaker });
    publishNow.push({
      ...c,
      name: read.maker,
      type: 'brand',
      relation: 'depicted',
      evidence: 'read_text',
      evidence_text: read.text.slice(0, 60),
      suggested_categories: [],
      tag_queries: [],
      text_only: true,
    });
    textOnlyIds.push(c.id);
    return true;
  };
  /**
   * guard-v11: a brand claim whose model name was transcribed at stage 2 ("Z4" of "BMW Z4") but
   * whose maker was not: the model name publishes as written, as a text-only brand reference (never
   * searched, anchored or researched), and the claim itself is dropped. Returns false when nothing was read.
   */
  const acceptReadModel = (c: VlmCandidate, rules: GuardRule[]): boolean => {
    const read = readModel(c.name, stage2Texts);
    if (!read) return false;
    const key = candidateNameKey(read.model);
    if (names.has(key)) return false;
    names.add(key);
    decisions.push({ candidateId: c.id, name: read.model, action: 'publish', rules: [...rules, 'G-TEXT-ONLY'], note: EVIDENCE_NOTES.readModel });
    publishNow.push({
      ...c,
      name: read.model,
      type: 'brand',
      relation: 'depicted',
      evidence: 'read_text',
      evidence_text: read.text.slice(0, 60),
      suggested_categories: [],
      tag_queries: [],
      text_only: true,
    });
    textOnlyIds.push(c.id);
    return true;
  };
  const notRead = (c: VlmCandidate, rules: GuardRule[], note: string) => {
    decisions.push(decision(c, 'drop', rules, note));
    if (!acceptReadMaker(c, rules)) acceptReadModel(c, rules);
  };

  for (const id of merge.heldIds) {
    const c = byId.get(id);
    if (!c) continue;
    const guarded = { ...c, ...evidenceFor(c, texts.kept), domain: domainOf(c) };
    if (!usable) {
      decisions.push(decision(guarded, 'drop', ['G-QUAL']));
      continue;
    }
    if (uncertain) {
      decisions.push(decision(guarded, 'drop', ['G-VERDICT'], EVIDENCE_NOTES.uncertainSecondReading));
      continue;
    }
    const verdict = verdictOf(c);
    const brandLike = isBrandLike(guarded, { knownWords: facts.knownWords, brandResidue: facts.brandResidue });
    const person = c.type === 'creator' || guarded.domain === 'people';
    // G-PEOPLE-CLAIM (guard-v8): people seen only at stage 2 make a held claim about them
    // (an occasion, a role, a style of the person) a private observation unless it rests on read text.
    // guard-v10: read text backs it only when stage 2 transcribed the claim's words (claimReadIn), never on
    // the model's own read_text label (a "supported" verdict published it with any evidence_text), and the
    // claim is about the people by class or by word (PEOPLE_CLAIM_RE), whatever its type and domain.
    const aboutThePeople =
      aboutPeople(c) || playStyleOfPeople(c, true) || (c.type !== 'brand' && PEOPLE_CLAIM_RE.test(c.name));
    if (!person && facts.mentionsPeople && aboutThePeople && !(guarded.evidence === 'read_text' && claimReadIn(c.name, stage2Texts))) {
      peopleWithheld.push(guarded);
      decisions.push(decision(guarded, 'observe', ['G-PEOPLE-CLAIM'], EVIDENCE_NOTES.peopleClaim));
      continue;
    }
    if (!verdict) {
      decisions.push(decision(guarded, 'drop', ['G-VERDICT'], 'no_confirmation'));
      continue;
    }
    // guard-v8: a weak or unsupported second reading never publishes a held claim (guard-v7
    // published a weak style or tradition as a non-anchor resemblance); it stays a private
    // observation for the inspector. A person's name is still withheld from the trace.
    if (verdict === 'unsupported' || verdict === 'weak') {
      decisions.push(decision(guarded, person ? 'drop' : 'observe', person ? ['G-VERDICT', 'G-IDENTITY'] : ['G-VERDICT'], verdict));
      continue;
    }
    if (person) {
      // guard-v3: a person or creator named at stage 1 publishes only when stage 2 also transcribed every word of the name.
      const read = personReadIn(c.name, stage2Texts);
      if (!read) {
        decisions.push(decision(guarded, 'drop', ['G-VERDICT', 'G-IDENTITY'], 'not_read_at_stage_2'));
        continue;
      }
      accept({ ...guarded, evidence: 'read_text', evidence_text: read.slice(0, 60) }, ['G-VERDICT', 'G-IDENTITY']);
      continue;
    }
    // guard-v11: a well-known work named by its form needs the second reading's support, not a transcription.
    if (brandLike && titledWork({ ...guarded, evidence: c.evidence ?? null, domain: c.domain ?? null })) {
      accept({ ...guarded, relation: 'resembles' }, ['G-VERDICT'], EVIDENCE_NOTES.workByForm);
      continue;
    }
    if (brandLike) {
      const read = corroboratingText(c.name, stage2Texts);
      if (!read) {
        notRead(guarded, ['G-VERDICT', 'G-BRAND-CORROBORATE'], 'not_read_at_stage_2');
        continue;
      }
      // Its name is now read in the photo: the claim rests on text, and is depicted when certain enough.
      accept(
        {
          ...guarded,
          evidence: 'read_text',
          evidence_text: read.slice(0, 60),
          relation: guarded.certainty >= DEPICTED_MIN ? 'depicted' : 'resembles',
        },
        ['G-VERDICT', 'G-BRAND-CORROBORATE'],
      );
      continue;
    }
    accept(guarded, ['G-VERDICT']);
  }

  // guard-v12: the work claims of the first reading that are shown now (published at stage 1, or held
  // and supported above), by title: a stage-2 "<Title> by <Creator>" repeating one is the same work.
  const firstWorks = [...published.candidates, ...input.held].filter((w) => w.type === 'work');
  const shownWorkTitles = new Set(
    [...kept, ...publishNow].filter((w) => w.type === 'work').map((w) => candidateNameKey(workTitle(w.name))),
  );
  for (const id of merge.additionIds) {
    const c = byId.get(id);
    if (!c) continue;
    if (!usable) {
      decisions.push(decision(c, 'drop', ['G-QUAL']));
      continue;
    }
    if (uncertain) {
      decisions.push(decision(c, 'drop', ['G-VERDICT'], EVIDENCE_NOTES.uncertainSecondReading));
      continue;
    }
    // guard-v12, one depicted work per reading: a work title read at stage 2 next to a work the first
    // reading named ("Producer of GONE WITH THE WIND" on the "Rebecca" poster) is a mention, a credit
    // line, never a reference. The same title read again is not a second work.
    if (
      c.type === 'work' &&
      c.evidence === 'read_text' &&
      firstWorks.length > 0 &&
      !firstWorks.some((w) => candidateNameKey(workTitle(w.name)) === candidateNameKey(workTitle(c.name)))
    ) {
      decisions.push(decision(c, 'observe', ['G-TEXT-ECHO'], EVIDENCE_NOTES.workMention));
      continue;
    }
    const v = evaluate(c, facts, { stage: 2, twoStage: true, addition: true });
    const candidate = v.candidate;
    if (v.action === 'drop' || v.action === 'observe') {
      decisions.push(decision(candidate, v.action, v.rules, v.note));
      continue;
    }
    // guard-v12: "<Title> by <Creator>" whose title is a work the first reading named and that is shown
    // now ("David" at stage 1, "David by Michelangelo" at stage 2): two readings name the same work, so it
    // publishes as a resemblance; the creator is shown only inside the work's name, never as a person.
    if (
      v.action === 'publish' &&
      titledWork({ ...candidate, evidence: c.evidence ?? null, domain: c.domain ?? null }) &&
      workTitle(candidate.name) !== candidate.name &&
      shownWorkTitles.has(candidateNameKey(workTitle(candidate.name)))
    ) {
      accept({ ...candidate, relation: 'resembles' }, [...v.rules, 'G-VERDICT'], EVIDENCE_NOTES.workByForm);
      continue;
    }
    if (candidate.type === 'creator' || candidate.domain === 'people') {
      // guard-v3: a person added at stage 2 needs the name transcribed at stage 2 ...
      const read = personReadIn(candidate.name, stage2Texts);
      if (!read) {
        decisions.push(decision(candidate, 'drop', [...v.rules, 'G-IDENTITY'], 'not_read_at_stage_2'));
        continue;
      }
      // ... and named at stage 1 to be a full reference. guard-v4: named only in the stage-2 reply,
      // it is a text-only reference (never an identity, an anchor or a Qloo search).
      if (!personReadIn(candidate.name, firstRead)) {
        if (v.action === 'hold') {
          decisions.push(decision(candidate, 'drop', [...v.rules, 'G-IDENTITY'], 'held_at_stage_2'));
          continue;
        }
        acceptTextOnly(candidate, read, [...v.rules, 'G-IDENTITY'], true);
        continue;
      }
    }
    if (isBrandLike(candidate, { knownWords: facts.knownWords, brandResidue: facts.brandResidue })) {
      const head = brandHeadToken(candidate.name);
      const own =
        (candidate.evidence === 'read_text' || candidate.evidence === 'logo') &&
        !!head &&
        !!candidate.evidence_text &&
        textHasToken(candidate.evidence_text, head);
      const read = own ? corroboratingText(candidate.name, stage2Texts) : null;
      if (read === null) {
        notRead(candidate, [...v.rules, 'G-BRAND-CORROBORATE'], 'not_read_at_stage_2');
        continue;
      }
      if (v.action === 'hold') {
        // Corroborated by its own transcription; any other hold reason still has nothing left to confirm it.
        const other = v.rules.filter((r) => r === 'G-TEXT-ECHO' || r === 'G-LOWCERT');
        if (other.length) {
          decisions.push(decision(candidate, 'drop', [...v.rules, 'G-BRAND-CORROBORATE'], 'held_at_stage_2'));
          continue;
        }
      }
      // guard-v3: the claim, its evidence_text and the transcription all come from one reply;
      // the brand words must also be in what the stage-1 call said (a second, separate reading)
      // for a full reference. guard-v4: otherwise it is a text-only reference, never searched.
      if (brandReadIn(candidate.name, firstRead) === null) {
        acceptTextOnly(candidate, read, [...v.rules, 'G-BRAND-CORROBORATE'], false);
        continue;
      }
      accept(candidate, [...v.rules, 'G-BRAND-CORROBORATE']);
      continue;
    }
    if (v.action === 'hold') {
      // guard-v8: an addition resting on context alone is a private observation, not a reference.
      if (v.rules.includes('G-EVIDENCE')) decisions.push(decision(candidate, 'observe', v.rules, EVIDENCE_NOTES.contextOnly));
      else decisions.push(decision(candidate, 'drop', v.rules, 'held_at_stage_2'));
      continue;
    }
    if (v.action === 'demote') {
      decisions.push(decision(candidate, 'demote', v.rules));
      demotedObs.push(candidate);
      continue;
    }
    accept(candidate, v.rules);
  }

  const observations = obs.kept.map((o) => ({ ...o, region_ids: [...o.region_ids] }));
  for (const c of demotedObs) observations.push(demotedObservation(c, nextObservationId(observations)));
  const candidates = [...kept.map((c) => ({ ...c })), ...publishNow];
  // G-SUBJECT: stage-2 competing subjects become "What caught your eye?" choices; they pass the guard too.
  const subjects = guardCompetingSubjects(merged, usable ? candidates : [], texts.kept, withheldPersons);
  // guard-v10: the published headline passes the people test again with what stage 2 shows (people seen
  // only now, claims withheld only now). A headline that now claims something about the people is
  // replaced (a retraction; nothing is added): `headlineChanged`, written by the compiler.
  const headline = sanitizeHeadline(published, usable ? candidates : [], {
    mentionsPeople: facts.mentionsPeople,
    withheld: [...peopleWithheld, ...peopleWithheldBy(decisions, merged.candidates)],
  });
  const analysis: VlmAnalysis = {
    ...structuredClone(merged),
    title: headline.title,
    interpretation: headline.interpretation,
    quality: { ...published.quality },
    visible_text: merged.visible_text.filter((t) => keptText.has(t.text)).map((t) => ({ ...t })),
    observations,
    candidates,
    competing_subjects: subjects.subjects,
  };
  return {
    publishNow,
    advisoryVetoes,
    nonAnchorIds,
    textOnlyIds,
    analysis,
    decisions,
    headlineChanged: headline.changed,
    dropped: { visibleText: texts.dropped.length, observations: obs.dropped.length, subjects: subjects.dropped },
  };
}
