# Guides

A dual-axis index into this repository's guides — by concept, and by directory (`.claude/rules/documentation.md` § Parity).

## By concept

| Concept  | Spec                         | Source                    | Tests                                 |
| -------- | ---------------------------- | ------------------------- | ------------------------------------- |
| Relation | [`relation.md`](relation.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                        |
| ---------- | ---------------------------- |
| `src/core` | [`relation.md`](relation.md) |

## Dependency reference

[`contract.md`](contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — a runtime dependency. It documents **that package's**
surface (guards, combinators, parsers, and the shape DSL), not anything sourced
in this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`emitter.md`](emitter.md) is a byte-identical mirror of the guide for
`@orkestrel/emitter` — a runtime dependency. It documents **that package's**
surface (the typed push-observation `Emitter`), not anything sourced in this
repo; it is kept here for the same reason.

[`database.md`](database.md) is a byte-identical mirror of the guide
for `@orkestrel/database` — a runtime dependency, and the typed store relation
managers and models are layered over. It documents **that package's** surface
(the database, tables, and query layer), not anything sourced in this repo; it
is kept here so a reader of this guide can see the typed half without leaving
this guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency that compiles this repo's shared file
set and writes it into the tree. It documents **that package's** surface (the
`scaffold` executable and the compiler behind it), not anything sourced in this
repo; it is kept here so a reader can see what produced the shared files without
leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding contract and its rule map.
