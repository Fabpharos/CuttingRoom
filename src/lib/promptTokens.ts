// Prompt file tokens: a file's lines are used by typing its token, `__name__`,
// anywhere in a prompt — the same convention as A1111 / ComfyUI wildcard
// files. Names are lowercase letters, digits and dashes, so a name can never
// run into the underscores around it.
//
// Paired files give each entry labelled parts too ("girl: …", "boy: …"),
// used as `__name:girl__`; every part comes from the same entry as the
// file's main line.

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const TOKEN = new RegExp(`__(${SLUG})(?::(${SLUG}))?__`, "gi");
const NAME = new RegExp(`^${SLUG}$`);

/** `__name__`, or `__name:part__` for one part of a paired file. */
export function tokenFor(name: string, part?: string | null): string {
  return part ? `__${name}:${part}__` : `__${name}__`;
}

export function isValidTokenName(name: string): boolean {
  return NAME.test(name);
}

/** A label from a paired file as used in tokens: "Girl" -> "girl", "Character 2" -> "character-2". */
export function partName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A name for a file's token from its file name, unique among `taken`. */
export function fileTokenName(path: string, taken: Iterable<string>): string {
  const stem = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
  const base = partName(stem) || "file";
  const used = new Set(taken);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** The tokens in `text` as keys ("name" or "name:part"), lowercased, in order of first use. */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => (m[2] ? `${m[1]}:${m[2]}` : m[1]).toLowerCase()))];
}

/** The file a token key belongs to. */
export function tokenFile(key: string): string {
  return key.split(":")[0];
}

/** The part a token key names, or null for the file's main line. */
export function tokenPart(key: string): string | null {
  return key.split(":")[1] ?? null;
}

/** Replaces each token with its value (keyed as in `tokensIn`); tokens without one are left as typed. */
export function fillTokens(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (whole, name: string, part: string | undefined) => {
    const key = (part ? `${name}:${part}` : name).toLowerCase();
    return values[key] ?? whole;
  });
}
