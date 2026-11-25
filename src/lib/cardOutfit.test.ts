import { test } from "node:test";
import assert from "node:assert/strict";
import { addCardToCharacter, adaptCardCharacter, linkTags, parseCardLink, removeExtraCard, type CardLink } from "./characterCards";

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
    { text: "green eyes", part: "eyes" },
    { text: "bikini top", part: "upperBody" },
    { text: "sarong", part: "lowerBody" },
  ],
};
const mikaText = "1girl, blue eyes, short hair, hoodie, jeans";

test("an outfit card replaces the character's outfit and nothing else", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  assert.equal(r.text, "1girl, blue eyes, short hair, bikini top, sarong");
  assert.equal(r.link.extras?.length, 1);
  assert.equal(r.link.extras?.[0].mode, "outfit");
  // The outfit card's own eyes don't come along.
  assert.ok(!r.text.includes("green eyes"));
});

test("a second outfit replaces the first; taking it off brings the card's own outfit back", () => {
  const coat: CardLink = { name: "Coat", tags: [{ text: "trench coat", part: "upperBody" }] };
  const once = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  const twice = addCardToCharacter(once.text, once.link, coat, "outfit");
  assert.equal(twice.text, "1girl, blue eyes, short hair, trench coat");
  assert.equal(twice.link.extras?.length, 1);
  const off = removeExtraCard(twice.text, twice.link, 0);
  assert.equal(off.text, "1girl, blue eyes, short hair, hoodie, jeans");
  assert.equal(off.link.extras, undefined);
});

test("adding with all tags adds only what's missing", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "all");
  assert.equal(r.text, "1girl, blue eyes, short hair, hoodie, jeans, green eyes, bikini top, sarong");
});

test("hidden parts stay out, and view tags drop an added card's tags too", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit", new Set(["lowerBody"]));
  assert.equal(r.text, "1girl, blue eyes, short hair, bikini top");
  const full = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  assert.deepEqual(
    linkTags(full.link).map((t) => t.text),
    ["1girl", "blue eyes", "short hair", "bikini top", "sarong"],
  );
  const adapted = adaptCardCharacter(full.text, full.link, "beach, upper body");
  assert.equal(adapted.text, "1girl, blue eyes, short hair, bikini top");
});

test("added cards survive saving and reading back", () => {
  const r = addCardToCharacter(mikaText, mika, swimsuit, "outfit");
  const back = parseCardLink(JSON.parse(JSON.stringify(r.link)));
  assert.equal(back?.extras?.[0].link.name, "Swimsuit");
  assert.equal(back?.extras?.[0].mode, "outfit");
});
