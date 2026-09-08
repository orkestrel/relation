# @orkestrel/relation

> A small, declarative ORM layer over the `@orkestrel/database` tables: a table's
> relations named once, then records loaded or found with their related rows already
> attached, batched so a direct relation costs one query across the whole record set and
> a `through` relation two.

Declare each table's relations with the `belongsTo`, `hasMany`, `hasOne`,
`hasThrough`, and `hasMorph` builders, then reach a typed model through
`model(name)` and drop to `model.table` for plain typed reads and writes.
Environment-agnostic — no I/O, no browser or server assumptions. Part of the
`@orkestrel` line.

## Install

```sh
npm install @orkestrel/relation
```

## Requirements

- Node.js >= 22.12.0, matching the `engines` field in `package.json`
- ESM (`import`) and CommonJS (`require`) through the `exports` field

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
			classification: belongsTo('classificationId', 'classifications'), // foreign key on accounts
			contacts: hasMany('accountId'), // foreign key on contacts → back here
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
[`guides/relation.md`](guides/relation.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
