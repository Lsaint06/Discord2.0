/**
 * Word lists for the Daily Word game (Milestone 13). ANSWERS and MORE_GUESSES were written for
 * Discord 2.0 from everyday English vocabulary (common words are not copyrightable). ANSWERS are
 * familiar, family-friendly words; MORE_GUESSES adds ordinary words that are accepted as guesses.
 * Guesses also accept the public-domain ENABLE list (dictionary.ts), so real words aren't
 * rejected. Every entry is five lowercase letters (checked by the tests).
 */
import { ENABLE_FIVE_LETTER } from './dictionary'

const words = (text: string): string[] => text.trim().split(/\s+/)

export const ANSWERS: readonly string[] = words(`
about above actor acute adapt admit adopt adult after again agent agree ahead alarm album alert
alike alive allow alone along alter amber among angel anger angle angry apart apple apply arena
argue arise armor array arrow aside asset audio avoid awake award aware bacon badge baker basic
basin beach beard beast begin being below bench berry birth black blade blame blank blast blaze
blend bless blind block bloom board boast bonus boost booth brain brake brand brave bread break
brick bride brief bring broad brook brown brush build bunch burst cabin cable camel candy canoe
cargo carry catch cause chain chair chalk charm chart chase cheap check cheek cheer chess chest
chief child chill choir civic claim clash class clean clear clerk click cliff climb clock close
cloth cloud coach coast cocoa color comet coral couch could count court cover craft crane crash
cream creek crisp crowd crown crust cycle daily dairy dance delay depth diary dizzy dodge doubt
dough draft drain drama dream dress drift drink drive eagle early earth eight elbow elder empty
enjoy enter entry equal error event every exact extra fable faint faith false fancy feast fence
ferry fever field fifty final flame flash fleet float flock flood floor flour fluid focus forge
forty frame fresh front frost fruit fudge funny ghost giant given glass globe glove grace grade
grain grand grape grass great green greet grill group guard guess guest guide habit happy heart
heavy hedge hello hobby honey horse hotel house human humor ideal image index inner input issue
ivory jelly jewel joint judge juice knife knock label labor lemon level light limit linen logic
loose lucky lunch magic major maker mango maple march match mayor medal merit metal model money
month moral motor mount mouse mouth movie music nerve never noble noise north novel nurse ocean
offer often olive onion opera orbit order other outer owner paint panel paper party pasta patch
peace peach pearl pedal penny phase phone photo piano piece pilot pitch pizza place plain plane
plant plate plaza point polar porch pound power press price pride prime print prize proof proud
pulse punch pupil queen quest quick quiet quilt quite radio rainy raise rally ranch range rapid
ratio reach react ready realm relax reply rider ridge right rival river roast robin robot rocky
round route royal rugby ruler rural salad sauce scale scarf scene scout sense serve seven shade
shake shape share sharp sheep shelf shell shine shirt shore short shout sight skill skirt sleep
slice slide smart smile smoke snack snake solar solid sound south space spark speak speed spend
spice spoon sport spray squad stack staff stage stair stamp stand start steam steel stick still
stone storm story stove straw stuff sugar sunny super sweet swing table taste teach thank theme
there thick thing think third three throw thumb tiger title toast today topic torch total touch
tough tower track trade trail train treat trend trial tribe trick truck truly trust truth tulip
twice uncle under unity until upper urban usual valid value vapor video visit vital vivid vocal
voice wagon waste watch water wheat wheel where while white whole width windy woman world worry
worth would write wrong yacht young youth zebra
`)

export const MORE_GUESSES: readonly string[] = words(`
adieu adore aisle alien align alley aloud amaze ample ankle annoy apron arose ashes attic awful
bagel banjo barge baton beefy began belly bingo bison blimp bliss blond blush boxer braid brass
bravo broom buddy bumpy cadet chant cheat chewy chick chili chimp chirp chord chore cider cinch
clamp clang clasp cling cloak clown comic condo cough cramp crate crawl crazy creak creep crept
crumb crush cubic curly curry curve daisy dandy decal decoy delta denim dense diner disco ditch
diver dozen dried drill drums dryer dusty dwarf eager easel elect elite email ember envoy equip
erase essay ethic evoke exile exist fairy fatal fault feral fetch fiber filed filet finch fixed
flair flake flask flint flirt flora fluff flute foamy foggy folly frail freak froze fully gauge
gecko geese genre glaze gleam glide gloom glory gnome goose gourd gravy grind groan grove growl
grown guilt gummy gusty haiku hairy handy harsh haste hatch haunt haven hazel heron hinge hippo
hoist holly hound hover icing igloo inlet irate jazzy jeans jolly jumbo kayak kebab khaki kiosk
kitty koala lance lanky larch laser latch later lawns layer leafy leapt least ledge lever lilac
limbo liner llama lodge lofty lorry lotus lover lower loyal lunar lyric macaw manor marsh mason
meant melon mercy messy midst mimic minor minty mirth moist molar moose mossy motel moved mower
mural murky muddy nacho nanny nasty naval needy newly niche night ninja noisy nomad notch nudge
nutty oasis oddly olden onset otter ought ounce oxide paddy panda pansy parka pause pecan perch
petal picky piggy pinch pivot pixel plank pleat plumb plump plush poker polka poppy pouch prawn
prism prong prune puppy purse quail qualm quart quota quote raven rebel recap refer reign renew
rerun resin rhyme rinse risky roomy roost rowdy rusty saint salsa salty sandy satin scoop scorn
scrap scrub sedan seize sever shack shaky shawl sheen shift shiny shrub sigma siren skate skunk
slate slept slope sloth slump smirk snail sneak sniff snore snowy soggy sonic spade spare spawn
spicy spike spill spine spite splat spoke spool spore spout squid stale stare steal steep stern
stilt sting stint stoic stork stout strap stray strip stump stung surge swamp swarm swear swept
swift swirl sword syrup taffy tango tangy tapir tasty teddy tempo tense thorn tidal tiara timid
tipsy token tonic tooth topaz tread trace tramp truce tubby tummy tunic tweed twirl ultra unzip
usher utter vague vault venom verse vigor viola viper visor vowel waltz weary wedge whale whisk
whirl widen wince witty woken woody wordy wreck wrist yeast yodel yummy zesty
`)

/** Extra guesses from the public-domain ENABLE word list (never used as answers). */
export const DICTIONARY: readonly string[] = words(ENABLE_FIVE_LETTER)

/** Every accepted guess (answers included). */
export const GUESSES: ReadonlySet<string> = new Set([...ANSWERS, ...MORE_GUESSES, ...DICTIONARY])
