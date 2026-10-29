# Wildcards

Prompt files for the Generate tab. "Add .txt files…" opens here by default, and
each file you add gets a token named after it (`hair colors.txt` →
`__hair-colors__`) that you type into any prompt, undesired content or character.

## Plain files

One prompt per line; each image takes one line.

## Paired files

An entry is a main line followed by labelled lines for each character:

```
1.2::dancing::, stage, spotlight, The girl spins while the boy claps.
girl: twirling, smile, source#dancing
boy: clapping, target#dancing
```

`__name__` is the main line, `__name:girl__` the `girl:` line and `__name:boy__`
the `boy:` line, always from the same entry. "Use in prompts" puts each one in
place: the main token in the prompt, and each part in the character whose
prompt starts with its label (`girl, …`), or a new one. A character whose part
an entry doesn't have is left out of that image. Lines starting with `Text:`
(NovelAI's syntax for writing in images) are never labels.

Everything in this folder except this README is ignored by git, so your prompt
lists stay on your PC and are never pushed to GitHub.
