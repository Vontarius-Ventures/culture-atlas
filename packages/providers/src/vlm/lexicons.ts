/**
 * Word lists for the deterministic reading guardrails (docs/quality-plan.md
 * §4, guard-v2). Pure data plus two tokenizer helpers; no I/O.
 *
 * The lists were seeded from the recorded phase-4 readings of the 15 tuning
 * photos (never from the held-out split). Changing any list changes the
 * guardrail behaviour: bump GUARDRAIL_VERSION in guardrails.ts with it, which
 * un-qualifies the photo roles until they are re-evaluated (§2, §7.5).
 */

/**
 * Lower-cases, strips accents and splits on anything that is not a letter or
 * a digit. Latin text matches `normalizeName` in the compiler; CJK and other
 * non-Latin letters are kept verbatim (normalizeName would drop them), so a
 * sign read as 愚园路 can be compared with a candidate name.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Folded name tokens ("normalizeName tokens", CJK kept). */
export function nameTokens(value: string): string[] {
  const folded = foldText(value);
  return folded ? folded.split(' ') : [];
}

/** True when a token contains a CJK or other non-Latin letter (compared verbatim, never tokenized further). */
export function isNonLatin(token: string): boolean {
  return /[^\p{Script=Latin}\p{N}]/u.test(token);
}

const set = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));

/** Function words that never count as content tokens. */
export const STOP = set(`
  a an the of and or in on at with for from to by as into near
  de du des la le les el los las di da del della der die das den van von y et e
`);

/**
 * Everyday object nouns: a candidate made only of these (plus colours,
 * materials and qualifiers) is a generic object, not a cultural reference
 * (G-GENERIC), and a capitalized one never makes a name brand-like (G-BRAND).
 */
export const GENERIC_NOUNS = set(`
  ball basketball football soccerball hoop net rim backboard court
  bicycle bicycles bike bikes cycle frame handlebar handlebars saddle wheel wheels tire tires tyre tyres
  bag bags grocery groceries shopping supermarket supermarkets trolley cart basket baskets box boxes crate crates bucket
  chandelier chandeliers lamp lamps light lights lantern
  fruit fruits kiwi kiwis kiwifruit lime limes lemon lemons orange oranges banana bananas cabbage citrus apple apples
  salad salads vegetable vegetables produce bread loaf loaves meal meals snack snacks drink drinks
  table tables tabletop top chair chairs armchair armchairs sofa sofas couch bench benches stool stools bed beds
  desk desks cabinet cabinets cabinetry chest drawers dresser shelf shelves shelving bookcase rack sideboard
  furniture furnishings decor ornament ornaments rug rugs carpet carpets curtain curtains blind blinds
  shutter shutters window windows door doors wall walls floor floors ceiling ceilings roof roofs
  staircase staircases stairs stair steps step railing railings balustrade balusters column columns arch arches
  dome domes tower towers turret turrets building buildings house houses home homes room rooms sunroom
  kitchen bathroom bedroom interior interiors exterior facade facades porch balcony balconies terrace courtyard yard
  hall hallway corridor lobby entrance
  street streets road roads sidewalk pavement lane alley avenue crossing intersection
  city cities town village district ward neighborhood neighbourhood skyline
  sign signs signage signpost placard placards plaque label labels poster posters banner billboard
  car cars sedan sedans suv suvs truck trucks pickup bus buses van vans vehicle vehicles taxi taxis
  motorcycle motorbike scooter train trains tram trams boat boats ship ships plane airplane
  trunk hatch cargo engine seat seats taillight taillights headlight headlights bumper license licence plate plates
  dog dogs cat cats bird birds horse horses animal animals pet pets
  tree trees plant plants flower flowers leaf leaves grass sky cloud clouds water river sea beach mountain mountains
  display displays case cases vitrine shop shops store stores stall stalls
  cup cups mug mugs plate plates bowl bowls vase vases jar jars pot pots bottle bottles glass glasses
  teapot kettle pan pans knife knives fork forks spoon spoons chopsticks tableware cutlery tray trays
  sculpture sculptures statue statues bust busts niche niches figurine figurines mirror mirrors clock clocks
  phone phones laptop computer screen screens tv television camera cameras book books magazine newspaper
  shoe shoes sneaker sneakers boot boots hat hats cap caps jacket jackets coat coats shirt shirts tshirt tee
  dress dresses skirt skirts trousers pants jeans suit suits tie ties scarf scarves glove gloves sunglasses
  backpack umbrella toy toys pen pens pencil notebook
  cushion cushions pillow pillows blanket blankets towel towels cloth tablecloth
  fence fences gate gates pole poles post posts bridge bridges fountain fountains
  item items object objects thing things scene scenes view views setting background piece pieces
  pattern patterns texture textures shape shapes panel panels tile tiles emblem emblems logo logos
  person people man men woman women child children crowd pedestrian pedestrians
`);

/** Colour words (G-GENERIC). */
export const COLOURS = set(`
  red orange yellow green blue purple violet pink brown black white grey gray silver gold golden
  beige cream ivory navy teal turquoise maroon crimson scarlet tan khaki olive amber
  multicolored multicoloured colorful colourful pastel neon
`);

/** Material words (G-GENERIC). */
export const MATERIALS = set(`
  wood wooden timber glass metal metallic steel iron wrought brass bronze copper tin
  stone marble granite concrete brick bricks ceramic ceramics porcelain clay terracotta
  leather cotton wool linen silk velvet fabric textile plastic paper kraft cardboard
  wicker rattan bamboo crystal rubber chrome aluminium aluminum enamel lacquer felt fur straw jute
`);

