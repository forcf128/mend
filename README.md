[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/forcf128/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/forcf128/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is one command-line tool that applies the edits AI models write, in
four formats, to a tree of text files: unified diffs, SEARCH/REPLACE blocks,
V4A patches, and JSON edits. It is the entry for the
hidden-spec-cli-01-run-20261122 bounty.

## Run

Node 22, standard library only, no dependencies:

```
node main.ts [options] [PATCH]
```

PATCH is a file, or `-` / omitted to read from stdin.

Options: `--format=auto|unified|search-replace|v4a|json` (default auto),
`--check` (print the result, write nothing), `--strict` (exact matching
only, no whitespace fallbacks), `--` (end of options).

## Behaviour

Every edit in a patch applies to the tree as the earlier edits left it.
A failed edit changes nothing, the edits after it still run, and when any
edit failed no file is written at all. Exit 0 lists the changed files
(`A` created, `D` deleted, `M` modified, `R old -> new` moved) and `ok: N
files`; exit 1 lists each failure and `failed: K of N edits`; exit 2 is a
usage, format, or parse error, one line only.

Matching is three-tier: exact, then trailing whitespace ignored, then
leading and trailing whitespace ignored, with the new lines re-indented to
the file's indentation when the third tier is used. Paths are kept safe:
no absolute paths, no `..`, no backslashes. Line endings and the final
line break of a file are preserved unless the patch says otherwise.

## Design

- `main.ts` is the whole tool: command line, format detection, the four
  parsers, the three-tier matcher, and the all-or-nothing write.
- Files are held as lines plus their line break and final-break flag, so a
  patch can change content without touching a file's line endings.
- A hunk, a SEARCH/REPLACE block, and a V4A chunk are all the same shape:
  old lines (context plus removed) and new lines (context plus added), so
  one replacement routine serves all four formats.
- `runner.ts` is the trial hand-over the kit ships, kept unchanged.
- `SPEC.md` is the contract this tool implements; `check.ts` runs the
  100 practice checks against it.
