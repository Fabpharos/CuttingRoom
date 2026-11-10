// Sorts a character's tags into eyes and hair automatically; everything else
// starts in "other" for the user to place. The named tags are Danbooru tag
// groups as listed on https://tagexplorer.github.io/ (Heads page: hair
// styles, bangs, top of head, multicolored hair, eyes, pupils); colours and
// lengths ("red eyes", "very long hair") are caught by their ending instead.

const HAIR_STYLES = [
  "african braids", "afro", "bantu knots", "beehive hairdo", "bob cut", "bow-shaped hair", "bowl cut", "braid",
  "braided bangs", "braided bun", "buzz cut", "chonmage", "cone hair bun", "cornrows", "crested hair", "crew cut",
  "crown braid", "curly hair", "donut hair bun", "double bun", "dreadlocks", "drill hair", "feixianji", "flattop",
  "flipped hair", "flower-shaped hair", "fluffy hair", "folded ponytail", "four leaf clover hairstyle", "front braid",
  "front ponytail", "hair bun", "hair flaps", "hair rings", "half up braid", "half up half down braid", "half updo",
  "heart hair bun", "high ponytail", "hime cut", "huge afro", "inverted bob", "katsuyamamage", "liangbatou",
  "low twin braids", "low twintails", "low-braided long hair", "low-tied long hair", "messy hair", "mizura", "mullet",
  "multi-tied hair", "multiple braids", "nihongami", "one side up", "parted hair", "pixie cut", "pointy hair",
  "pompadour", "ponytail", "quad braids", "quad tails", "quiff", "quin tails", "rabbit hairstyle", "ringlets",
  "short ponytail", "short twintails", "shouten pegasus mix mori", "shuangyaji", "side braid", "side ponytail",
  "single braid", "single hair bun", "single hair ring", "spiked hair", "split ponytail", "star-shaped hair",
  "straight hair", "topknot", "tri braids", "tri drills", "tri tails", "triple bun", "twin braids", "twin drills",
  "twintails", "twisted hair", "two side up", "undercut", "uneven twintails", "wavy hair", "wolf cut",
];

const HAIR_BANGS = [
  "arched bangs", "asymmetrical bangs", "asymmetrical sidelocks", "bangs pinned back", "blunt bangs", "braided bangs",
  "choppy bangs", "colored bangs", "crossed bangs", "curtained hair", "diagonal bangs", "drill sidelocks",
  "fanged bangs", "hair between eyes", "hair intakes", "hair over eyes", "hair over one eye", "long bangs",
  "low-tied sidelocks", "parted bangs", "short bangs", "sidelocks", "sidelocks tied back", "single hair intake",
  "single sidelock", "swept bangs", "widow's peak", "wispy bangs",
];

const HAIR_TOP = [
  "ahoge", "antenna hair", "comb over", "hair pulled back", "hair slicked back", "heart ahoge", "heart antenna hair",
  "huge ahoge", "mohawk",
];

const HAIR_MULTICOLORED = [
  "colored inner hair", "colored tips", "gradient hair", "multicolored hair", "patterned hair", "rainbow hair",
  "roots (hair)", "split-color hair", "spotted hair", "streaked hair", "striped hair", "two-tone hair",
];

// Not in tagexplorer's groups, but always about the hair itself.
const HAIR_OTHER = ["bangs", "bald", "hairband", "hairclip", "hairpin", "hair ornament", "hair ribbon", "hair bow"];

// From tagexplorer's "eyes" group, only the ones that describe the
// character's eyes rather than a passing expression ("half-closed eyes",
// "sideways glance") or a drawing style ("googly eyes").
const EYE_TRAITS = [
  "aegyo sal", "bags under eyes", "cephalopod eyes", "compound eyes", "empty eyes", "flaming eyes", "glowing eyes",
  "horizontal pupils", "jitome", "ringed eyes", "sanpaku", "solid oval eyes", "sparkling eyes", "tareme", "tsurime",
  "upturned eyes",
];

