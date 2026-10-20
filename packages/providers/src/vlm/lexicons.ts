/**
 * Word lists for the deterministic reading guardrails (docs/quality-plan.md
 * §4, guard-v2). Pure data plus two tokenizer helpers; no I/O.
 *
 * The lists were seeded from the recorded phase-4 readings of the 15 tuning
 * photos. guard-v2 also changed rules after held-out (h01-h13) failures had
 * been inspected (docs/quality-plan.md §13), so that split is no longer blind
 * (fixtures/eval/README.md). Changing any list changes the guardrail
 * behaviour: bump GUARDRAIL_VERSION in guardrails.ts with it, which
 * un-qualifies the photo roles until they are re-evaluated (§2, §7.5). The
 * source fingerprint test (guardrails.test.ts) fails until the version and
 * the pinned digest are updated together.
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
  mitsubishi dodge chrysler cadillac buick gmc infiniti acura opel dacia lada saab lancia
  mclaren astonmartin polestar rivian byd geely mahindra piaggio lambretta aprilia ktm agusta enfield
  merida orbea raleigh schwinn cinelli bmc wilier ridley surly bontrager
  stussy bape yeezy skechers timberland birkenstock crocs ugg arcteryx carhartt dickies kappa ellesse
  diadora mizuno saucony hoka onitsuka salomon oakley rayban primark benetton hilfiger kors longchamp
  kenzo margiela miyake jacquemus ferragamo zegna brioni barbour belstaff wrangler patagonia northface
  iphone ipad macbook airpods xiaomi huawei oppo oneplus motorola nokia toshiba hitachi technics marantz
  sennheiser jbl dyson gopro dji polaroid kodak hasselblad pentax ricoh minolta nintendo playstation
  xbox sega atari walkman thinkpad
  nescafe nespresso lavazza guinness budweiser asahi kirin tsingtao carlsberg peroni aperol campari
  smirnoff bacardi jameson hennessy moet mcdonalds kfc haribo nutella heinz kelloggs oreo nestle
  cadbury lindt toblerone redbull fanta schweppes evian perrier sanpellegrino
  breitling longines hublot panerai timex garmin fitbit audemars piguet patek
  molten mikasa rawlings titleist callaway yonex babolat slazenger kookaburra
`);

/**
 * Maker names that are also ordinary words ("Supreme", "Jordan", "Vans",
 * "Giant"): brand-like only next to a product noun of their trade
 * (CONTEXT_PRODUCTS), so "Supreme streetwear" and "Jordan 1 sneakers" are
 * held while "Giant panda" is not.
 */
export const CONTEXTUAL_MAKERS = set(`
  supreme jordan vans giant scott cube canyon trek specialized champion coach guess gap mango diesel boss lee
  mini smart seat ram lotus triumph omega citizen columbia corona palace focus fuji kona marin
`);

/** Product nouns that make a contextual maker brand-like ("Vans sneakers", "Giant bike"). */
export const CONTEXT_PRODUCTS = set(`
  bike bikes bicycle bicycles frame frameset sneaker sneakers trainers shoe shoes boot boots
  hoodie hoodies tee tshirt shirt shirts jersey jerseys cap caps jacket jackets coat coats bag bags backpack
  streetwear sportswear workwear outerwear footwear apparel clothing outfit
  watch watches laptop phone phones headphones camera
  car cars suv suvs truck trucks van vans motorcycle motorbike scooter skateboard skateboards
  beer lager soda
`);

/**
 * guard-v11: nationality adjectives (the first lines of DESCRIPTORS). On a photo with people, a sport named with one of them
 * ("Brazilian football") says who the players are, not only what they play.
 */
const NATIONALITY_WORDS = `
  japanese chinese korean thai vietnamese indian pakistani persian iranian turkish ottoman arab arabic moroccan
  egyptian african ethiopian nigerian ghanaian kenyan mexican peruvian brazilian argentine cuban caribbean
  french italian spanish portuguese greek german dutch belgian swiss austrian danish swedish norwegian finnish
  nordic scandinavian british english scottish irish welsh russian polish czech hungarian balkan
`;
export const NATIONALITIES = set(NATIONALITY_WORDS);

/**
 * guard-v11: words that say who plays a sport (a level, an age group, a
 * competition or a body: "Professional basketball", "Youth baseball",
 * "College football", "Olympic fencing"). A sport named with one of them is a
 * claim about the players; the sport named alone ("Baseball", "association
 * football", "Test cricket") is the activity in the photo.
 */
