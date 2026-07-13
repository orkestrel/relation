# @orkestrel/relation

A typed **relation manager** over [`@orkestrel/database`](https://github.com/orkestrel/database)
tables — name a table's relations once, then `load` / `find` records with their
related rows already attached. Loading is **batched** — one query per relation
across the whole record set, grouped in memory and merged on — so a hundred
parents cost the same number of round-trips as one. Five relation kinds
(`belongs` / `many` / `one` / `through` / `morph`) cover the FK shapes; nested
includes recurse through the registry; `link` / `unlink` / `links` manage a
many-to-many junction without hand-writing join rows. Environment-agnostic —
no I/O, no browser or server assumptions. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/relation
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import { createRelationManager, belongsTo, hasMany, hasThrough } from '@orkestrel/relation'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { stringShape } from '@orkestrel/contract'

const db = createDatabase({
	driver: createMemoryDriver(),
	tables: {
		accounts: { id: stringShape(), name: stringShape(), classificationId: stringShape() },
		contacts: { id: stringShape(), accountId: stringShape(), email: stringShape() },
		classifications: { id: stringShape(), label: stringShape() },
	},
})

const manager = createRelationManager({
	database: db,
	relations: {
		accounts: {
			classification: belongsTo('classificationId', 'classifications'), // FK on accounts
			contacts: hasMany('accountId'), // FK on contacts → back here
		},
		contacts: { account: belongsTo('accountId', 'accounts') },
	},
})

const accounts = manager.model('accounts') // a typed Model; only the relations you ask for load
const acme = await accounts.load('acc1', { contacts: true, classification: true })

acme?.name // ✅ the base row is the table's row type
acme?.contacts // the relation property — broad (Row | readonly Row[] | undefined)
```

`model(name)` is checked against the database's declared tables, so a typo is a
compile error. The model's own table (`model.table`) carries that table's row
type; the attached related rows are the broad `Row` — narrow them where you
read them.

## Guide

For the full surface — the manager, the `Model`, the relation builders
(`belongsTo` / `hasMany` / `hasOne` / `hasThrough` / `hasMorph`), resolution,
errors, and the observation surface — see
[`guides/src/relation.md`](guides/src/relation.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