/** Qualifiers that do not make an object specific (G-GENERIC; skipped by brandHeadToken). */
export const GENERIC_QUALIFIERS = set(`
  outdoor indoor modern contemporary vintage classic traditional old new large small big little tall short
  round square long wide narrow open closed empty full sliced whole half fresh raw cooked
  ornate decorative simple plain everyday casual formal urban rural public private local domestic
  double decker single multi high low front rear side back upper lower dark bright pale shiny glossy matte
  handmade hand made dining living sports sport type kind gilded carved glazed woven polished ornamental
  suburban american european asian
`);

/**
 * Maker names that make any candidate brand-like (G-BRAND), even when typed
 * as an object or style. Only names that are not ordinary English words.
 */
export const MAKERS = set(`
  nissan honda toyota ford bmw mercedes benz audi volkswagen vw porsche ferrari lamborghini maserati tesla
  chevrolet chevy jeep hyundai kia mazda subaru lexus volvo fiat peugeot renault citroen skoda jaguar
  bentley rolls royce bugatti alfa romeo ducati harley davidson kawasaki suzuki yamaha vespa
  cannondale bianchi colnago pinarello cervelo shimano campagnolo brompton
  spalding wilson nike adidas puma reebok asics converse newbalance fila umbro
  gucci prada chanel dior hermes vuitton balenciaga versace armani burberry fendi valentino
  givenchy celine loewe moncler lacoste ralph lauren levis uniqlo zara
  samsung sony canon nikon leica fujifilm panasonic lg philips bose
  ikea lego rolex casio seiko swatch tissot cartier
  starbucks cocacola pepsi heineken
`);

/** Words that put a legacy (v1) candidate in the fashion domain (§4.4). */
export const FASHION = set(`
  fashion menswear womenswear streetwear sportswear workwear outerwear knitwear eyewear footwear
  tailoring tailored couture garment garments apparel clothing outfit outfits
  dress dresses suit suits coat coats jacket jackets trench denim jeans sneaker sneakers shoe shoes
  handbag handbags scarf scarves sunglasses kimono sari hanbok shearling tweed cashmere lingerie
  jewelry jewellery preppy
`);

/** Words that put a legacy (v1) candidate in the music domain (§4.4). */
export const MUSIC = set(`
  music musical jazz blues bossa rap hiphop rock punk disco techno reggae funk opera symphony orchestra
  band bands album albums vinyl concert concerts song songs samba tango flamenco mariachi gospel
  grunge shoegaze ambient edm dj turntable guitar piano synth synthwave lofi kpop jpop
`);
/** Multi-word music phrases. */
export const MUSIC_PHRASES = ['hip hop', 'city pop', 'bossa nova', 'k pop', 'j pop'] as const;

/** Words that put a legacy (v1) candidate in the film domain (§4.4). */
export const FILM = set(`
  film films cinema cinematic movie movies noir documentary anime sitcom hollywood bollywood nollywood
  kaiju giallo
`);
export const FILM_PHRASES = ['nouvelle vague', 'new wave cinema', 'spaghetti western', 'tv series'] as const;

/**
 * Food words that put a legacy (v1) candidate in the food domain (§4.4).
 * Kept narrow on purpose: colour, venue and furniture words ("orange",
 * "market", "coffee table") would misplace non-food references in Eat.
 */
export const FOOD = set(`
  dish dishes meal meals noodle noodles ramen udon soba pho sushi sashimi dumpling dumplings dimsum tapas pizza pasta
  taco tacos curry stew soup soups salad salads bread breads bakery pastry pastries cake cakes dessert desserts
  chocolate cheese wine cocktail cocktails spritz aperitivo aperitif izakaya bistro brasserie trattoria
  restaurant restaurants cafe cafes diner barbecue bbq kebab falafel sandwich burger fries
  fruit fruits kiwifruit citrus cabbage vegetable vegetables rice seafood tofu omelette breakfast brunch
  cuisine cuisines food foods fare culinary gastronomy
`);
export const FOOD_PHRASES = ['dim sum', 'street food'] as const;
/** Food references by name ending (G-CUISINE-FOOD applies to them like to type cuisine). */
export const FOOD_NAME_ENDINGS = set('cuisine cuisines food foods fare dishes');
/**
 * Evidence that food is actually in the photo (G-CUISINE-FOOD): concrete
 * food, produce and dining words. "cuisine", "food" and "fare" are absent on
 * purpose: a reading that only says "cuisine" has not shown any food.
 */
export const FOOD_EVIDENCE = set(`
  dish dishes meal meals noodle noodles ramen udon soba pho sushi sashimi dumpling dumplings dimsum tapas pizza pasta
  taco tacos curry stew soup soups salad salads bread breads loaf bakery pastry pastries cake cakes dessert desserts
  chocolate cheese wine cocktail cocktails spritz aperitivo aperitif izakaya bistro brasserie trattoria
  restaurant restaurants cafe cafes diner barbecue bbq kebab falafel sandwich burger fries
  fruit fruits kiwi kiwis kiwifruit lime limes lemon lemons citrus banana bananas cabbage orange oranges apple apples
  tomato tomatoes vegetable vegetables produce groceries rice seafood fish chili chilli tofu egg eggs omelette
  breakfast lunch dinner supper brunch menu kitchen market coffee tea beer snack snacks
`);

/** True when `phrase` occurs in the folded text on word boundaries. */
export function hasPhrase(folded: string, phrase: string): boolean {
  return ` ${folded} `.includes(` ${phrase} `);
}