export const SPORT_QUALIFIERS = set(`
  national international professional pro semi amateur youth junior juniors senior seniors veteran veterans
  college collegiate varsity university school schools high olympic olympics paralympic world
  club clubs team teams league leagues division premier major minor championship championships cup tournament
  kids children boys girls mens womens little masters elite
`);

/**
 * guard-v11: garment and accessory nouns. A claim whose last naming word is
 * one of them names what someone wears ("Floral print dress", "Varsity
 * jacket", "Running shoes"), whatever type or domain the model gave it, so
 * it is a thing in the photo, not a claim about the person wearing it.
 */
export const GARMENTS = set(`
  dress dresses gown gowns suit suits tuxedo tuxedos coat coats overcoat jacket jackets blazer blazers parka parkas
  shirt shirts tshirt tee tees blouse blouses top tops sweater sweaters sweatshirt sweatshirts hoodie hoodies
  cardigan cardigans jumper jumpers vest vests waistcoat waistcoats jersey jerseys kit kits uniform uniforms
  trousers pants jeans chinos shorts skirt skirts leggings overalls dungarees jumpsuit jumpsuits
  kimono kimonos yukata sari saris hanbok qipao cheongsam kilt kilts dirndl poncho ponchos kaftan caftan
  abaya hijab turban turbans sombrero fez beret berets
  hat hats cap caps beanie beanies helmet helmets scarf scarves shawl shawls tie ties bowtie gloves mittens
  shoe shoes sneaker sneakers trainers boot boots sandals loafers heels pumps slippers slip ons clogs
  bag bags handbag handbags backpack backpacks tote totes purse belt belts boutonniere corsage
  sunglasses watch earrings necklace bracelet ring rings brooch
`);

/**
 * Descriptive words that may lead a product name without making it a brand
 * guess: nationalities and regions, periods, garment and construction
 * styles. A fashion or sport object whose leading word is in none
 * of the lexicons is treated as brand-like (held for stage 2): unknown
 * makers fail closed instead of publishing ("Trek road bike").
 */
export const DESCRIPTORS = set(`
${NATIONALITY_WORDS}  mediterranean latin western eastern northern southern oriental tropical alpine desert coastal nautical
  victorian edwardian georgian regency tudor colonial medieval baroque rococo renaissance gothic
  retro mod punk grunge preppy boho bohemian hippie western cowboy military utility tactical technical
  racing touring road mountain gravel track fixed gear city cargo folding electric commuter vintage
  teddy puffer bomber parka varsity biker aviator chino cardigan blazer loafer loafers brogue brogues
  espadrille espadrilles moccasin moccasins clog clogs sandal sandals slipper slippers mule mules
  faux fake imitation replica handwoven hand woven knitted knit quilted embroidered printed striped checked
  plaid tartan paisley floral polka dot dotted patterned beaded fringed ruffled pleated tailored oversized
  cropped slim skinny wide loose baggy flared
  sports team club league pro professional amateur youth kids mens womens unisex
  classic heritage antique folk tribal ethnic artisan craft rustic farmhouse industrial minimalist
  double decker
`);

/** Architecture and building words: a name with one is about a building, never a wear/play/watch/eat reference. */
export const ARCHITECTURE = set(`
  architecture architectural gothic romanesque baroque rococo palladian neoclassical neoclassicism brutalist
  brutalism bauhaus modernist postmodern revival cathedral church chapel basilica mosque temple pagoda shrine
  palace castle fortress abbey monastery minaret facade facades terrace terraced townhouse townhouses
  building buildings house houses tower towers dome domes arch arches column columns roof roofs
  staircase balustrade colonnade portico cloister skyscraper skyscrapers bridge
`);

/** Furniture, interior and craft words: a name with one is design or craft, never a wear/play/watch/eat reference. */
export const DESIGN = set(`
  furniture chair chairs armchair stool stools sofa table tables cabinet cabinets lamp lamps chandelier
  rug rugs carpet carpets vase vases ceramic ceramics pottery porcelain stoneware earthenware tile tiles
  tableware lacquerware woodwork joinery marquetry mosaic interior interiors decor
`);

/** Movement and school names that legitimately head an "X-style" name ("Shaker-style cabinet" -> Shaker). */
export const STYLE_MOVEMENTS = set(`
  shaker mission bauhaus memphis deco nouveau craftsman prairie biedermeier empire regency georgian victorian
  edwardian tudor colonial gothic baroque rococo renaissance art arts crafts zen wabi sabi mingei scandinavian
  nordic japandi industrial brutalist modernist minimalist bohemian boho rustic farmhouse coastal
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
