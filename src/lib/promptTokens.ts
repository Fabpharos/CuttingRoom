// Prompt file tokens: a file's lines are used by typing its token, `__name__`,
// anywhere in a prompt — the same convention as A1111 / ComfyUI wildcard
// files. Names are lowercase letters, digits and dashes, so a name can never
// run into the underscores around it.

const TOKEN = /__([a-z0-9]+(?:-[a-z0-9]+)*)__/gi;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function tokenFor(name: string): string {
  return `__${name}__`;
}

export function isValidTokenName(name: string): boolean {
  return NAME.test(name);
}

/** A name for a file's token from its file name, unique among `taken`. */
export function fileTokenName(path: string, taken: Iterable<string>): string {
  const stem = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
  const base = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
  const used = new Set(taken);
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** The token names in `text`, lowercased, in order of first use. */
export function tokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1].toLowerCase()))];
}

/** Replaces each token with its value; tokens without one are left as typed. */
export function fillTokens(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (whole, name: string) => values[name.toLowerCase()] ?? whole);
}
