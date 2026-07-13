# Relation

> A small, declarative ORM layer over the [database](database.md) module: name a table's relations once, then `load` / `find` records with their related rows already attached. Loading is **batched** — a CONSTANT number of queries per relation across the whole record set (one for `belongs` / `many` / `one` / `morph`, two for `through` — the junction lookup, then the targets), `where(col).any(keys)` grouped in memory and merged on — so a hundred parents cost the same number of round-trips as one. Five relation kinds (`belongs` / `many` / `one` / `through` / `morph`) cover the FK shapes; nested includes recurse through the registry; `link` / `unlink` / `links` manage a many-to-many junction without hand-writing join rows — `link` is idempotent, `unlink` atomic.
>
> It deliberately stays **thin above the typed store**. Resolution is define-time (each relation is precomputed once into a flat `ResolvedRelation` — nothing is inferred while loading), and the loaded relation properties are intentionally **loose** (`Row | readonly Row[] | undefined`) rather than typed to each exact target row: the typed half is the table reached through `model.table`; relation loading is the looser convenience on top. No write-cascades, no lazy proxies, no query builder of its own — just batched eager loading and junction management. Source: [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a manager over a database and its relation map, then reach a typed model and load with relations attached:

```ts
import { createRelationManager, belongsTo, hasMany, hasThrough } from '@src/core'

const manager = createRelationManager({
	database: db, // a typed DatabaseInterface from createDatabase(...)
	relations: {
		accounts: {
			classification: belongsTo('classificationId', 'classifications'), // FK on accounts → one classification
			contacts: hasMany('accountId'), // FK on contacts → many contacts back here
			reps: hasThrough('accountReps', 'accountId', 'repId', 'reps'), // many-to-many via a junction
		},
		contacts: { account: belongsTo('accountId', 'accounts') }, // so contacts can nest-load its account
	},
})

const accounts = manager.model('accounts') // a typed Model; only the relations you asked for are loaded
const acme = await accounts.load('acc1', { contacts: true, classification: true })

acme?.name // ✅ the base row is the table's row type
acme?.contacts // the relation property — broad (Row | readonly Row[] | undefined); narrow at the use site
```

`model(name)` is checked against the database's declared tables, so a typo is a compile error. The model's own table (`model.table`) carries that table's row type; the attached related rows are the broad `Row` — narrow them where you read them.

### Factory & manager

| API                     | Kind     | Summary                                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `createRelationManager` | function | Create a `RelationManagerInterface` over a database and its relation map.      |
| `RelationManager`       | class    | The relation registry — resolves relations once, vends a model per table.      |
| `Model`                 | class    | A typed table paired with relation-aware `load` / `find` and junction methods. |

### Builders

| API          | Kind     | Builds a relation where…                                                   |
| ------------ | -------- | -------------------------------------------------------------------------- |
| `belongsTo`  | function | a FK on THIS table points at the related row (single).                     |
| `hasMany`    | function | a FK on the RELATED table points back here (array).                        |
| `hasOne`     | function | like `hasMany`, but a single related row.                                  |
| `hasThrough` | function | a junction table links the two sides (many-to-many).                       |
| `hasMorph`   | function | a polymorphic FK plus a discriminator column on the RELATED table (array). |

### Resolution

| API                    | Kind     | Summary                                                    |
| ---------------------- | -------- | ---------------------------------------------------------- |
| `resolveRelation`      | function | Resolve one raw `Relation` into a flat `ResolvedRelation`. |
| `resolveRelationMap`   | function | Resolve every entry of a `RelationMap`.                    |
| `isRelationDescriptor` | function | Narrow a value to the object form of a relation.           |

### Errors

| API               | Kind     | Summary                                                                         |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| `RelationError`   | class    | Carries a `RelationErrorCode` (`INVALID` / `UNKNOWN_RELATION` / `NOT_THROUGH`). |
| `isRelationError` | function | Narrow an unknown caught value to a `RelationError`.                            |

### Types

| Type                       | Kind      | Shape                                                                                                             |
| -------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `Relationship`             | type      | `'belongs' \| 'many' \| 'one' \| 'through' \| 'morph'`.                                                           |
| `RelationDescriptor`       | interface | The object form — `relationship?` plus the per-relationship fields (`column` / `key` / `through` / …).            |
| `Relation`                 | type      | `string` (belongs) \| `readonly string[]` (many) \| `RelationDescriptor`.                                         |
| `RelationMap`              | type      | `Readonly<Record<string, Relation>>` — a model's relations by name.                                               |
| `RelationsShape`           | type      | `{ [table]?: RelationMap }` — per-table relation maps, keyed by the database's tables.                            |
| `ResolvedRelation`         | interface | A relation resolved at define-time into a flat, ready-to-load form.                                               |
| `RelationErrorCode`        | type      | `'INVALID' \| 'UNKNOWN_RELATION' \| 'NOT_THROUGH'`.                                                               |
| `Include`                  | interface | Which relations to populate (`true`), and recursively their own (nested `Include`).                               |
| `Loaded`                   | type      | `T & Record<string, Row \| readonly Row[] \| undefined>` — a row with relations attached.                         |
| `RelationProps`            | type      | `Record<string, Row \| readonly Row[] \| undefined>` — the relation-property bag of a `Loaded` row.               |
| `RelationContext`          | interface | `{ resolved, primary }` — a related model's resolved relations + primary, for nesting.                            |
| `FindOptions`              | interface | `{ limit?, offset?, sort?, direction?, signal? }` — pagination, ordering, and cancellation for `find`.            |
| `ModelEventMap`            | type      | A model's push observation surface (§13) — `load(name, count)` · `link(key, relation)` · `unlink(key, relation)`. |
| `ModelInterface`           | interface | `emitter` / `name` / `table` / `relations` + `load` / `find` / `link` / `unlink` / `links`.                       |
| `RelationManagerOptions`   | interface | `{ database, relations? }` — input to `createRelationManager`.                                                    |
| `RelationManagerInterface` | interface | `count` / `model` / `models` / `has`.                                                                             |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name, every call-signature member listed (its `readonly` data members, e.g. `emitter` / `name` / `table` / `relations` / `count`, stay in the Surface rows above — `Model`'s `emitter` is the typed push observation surface, see [Observing](#observing)). `Model` and `RelationManager` each implement their interface exactly, so this doubles as the per-instance method surface (AGENTS §22).

#### `ModelInterface`

`load` / `find` batch-load (a constant number of queries per relation — one, or two for `through` — regardless of result size, independent of how many parents were loaded); `link` / `unlink` / `links` manage a `through` relation's junction rows. Every method takes an optional trailing `options?: ReadOptions` (`{ signal? }`) for cooperative cancellation — checked at entry and, in `load` / `find`, again between each per-relation batched query (query terminals themselves take no signal, so cancellation is cooperative between queries, not mid-query).

| Method   | Returns                                      | Behavior                                                                                                                    |
| -------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `load`   | `Promise<Loaded<T> \| undefined>` (or array) | One record by key(s) with the chosen relations populated.                                                                   |
| `find`   | `Promise<readonly Loaded<T>[]>`              | Many records (paged / sorted) with relations populated.                                                                     |
| `link`   | `Promise<void>`                              | Insert a junction row for a `through` relation — idempotent (a no-op re-link is silent, no duplicate row, no `link` event). |
| `unlink` | `Promise<void>`                              | Remove every matching junction row for a `through` relation atomically (inside a `transaction`).                            |
| `links`  | `Promise<readonly Key[]>`                    | The distinct related keys reachable through a `through` relation.                                                           |

#### `RelationManagerInterface`

Follows the manager accessor pattern (`model` singular, `models` plural).

| Method   | Returns                       | Behavior                                 |
| -------- | ----------------------------- | ---------------------------------------- |
| `model`  | `ModelInterface<RowOf<T[K]>>` | The typed model for a declared table.    |
| `models` | `readonly string[]`           | The names of every model with relations. |
| `has`    | `boolean`                     | Whether a model has resolved relations.  |

## Contract

These invariants hold across `src/core` ↔ `relation.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the relations source tree, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Layered on the typed database — validated FAIL-FAST at construction.** A manager is built over a `DatabaseInterface`; `model(name)` is checked against the database's declared tables and returns a model whose `table` is that table's typed `TableInterface` (a declared table with no relation entry yields a relation-less model — still fully usable for typed CRUD). Every resolved relation's target table (and, for `through`, its junction table) is checked against the database's declared tables (`database.export()`'s keys) at `createRelationManager` construction time — a relation pointing at an undeclared table throws `RelationError('INVALID', …)` immediately, naming the model, relation, and missing table, never a deferred failure discovered only when that relation is first loaded.
3. **Batch loading — no N+1.** For each included relation, a CONSTANT number of queries — one, or two for `through` (the junction lookup, then the targets) — fetches the related rows for the entire record set (`where(col).any(keys)` over the distinct foreign keys), independent of how many parents were loaded; they are grouped in memory and attached. Nested includes recurse through the registry, so a loaded relation carries its own loaded relations — each nested level again costs the same constant number of queries. Attached relation rows may be shared references across parents that resolved to the same related row — treat them as readonly, never mutate a loaded relation property in place.
4. **Resolution is define-time.** Each raw `Relation` is resolved once at construction into a flat `ResolvedRelation`; nothing is inferred during loading. The builders set an explicit `relationship` (so `many` and `one`, otherwise identical as `{ key }`, are unambiguous); a hand-written descriptor with no `relationship` infers one from the fields present (`through` → `through`, `tag` → `morph`, `column` → `belongs`, else `key` → `one`), and a malformed one throws `INVALID` at define-time.
5. **Total, loose `Loaded`.** `Loaded<T>` is the base row (the table's row type) intersected with the broad relation bag `Readonly<RelationProps>` (`Row | readonly Row[] | undefined` per relation); a missed `belongs` / `one` is `undefined`, a missed `many` / `through` / `morph` is `[]`. Through-only operations (`link` / `unlink` / `links`) throw `NOT_THROUGH` on any other kind and `UNKNOWN_RELATION` for a relation the model never declared. `link` is idempotent — re-linking an existing `(key, target)` pair writes nothing and emits nothing; `unlink` removes every matching junction row atomically inside one `transaction`, so a mid-loop driver fault leaves the junction unchanged rather than partially deleted; `links` (and the through-load path) dedupe their output, so pre-existing duplicate junction rows never surface duplicate keys/rows.
6. **Observation is a pure side-channel (§13).** A `Model` owns a typed `emitter` (`ModelEventMap` — `load(name, count)` / `link(key, relation)` / `unlink(key, relation)`); `RelationManager` is event-free by design (a stateless registry has no observable lifecycle). Every event is emitted directly (the AGENTS §13 convention: the emitter isolates a listener throw, routing it to its OWN `error` handler — the `error` option, surfaced as `(error, event)`, NOT a domain event — itself re-entrancy-guarded) strictly AFTER the load resolves / the junction op completes. `load` fires ONCE per relation (carrying the count of rows attached across the record set — no N+1 in the events), so a buggy observer can corrupt neither the batched eager-load nor a junction write (proven by the emit-safety tests). A no-op `link` (an already-linked pair) fires no `link` event.
7. **DOC ↔ SOURCE method bijection.** Every behavioral interface's `## Methods` table lists exactly its public methods (call-signature members) — exhaustive, both directions — and each implementing class (`Model` / `RelationManager`) exposes the same public methods, no more (AGENTS §22). A renamed / added / removed method breaks the gate until the table is reconciled.
8. **Cooperative cancellation.** Every `ModelInterface` method takes an optional trailing `options?: ReadOptions` (`{ signal? }`, re-exported from `@orkestrel/database`). `checkAbort(signal)` is checked at entry, and — in `load` / `find` — again between each per-relation batched query; an already-aborted signal throws `ABORTED` before any query runs, and an abort mid-populate stops before the next relation's query. Query terminals (`.all()` / `.first()`) take no signal in the underlying database, so cancellation is cooperative between queries, never mid-query. `link` / `unlink` thread `options` through to the database calls that accept it (`set` / `remove` / `transaction`); `links` and the read-only load path have no further write/transaction call to thread through.

Typing each loaded relation property to its exact target row (Prisma-style) is a deliberate, documented deferral — like the database guide's deferred pieces. The `Model` is now **observable** — it owns a typed `emitter` (`ModelEventMap`, §13) carrying its eager-load + junction moments (see [Observing](#observing)); `RelationManager` stays event-free by design (a stateless registry that merely vends models has no observable lifecycle of its own). Still out of scope: write-cascades; they are additive and leave the surface above unchanged.

## Patterns

### Defining relations

```ts
import { createRelationManager, belongsTo, hasMany, hasOne, hasThrough, hasMorph } from '@src/core'

const manager = createRelationManager({
	database: db,
	relations: {
		accounts: {
			classification: belongsTo('classificationId', 'classifications'), // FK on accounts
			contacts: hasMany('accountId'), // FK on contacts → accounts
			profile: hasOne('accountId', 'profiles'), // single, FK on profiles
			reps: hasThrough('accountReps', 'accountId', 'repId', 'reps'), // via junction
			notes: hasMorph('entityId', 'entityType', 'account', 'notes'), // polymorphic
		},
		contacts: { account: belongsTo('accountId', 'accounts') },
	},
})
```

Two shorthands cover the common kinds — a bare string is a `belongsTo` column, and a one-element array is a `hasMany` key (both unambiguous, so they need no `relationship`):

```ts
relations: { accounts: { classification: 'classificationId', contacts: ['accountId'] } }
```

Reach for the builders for everything else: they set an explicit `relationship`, which is what disambiguates `many` from `one` (a raw `{ key }` descriptor infers `one`).

The relation kinds, and where each foreign key lives:

| Kind      | Builder      | FK location    | Returns               |
| --------- | ------------ | -------------- | --------------------- |
| `belongs` | `belongsTo`  | THIS table     | single or `undefined` |
| `many`    | `hasMany`    | RELATED table  | array                 |
| `one`     | `hasOne`     | RELATED table  | single or `undefined` |
| `through` | `hasThrough` | junction table | array                 |
| `morph`   | `hasMorph`   | RELATED table  | array                 |

### Resolving relations directly

`resolveRelation` / `resolveRelationMap` / `isRelationDescriptor` are what `createRelationManager` calls internally to turn a raw `RelationMap` into `ResolvedRelation`s at construction — reach for them directly when validating a relation map before wiring a manager, or when testing a descriptor's inferred `relationship`:

```ts
import { isRelationDescriptor, resolveRelation, resolveRelationMap } from '@src/core'

const resolved = resolveRelation('classification', belongsTo('classificationId', 'classifications'))
resolved.relationship // 'belongs'

const map = resolveRelationMap({ contacts: hasMany('accountId') })
map.get('contacts')?.relationship // 'many'

isRelationDescriptor(belongsTo('classificationId')) // true — the object form
```

Catch a malformed relation with `isRelationError`, branching on its machine-readable `code`:

```ts
import { isRelationError } from '@src/core'

try {
	resolveRelation('bad', {})
} catch (error) {
	if (isRelationError(error)) error.code // 'INVALID'
}
```

**The error split.** `RelationError` is thrown ONLY for relation-layer faults — a malformed/undeclared relation target (`INVALID`, now checked FAIL-FAST at `createRelationManager` construction), a reference to an undeclared relation (`UNKNOWN_RELATION`), or a through-only op on a non-`through` relation (`NOT_THROUGH`). Every store-level fault — `VALIDATION`, `CONFLICT`, `NOT_FOUND`, `ABORTED`, `CLOSED` — passes through UNTRANSLATED as the database's own `DatabaseError`; the relations layer never wraps or reinterprets it. Branch on both in a shared `catch`:

```ts
import { isDatabaseError } from '@orkestrel/database'
import { isRelationError } from '@src/core'

try {
	await accounts.load('acc1', { contacts: true }, { signal: controller.signal })
} catch (error) {
	if (isRelationError(error))
		error.code // 'INVALID' | 'UNKNOWN_RELATION' | 'NOT_THROUGH'
	else if (isDatabaseError(error)) error.code // 'VALIDATION' | 'CONFLICT' | 'NOT_FOUND' | 'ABORTED' | 'CLOSED'
}
```

### The registry surface

Beyond `model(name)`, a `RelationManager` exposes `models()` (every table name with resolved relations) and `has(name)` (whether a given table has any):

```ts
manager.models() // e.g. ['accounts', 'contacts']
manager.has('accounts') // true
manager.has('unrelated_table') // false
```

### Loading

`load` mirrors the table's keyed-read overload: a single key returns one record (or `undefined`), an array of keys returns a positional array of records (each slot `undefined` for a missing key) — and either way the relation queries are batched in one pass. `find` runs the table's query (sorted / paged) and attaches relations to the page.

```ts
const accounts = manager.model('accounts')

// One record, with the chosen relations attached:
const acme = await accounts.load('acc1', { contacts: true, classification: true })

// Many records — sorted and paged — with relations attached to the page:
const page = await accounts.find(
	{ reps: true },
	{ sort: 'name', direction: 'ascending', limit: 10 },
)

// Nested includes — load a relation's own relations (recurses through the registry):
const deep = await accounts.load('acc1', { contacts: { account: true } })

// Batch by key array: an array in, an array out — and the relation fetch is STILL
// a constant number of queries per relation across all parents (no N+1), not one per key.
const [a, b] = await accounts.load(['acc1', 'acc2'], { contacts: true })
```

### Typed table access

For writes and plain queries, drop through to `model.table` — the full typed `TableInterface` for that model's table. This is the typed half; eager loading is the looser convenience layered on it.

```ts
const accounts = manager.model('accounts')
await accounts.table.set({ id: 'acc4', name: 'New Corp', classificationId: 'cls1' }) // fully typed
await accounts.table.query().where('name').starts('A').all()
```

### Through management

A `through` relation's junction rows are managed by key — no need to model the junction table yourself or hand-write join rows. `link` / `unlink` / `links` resolve the relation's junction table + its source/target columns from the define-time `ResolvedRelation`, and throw `NOT_THROUGH` if pointed at a non-`through` relation.

```ts
await accounts.link('acc1', 'reps', 'rep3') // insert a junction row (accountId=acc1, repId=rep3)
await accounts.link('acc1', 'reps', 'rep3') // idempotent — already linked, no-op (no duplicate, no event)
await accounts.unlink('acc1', 'reps', 'rep1') // remove every matching junction row, atomically
const repIds = await accounts.links('acc1', 'reps') // the distinct related keys reachable via the junction
```

`link` is idempotent (a matching junction row is checked for first, so re-linking never duplicates a row or fires a second `link` event); `unlink` removes every matching row inside one `transaction`, so a mid-removal fault leaves the junction untouched rather than partially deleted; `links` returns distinct keys even if the underlying junction has pre-existing duplicate rows.

### Cancellation

Every `ModelInterface` method takes an optional trailing `options?: ReadOptions` (`{ signal? }`) for cooperative cancellation — the same `ReadOptions` the database uses:

```ts
import { checkAbort } from '@orkestrel/database'

const controller = new AbortController()
const loading = accounts.load(
	'acc1',
	{ contacts: true, classification: true },
	{ signal: controller.signal },
)
controller.abort('too slow') // checked at entry, and again between each relation's batched query
await loading // rejects with a DatabaseError('ABORTED', …)
```

Cancellation is cooperative between queries, not mid-query — `checkAbort` (re-exported by `@orkestrel/database`) is checked before the populate loop starts and again before each relation's batched fetch; an already-aborted signal throws immediately, before any query runs.

### Observing

Each `Model` exposes a typed `emitter` (AGENTS §13) carrying its eager-load + junction moments for fire-and-forget observers — logging, metrics, a sync layer. Subscribe via `model.emitter.on(...)`. **Emitting is observation-only**: every event fires strictly AFTER the load resolves / the junction op completes, so a listener can never change what a load does (and a throwing one can't corrupt it). The `RelationManager` is event-free by design — a stateless registry that merely vends models has no observable lifecycle of its own; observe the per-model handle instead.

```ts
const accounts = manager.model('accounts')
accounts.emitter.on('load', (name, count) => metrics.record(`relation.${name}`, count))
accounts.emitter.on('link', (key, relation) => sync.push(key, relation))
```

The event vocabulary:

| Entity  | Event map       | Events                                                                |
| ------- | --------------- | --------------------------------------------------------------------- |
| `Model` | `ModelEventMap` | `load(name, count)` · `link(key, relation)` · `unlink(key, relation)` |

`load` fires ONCE per relation an eager-load resolves (`load` / `find`, including each nested relation) — carrying the relation name + the COUNT of related rows attached across the whole record set (the batched load has no N+1, and neither do its events — it is not one event per record); `link` / `unlink` fire after a junction row is inserted / removed, carrying the owning key + the relation name. Reads of the base rows are the table's concern (observe `model.table.emitter` for per-row `write` / `remove`).

**The listener-isolation safety guarantee.** A listener throw is NEVER allowed to escape into the load: the emitter isolates it and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`), NOT to a domain event — so a buggy observer is isolated yet not silently lost. The `error` handler runs in its own try/catch, so even a throwing handler can't recurse or escape; with no handler, the throw is swallowed silently. Because every emit sits after its transition AND is isolated, a buggy observer **cannot corrupt the batched eager-load or a junction write** — the load still resolves correctly and the junction row is still written — proven by the emit-safety tests. (A `Model` is reached via the `RelationManager`, which does not thread an `error` handler to it, so a `Model` listener throw is swallowed silently.)

### Practices

- **Define all related models up front** — nested includes resolve through the registry, so a relation you want to nest-load must have its own entry.
- **Use the builders** — `belongsTo` / `hasMany` / `hasOne` / `hasThrough` / `hasMorph` set an explicit `relationship`; the string / array shorthands are unambiguous, but a raw `{ key }` resolves to `one`.
- **Reach for typed CRUD through `model.table`** — the table is fully typed; relation loading is the looser layer on top.
- **Request only the relations you use** — each included relation is one extra query.
- **Use `link` / `unlink` / `links` for `through` joins** rather than writing junction rows by hand — `link` is idempotent and `unlink` is atomic, so retries are safe.
- **Observe, don't drive** — subscribe to `model.emitter` (`load` / `link` / `unlink`) for metrics or a sync layer (see [Observing](#observing)); emitting is a pure side-channel, so a listener never changes what a load does (and a throwing one can't corrupt it).
- **Index every relation column** — pass `createDatabase({ indexes })` for the FK column each `many` / `one` / `morph` relation batches on (its `key`), and for a `through` relation's junction source AND target columns. SQLite runs the batched `where(col).any(keys)` natively over the index; IndexedDB can only push an `equals` lookup down onto a single-column secondary index, so an unindexed FK/junction column falls back to a full scan under the hood even though the relation layer still issues one batched query.
- **Loaded relation rows may be shared references** — two parents that resolve to the same related row (e.g. two accounts sharing a `classification`) can receive the SAME object reference in their `Loaded` relation property. Treat every loaded relation value as readonly; never mutate it in place.

## Tests

- [`tests/guides/src/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports).
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — `resolveRelation` (shorthands, builders, inference, errors), `resolveRelationMap`, `isRelationDescriptor`.
- [`tests/src/core/RelationManager.test.ts`](../../tests/src/core/RelationManager.test.ts) — the manager-level surface: the registry (`count` / `models` / `has`), the typed `model(name)` accessor, and fail-fast construction-time validation (`INVALID` for a relation target / through junction that names an undeclared table).
- [`tests/src/core/Model.test.ts`](../../tests/src/core/Model.test.ts) — `Model` behavior: `load` / `find` populating each relation kind (batched, no N+1 — proven with a per-table scan-count recorder across multiple parents, `load([])`, a null/absent FK, and a through target pointing at a deleted row), nested `includes`, the loaded relation accessors, `link` (idempotent) / `unlink` (atomic, via a fault-injecting driver) / `links` (deduped) junction management, cooperative cancellation (`ReadOptions.signal`, checked at entry and between relations), and the `emitter` (`ModelEventMap`): `load(name, count)` fires once per relation (the attached count, including nested relations — not one per record), `link` / `unlink` carry the owning key + relation (a no-op `link` fires none), `on?` wiring, and the emit-safety guarantee (a throwing `load` / `link` observer can't corrupt the load or junction write — the emitter isolates it; a `Model` reached via the `RelationManager` has no `error` handler, so the throw is swallowed silently).
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createRelationManager` wires up a working, typed manager end to end.
- [`tests/src/core/sqlite.test.ts`](../../tests/src/core/sqlite.test.ts) — driver portability: the same multi-kind relation scenario over a real SQLite driver (`@orkestrel/database/server`) attaches identical results to the memory driver.

## See also

- [`database.md`](database.md) — the database, tables, and query layer relations build on.
- [`AGENTS.md`](../../AGENTS.md) — the rules; §12 errors, §14 totality, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