const EYE_PUPILS = [
  "constricted pupils", "cross-shaped pupils", "diamond-shaped pupils", "dilated pupils", "extra pupils",
  "flower-shaped pupils", "heart-shaped pupils", "horizontal pupils", "mismatched pupils", "no pupils", "slit pupils",
  "snowflakes-shaped pupils", "solid circle pupils", "star-shaped pupils", "symbol-shaped pupils", "x-shaped pupils",
];

const EYE_OTHER = ["heterochromia", "eyelashes", "long eyelashes", "colored eyelashes", "symbol in eye"];

const HAIR = new Set([...HAIR_STYLES, ...HAIR_BANGS, ...HAIR_TOP, ...HAIR_MULTICOLORED, ...HAIR_OTHER]);
const EYES = new Set([...EYE_TRAITS, ...EYE_PUPILS, ...EYE_OTHER]);

// Ending in "hair" or "eyes" but not about the character's own hair or eyes.
const NOT_HAIR = new Set([
  "facial hair", "body hair", "pubic hair", "armpit hair", "chest hair", "leg hair", "arm hair", "hand in own hair",
  "hands in hair", "hand in another's hair", "grabbing another's hair", "hair grab", "hair pull", "hair flip",
  "adjusting hair", "playing with own hair", "holding own hair", "hair tucking", "tucking hair",
]);
const NOT_EYES = new Set([
  "closed eyes", "covered eyes", "covering own eyes", "covering another's eyes", "hand over eyes", "half-closed eyes",
  "rolling eyes", "averting eyes", "crazy eyes", "heart-shaped eyes", "rubbing eyes", "wiping eyes", "button eyes",
  "googly eyes", "pac-man eyes", "pixel eyes", "squiggle eyes", "dashed eyes", "solid circle eyes", "bulging eyes",
  "pleading eyes", "glasses over eyes", "rolling eyes", "one eye closed",
]);

/** A tag without NovelAI weighting (`1.2::tag::`, `{tag}`, `[tag]`), lower-cased, with spaces for underscores. */
export function bareTag(tag: string): string {
  let t = tag.trim();
  const weight = /^-?(\d+(\.\d+)?|\.\d+)::(.*?)(::)?$/s.exec(t);
  if (weight) t = weight[3];
  t = t.replace(/^[{[]+/, "").replace(/[}\]]+$/, "");
  return t
    .replace(/\\([()])/g, "$1")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** "eyes" or "hair" when a tag is clearly about them; null otherwise. */
export function autoPart(tag: string): "eyes" | "hair" | null {
  const t = bareTag(tag);
  if (t === "") return null;
  if (HAIR.has(t)) return "hair";
  if (EYES.has(t)) return "eyes";
  if (!NOT_HAIR.has(t)) {
    if (/ hair$/.test(t) || /^hair (ornament|ribbon|bow|flower|tie|bobbles|scrunchie|stick|beads|clip|band|ring|bell|tubes)s?$/.test(t))
      return "hair";
    if (/(^|[ -])(ponytails?|twintails|braids?|sidelocks?|bangs|ahoge|hair intakes?|drills?)$/.test(t)) return "hair";
  }
  if (!NOT_EYES.has(t)) {
    if (/ eyes$/.test(t) || / pupils$/.test(t) || / sclera$/.test(t) || / eyelashes$/.test(t)) return "eyes";
  }
  return null;
}

/** A display name guessed from a "name (series)" tag, e.g. "Sparkle"; "" if none. */
export function guessName(tags: string[]): string {
  for (const tag of tags) {
    const m = /^(.+?)\s*\((.+)\)$/.exec(bareTag(tag));
    if (m && !/^(medium|cosplay|hair|artist)$/.test(m[2])) {
      return m[1].replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    }
  }
  return "";
}
