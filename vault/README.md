# vault/

Dated integrity snapshots of this repository.

## What a vault entry is

`vault/YYYY/MMDD/MANIFEST.md` records, for one moment in time:

- the commit the tree stood at, and its subject line;
- the UTC timestamp the snapshot was taken;
- every tracked **text** file, with its **git SHA-1 and byte size**;
- every **excluded** binary/document file, named individually rather than
  summarised as a count.

## What it is NOT

**It is not a copy of the bytes.** A manifest lets you *verify* a copy; it does
not *contain* one. Any file listed here can be checked against a candidate copy
with:

```bash
git hash-object <file>      # must equal the SHA-1 in the manifest
```

If you need the bytes themselves, git already stores them. The commit named in
each manifest is the snapshot — `git checkout <commit>` reconstructs the tree
exactly, binaries included. That is why the manifest records a commit rather
than duplicating content: duplicating it would create a second copy that can
drift, and the whole point of a vault is that it cannot.

## Exclusions

Binary and document formats are excluded by extension:

```
.docx .pdf .png .jpg .jpeg .gif .ico .db .zip .woff .woff2 .ttf
```

They are still in git and still reachable from the recorded commit; they are
simply not hashable-by-line in a way that makes a text manifest useful, and
listing them by name keeps the omission visible rather than silent.

## Regenerating a manifest

```bash
COMMIT=$(git rev-parse HEAD)
git ls-files | grep -ivE '\.(docx|pdf|png|jpg|jpeg|gif|ico|db|zip|woff2?|ttf)$' \
  | while read -r f; do printf '%s  %s  %s\n' "$(git hash-object "$f")" "$(stat -c%s "$f")" "$f"; done
```

## Entries

| Date | Commit | Tracked files | Note |
|---|---|---|---|
| [2026/0807](2026/0807/MANIFEST.md) | `595d964` | 959 (929 text, 30 excluded) | First entry. Taken after #681 merged — the repair report and the two closing audits. |
