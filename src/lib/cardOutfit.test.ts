import { test } from "node:test";
import assert from "node:assert/strict";
import { addCardToCharacter, adaptCardCharacter, linkTags, parseCard, parseCardLink, removeExtraCard, type CardLink } from "./characterCards";

const mika: CardLink = {
  name: "Mika",
  tags: [
    { text: "1girl", part: "other" },
    { text: "blue eyes", part: "eyes" },
    { text: "short hair", part: "hair" },
    { text: "hoodie", part: "upperBody" },
    { text: "jeans", part: "lowerBody" },
  ],
};
const swimsuit: CardLink = {
  name: "Swimsuit",
  tags: [
    { text: "1girl", part: "other" },
    { text: "sun hat", part: "other" },
    { text: "bikini top", part: "upperBody" },
    { text: "sarong", part: "lowerBody" },
  ],
  negative: "jacket",
};
const mikaText = "1girl, blue eyes, short hair, hoodie, jeans";

test("an outfit card replaces the character's outfit and brings all its tags and undesired content", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit", new Set(), "bad hands");
  assert.equal(r.text, "1girl, blue eyes, short hair, sun hat, bikini top, sarong");
  assert.equal(r.negative, "bad hands, jacket");
  assert.equal(r.link.extras?.length, 1);
  assert.equal(r.link.extras?.[0].mode, "outfit");
  // 1girl was already there, so it isn't recorded as added.
  assert.deepEqual(r.link.extras?.[0].added, ["sun hat", "bikini top", "sarong"]);
});

test("a second outfit replaces the first; taking it off brings the card's own outfit back", () => {
  const coat: CardLink = { name: "Coat", tags: [{ text: "trench coat", part: "upperBody" }, { text: "1girl", part: "other" }] };
  const once = addCardToCharacter(mikaText, mika, swimsuit, "outfit", new Set(), "bad hands");
  const twice = addCardToCharacter(once.text, once.link, coat, "outfit", new Set(), once.negative);
  assert.equal(twice.text, "1girl, blue eyes, short hair, trench coat");
  assert.equal(twice.negative, "bad hands");
  assert.equal(twice.link.extras?.length, 1);
  const off = removeExtraCard(twice.text, twice.link, 0, twice.negative);
  // The character's own 1girl stays: the coat card didn't add it.
  assert.equal(off.text, "1girl, blue eyes, short hair, hoodie, jeans");
  assert.equal(off.negative, "bad hands");
  assert.equal(off.link.extras, undefined);
});

test("taking an outfit off removes its undesired content too", () => {
  const on = addCardToCharacter(mikaText, mika, swimsuit, "outfit", new Set(), "");
  const off = removeExtraCard(on.text, on.link, 0, on.negative);
  assert.equal(off.text, "1girl, blue eyes, short hair, hoodie, jeans");
  assert.equal(off.negative, "");
});

test("adding with all tags adds only what's missing", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "all");
  assert.equal(r.text, "1girl, blue eyes, short hair, hoodie, jeans, sun hat, bikini top, sarong");
  assert.equal(r.negative, "jacket");
});

test("hidden parts stay out, and view tags drop an added card's tags too", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit", new Set(["lowerBody"]));
  assert.equal(r.text, "1girl, blue eyes, short hair, sun hat, bikini top");
  const full = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  assert.deepEqual(
    linkTags(full.link).map((t) => t.text),
    ["1girl", "blue eyes", "short hair", "1girl", "sun hat", "bikini top", "sarong"],
  );
  const adapted = adaptCardCharacter(full.text, full.link, "beach, upper body");
  assert.equal(adapted.text, "1girl, blue eyes, short hair, sun hat, bikini top");
});

test("added cards survive saving and reading back", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  const back = parseCardLink(JSON.parse(JSON.stringify(r.link)));
  assert.equal(back?.extras?.[0].link.name, "Swimsuit");
  assert.equal(back?.extras?.[0].mode, "outfit");
  assert.deepEqual(back?.extras?.[0].added, ["sun hat", "bikini top", "sarong"]);
});

test("a card that is its own reference follows its file", () => {
  const card = parseCard({
    version: 2,
    name: "Mika",
    tags: [],
    reference: { path: "", self: true, type: "outfit", strength: 2, fidelity: 1 },
  });
  assert.equal(card?.reference?.self, true);
  assert.equal(card?.reference?.type, "outfit");
  // A saved link uses the card file it points at.
  const link = parseCardLink({ name: "Mika", tags: [], path: "C:/cards/Outfits/Mika.png", reference: card?.reference });
  assert.equal(link?.reference?.path, "C:/cards/Outfits/Mika.png");
  // A reference that isn't the card keeps its own path; one with no path and not self is none.
  assert.equal(parseCard({ version: 2, name: "A", tags: [], reference: { path: "C:/x.png" } })?.reference?.path, "C:/x.png");
  assert.equal(parseCard({ version: 2, name: "A", tags: [], reference: { path: "" } })?.reference, null);
});
