# Relation

> A small, declarative ORM layer over the `@orkestrel/database` tables: a table's
> relations named once, then records loaded or found with their related rows already
> attached, batched so a direct relation costs one query across the whole record set and
> a `through` relation two.

The relationships (`belongs` / `many` / `one` / `through` / `morph`) cover the foreign-key shapes; nested includes recurse through the registry; `link` / `unlink` / `links` manage a many-to-many junction without hand-writing join rows. The layer stays thin above the typed store: resolution is define-time — each relation is precomputed once into a flat `ResolvedRelation`, and nothing is inferred while loading — and the loaded relation properties are deliberately loose (`Row | readonly Row[] | undefined`) rather than typed to each exact target row. The typed half is the table reached through `model.table`, and relation loading is the looser convenience on top. No write-cascades, no lazy proxies, no query builder of its own; [Limits](#limits) states each refusal and what reopens it. Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

## Surface

Create a manager over storage and its relation map, then reach a typed model and load with relations attached. In root examples, `TABLES` names the table map passed to `createDatabase`, and `db` is its returned `DatabaseInterface<typeof TABLES>`:

```ts
import { createRelationManager, belongsTo, hasMany, hasThrough } from '@orkestrel/relation'

const manager = createRelationManager<typeof TABLES>({
	storage: db, // the DatabaseInterface<typeof TABLES> returned by createDatabase(...)
	relations: {
		accounts: {
			classification: belongsTo('classificationId', 'classifications'), // foreign key on accounts → one classification
			contacts: hasMany('accountId'), // foreign key on contacts → many contacts back here
			representatives: hasThrough('accountReps', 'accountId', 'repId', 'representatives'), // many-to-many through a junction
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

| Name                    | Kind     | Signature                                                                                                                                                                                                                                                                                                        | Summary                                                                                                 |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createRelationManager` | function | `<T extends TableMap>(options: RelationManagerOptions<T>) => RelationManagerInterface<T>`                                                                                                                                                                                                                        | Creates a `RelationManagerInterface` over storage and its relation map.                                 |
| `RelationManager`       | class    | `new <T extends TableMap = TableMap>(options: RelationManagerOptions<T>) => RelationManagerInterface<T>`                                                                                                                                                                                                         | Resolves a `RelationSchema` once at construction and vends a typed `ModelInterface` per declared table. |
| `Model`                 | class    | `new <T = Row>(name: string, table: TableInterface<T>, resolved: ReadonlyMap<string, ResolvedRelation>, relations: RelationMap, lookup: (model: string) => RelationContext \| undefined, storage: DatabaseStorageInterface, on?: EmitterHooks<ModelEventMap>, error?: EmitterErrorHandler) => ModelInterface<T>` | Pairs a typed table with relation-aware `load` / `find` and junction management.                        |

### Builders

| Name         | Kind     | Signature                                                                                 | Summary                                                                                                         |
| ------------ | -------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `belongsTo`  | function | `(column: string, model?: string) => RelationDescriptor`                                  | Builds a `belongs` relation — a foreign key on the owning table points at the related row (single).             |
| `hasMany`    | function | `(key: string, model?: string) => RelationDescriptor`                                     | Builds a `many` relation — a foreign key on the related table points back at the owning row (array).            |
| `hasOne`     | function | `(key: string, model?: string) => RelationDescriptor`                                     | Builds a `one` relation — like `hasMany`, but a single related row.                                             |
| `hasThrough` | function | `(through: string, source: string, target: string, model?: string) => RelationDescriptor` | Builds a `through` relation — a junction table links the two sides (many-to-many).                              |
| `hasMorph`   | function | `(key: string, tag: string, label: string, model?: string) => RelationDescriptor`         | Builds a `morph` relation — a polymorphic foreign key plus a discriminator column on the related table (array). |

### Resolution

| Name                       | Kind     | Signature                                                                                                         | Summary                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `resolveRelation`          | function | `(name: string, value: Relation) => ResolvedRelation`                                                             | Resolves one raw `Relation` value into a flat `ResolvedRelation`.                           |
| `resolveRelationMap`       | function | `(relations: RelationMap) => ReadonlyMap<string, ResolvedRelation>`                                               | Resolves every entry of a `RelationMap` into a name → `ResolvedRelation` map.               |
| `isRelationDescriptor`     | const    | `Guard<RelationDescriptor>`                                                                                       | Narrows a value to a `RelationDescriptor` (the object form of a relation).                  |
| `validateRelationTable`    | function | `(storage: DatabaseStorageInterface, model: string, relation: string, table: string, junction?: boolean) => void` | Validates a relation table through its bound storage, translating only an undeclared table. |
| `validateRelationJunction` | function | `(model: string, resolved: ResolvedThrough, primary: string) => void`                                             | Validates that a `through` relation's junction keys its rows by a column of its own.        |

### Row helpers

| Name             | Kind     | Signature                                                                                                | Summary                                                                        |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `computeLinkKey` | function | `(key: Key, target: Key) => string`                                                                      | Computes the junction row's primary key for one pair of a `through` relation.  |
| `readRow`        | function | `<T>(table: string, row: T) => T & Row`                                                                  | Reads one row a storage returned, refusing a value that is not a plain record. |
| `countAttached`  | function | `(values: ReadonlyArray<Row \| readonly Row[] \| undefined>) => number`                                  | Counts the related rows one relation attached across a record set.             |
| `indexRows`      | function | `(rows: readonly Row[], column: string, values?: readonly Row[]) => ReadonlyMap<string, Row>`            | Indexes rows by the string form of one column, for keyed lookups.              |
| `groupRows`      | function | `(rows: readonly Row[], column: string, values?: readonly Row[]) => ReadonlyMap<string, readonly Row[]>` | Groups rows by the string form of one column, for one-to-many lookups.         |

### Contracts

The descriptor contract is one closed shape compiled once; `isRelationDescriptor` is its guard and `resolveRelation` admits through it, so a refusal carries the contract's faults.

| Name                         | Kind  | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Summary                                                                                       |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `relationDescriptorShape`    | const | `import("@orkestrel/contract").ObjectShape<{ relationship: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").LiteralShape<readonly ["belongs", "many", "one", "through", "morph"]>>; column: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; key: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; through: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; source: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; target: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; tag: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; label: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; model: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; }, false>` | Declares the object form of a relation as a closed contract shape.                            |
| `relationDescriptorContract` | const | `ContractInterface<RelationDescriptor>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Holds the compiled contract of a relation descriptor, which `resolveRelation` admits through. |

### Errors

| Name              | Kind     | Signature                                                                                                      | Summary                                                                                             |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `RelationError`   | class    | `new (code: RelationErrorCode, message: string, context?: Readonly<Record<string, unknown>>) => RelationError` | Represents an error thrown by the relations layer, carrying a machine-readable `RelationErrorCode`. |
| `isRelationError` | function | `(value: unknown) => value is RelationError`                                                                   | Narrows an unknown caught value to a `RelationError`.                                               |

### Types

The error guard recognizes the error's own identity brand across package copies and
module formats. It accepts subclasses regardless of their `name` and refuses
transparent proxies, unbranded look-alikes, and plain branded objects.

| Name                       | Kind      | Signature                                                                                                                                                                  | Summary                                                                                                                                                                               |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Relationship`             | type      | `'belongs' \| 'many' \| 'one' \| 'through' \| 'morph'`                                                                                                                     | Enumerates the relationships a relation can declare.                                                                                                                                  |
| `RelationDescriptor`       | interface | `{ relationship?, column?, key?, through?, source?, target?, tag?, label?, model? }`                                                                                       | Represents the object form of a relation.                                                                                                                                             |
| `Relation`                 | type      | `string \| readonly string[] \| RelationDescriptor`                                                                                                                        | Represents a single relation definition.                                                                                                                                              |
| `RelationMap`              | type      | `Readonly<Record<string, Relation>>`                                                                                                                                       | Holds a model's relations, keyed by relation name.                                                                                                                                    |
| `RelationSchema`           | type      | `{ readonly [K in keyof T]?: RelationMap; }`                                                                                                                               | Holds per-table relation maps — the declarative input to `createRelationManager`.                                                                                                     |
| `ResolvedRelation`         | type      | `ResolvedBelongs \| ResolvedMany \| ResolvedOne \| ResolvedThrough \| ResolvedMorph`                                                                                       | Represents a relation resolved at define-time into a flat, ready-to-load form.                                                                                                        |
| `ResolvedBelongs`          | interface | `{ relationship, name, model, column }`                                                                                                                                    | Represents a `belongs` relation resolved at define-time — the foreign key sits on the owning table.                                                                                   |
| `ResolvedMany`             | interface | `{ relationship, name, model, key }`                                                                                                                                       | Represents a `many` relation resolved at define-time — the foreign key sits on the related table.                                                                                     |
| `ResolvedOne`              | interface | `{ relationship, name, model, key }`                                                                                                                                       | Represents a `one` relation resolved at define-time — `ResolvedMany`'s foreign key, one row.                                                                                          |
| `ResolvedThrough`          | interface | `{ relationship, name, model, through, source, target }`                                                                                                                   | Represents a `through` relation resolved at define-time — a junction table links the two sides.                                                                                       |
| `ResolvedMorph`            | interface | `{ relationship, name, model, key, tag, label }`                                                                                                                           | Represents a `morph` relation resolved at define-time — a polymorphic foreign key and its discriminator.                                                                              |
| `RelationErrorCode`        | type      | `'INVALID' \| 'UNKNOWN_RELATION' \| 'NOT_THROUGH'`                                                                                                                         | Names a machine-readable `RelationError` code.                                                                                                                                        |
| `Include`                  | interface | `{ readonly [relation: string]: boolean \| Include }`                                                                                                                      | Selects which relations to populate when loading — and, recursively, their own.                                                                                                       |
| `Loaded`                   | type      | `T & Readonly<LoadedMap>`                                                                                                                                                  | Represents a row with its loaded relation properties attached.                                                                                                                        |
| `LoadedMap`                | type      | `Record<string, Row \| readonly Row[] \| undefined>`                                                                                                                       | Holds the relation properties attached to a `Loaded` row — each relation name mapped to its loaded related row(s), or `undefined` when a `belongs` / `one` relation misses.           |
| `RelationContext`          | interface | `{ resolved, primary }`                                                                                                                                                    | Holds a related model's resolved relations and primary-key column, for nested loading.                                                                                                |
| `FindOptions`              | interface | `{ limit?, offset?, sort?, direction? }`                                                                                                                                   | Configures pagination, ordering, and cancellation for `find`.                                                                                                                         |
| `ModelEventMap`            | type      | `{ readonly load: readonly [name: string, count: number]; readonly link: readonly [key: Key, relation: string]; readonly unlink: readonly [key: Key, relation: string]; }` | Declares the push observation surface of a `ModelInterface` — the eager-load + junction-management moments a fire-and-forget observer (logging, metrics, a sync layer) subscribes to. |
| `ModelInterface`           | interface | `{ emitter, name, table, relations, load(), find(), link(), unlink(), links() }`                                                                                           | Represents a typed table paired with relation-aware loading and junction management.                                                                                                  |
| `RelationManagerOptions`   | interface | `{ storage, relations?, model? }`                                                                                                                                          | Configures `createRelationManager`.                                                                                                                                                   |
| `RelationManagerInterface` | interface | `{ count, model(), names(), has() }`                                                                                                                                       | Vends a typed `ModelInterface` per table.                                                                                                                                             |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name, every call-signature member listed (its `readonly` data members, for example `emitter` / `name` / `table` / `relations` / `count`, stay in the Surface rows earlier — `Model`'s `emitter` is the typed push observation surface, see [Observing](#observing)). `Model` and `RelationManager` each implement their interface exactly, so this doubles as the per-instance method surface (`.claude/rules/documentation.md` § Parity).

#### `ModelInterface`

`load` / `find` batch-load (one query for a direct relation, two for `through`, regardless of result size); `link` / `unlink` / `links` manage a `through` relation's junction rows. Every method accepts the database package's optional `OperationOptions` abort signal; `find` carries the same signal in `FindOptions`.

| Method   | Returns                           | Summary                                                                                                             |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `load`   | `Promise<Loaded<T> \| undefined>` | Loads one record by key with the chosen relations populated, or a positional array of records for an array of keys. |
| `find`   | `Promise<readonly Loaded<T>[]>`   | Finds many records, paged and sorted through `FindOptions`, with the chosen relations populated.                    |
| `link`   | `Promise<void>`                   | Inserts the junction row for a pair through a `through` relation.                                                   |
| `unlink` | `Promise<void>`                   | Removes the junction row for a pair through a `through` relation.                                                   |
| `links`  | `Promise<readonly Key[]>`         | Lists the related keys reachable through a `through` relation.                                                      |

#### `RelationManagerInterface`

`model(name)` vends the typed model for a declared table; `names()` lists the table names that carry resolved relations, and `has(name)` reports whether a given table does.

| Method  | Returns                       | Summary                                                     |
| ------- | ----------------------------- | ----------------------------------------------------------- |
| `model` | `ModelInterface<RowOf<T[K]>>` | Returns the typed model for a declared table.               |
| `names` | `readonly string[]`           | Lists the names of every model carrying resolved relations. |
| `has`   | `boolean`                     | Reports whether a model carries resolved relations.         |

## Contract

These invariants hold across `src/core` ↔ `relation.md`:

1. **Doc ↔ source bijection.** Every `function` / `class` / `interface` / `type` row in the `## Surface` tables is a real export of the relations source tree, and every export appears as a Surface row — exhaustive, both directions (`.claude/rules/documentation.md` § Parity).
2. **Layered on typed storage and validated at construction.** A manager binds to `DatabaseStorageInterface<T> & DatabaseStorageInterface`: the `DatabaseInterface<T>` returned by `createDatabase`, or transaction storage. At a typed root, pass the table map as the type argument; a transaction scope infers it. A `Database<T>` class expression is outside this option contract. `model(name)` preserves the declared table row type. Related tables are resolved by runtime name at the broad `Row` type. Construction resolves every target and junction through `storage.table(name)`. An undeclared target or junction throws `INVALID` with `{ model, relation, table }`; other database errors propagate unchanged, including `CLOSED` when construction resolves a relation on a closed root and `CONFLICT` for settled transaction storage. A `through` relation whose junction primary column is its `source` or `target` column throws `INVALID` with `{ model, relation, table, column }`, because that column cannot hold the pair's derived key.
3. **Batch loading — no N+1.** A direct included relation uses one call over the distinct keys for the entire record set; a `through` relation uses two, one for the junction rows and one for the target rows. A load by primary key — a `belongs` load and a `through` target load — reads through the table's keyed `get`; a load by foreign key reads through `records` with `any`. Related rows are grouped in memory and attached, so either call count is independent of how many parents were loaded. Nested includes recurse through the registry, and each nested level is batched again under the same rule. `tests/guides.test.ts` asserts the exact calls per relationship and nesting level on a recording storage.
4. **Resolution is define-time.** Each raw `Relation` is resolved once at construction into a flat `ResolvedRelation` — a union discriminated on `relationship` whose every arm declares its own columns required, so a loader reads them after one narrow and never against an absent member; nothing is inferred during loading. The builders set an explicit `relationship` (so `many` and `one`, otherwise identical as `{ key }`, are unambiguous); a hand-written descriptor with no `relationship` infers one from the fields present (`through` → `through`, `tag` → `morph`, `column` → `belongs`, else `key` → `one`), and a malformed one throws `INVALID` at define-time. A descriptor must pass `relationDescriptorContract`'s strict guard: an enumerable, string-keyed undeclared member, a member holding another type, and a member present as `undefined` each throw `INVALID`, carrying the contract's audit faults described against its schema, and no lossless repair admits a descriptor.
5. **Total, loose `Loaded`.** `Loaded<T>` intersects the base row with `Readonly<LoadedMap>` (`Row | readonly Row[] | undefined` per relation). A missed `belongs` / `one` is `undefined`; a missed `many` / `through` / `morph` is `[]`. Through-only operations throw `NOT_THROUGH` for another relationship and `UNKNOWN_RELATION` for an undeclared relation. `link` is one insert under the pair's derived key, `computeLinkKey(key, target)`, which the junction's primary column holds as text; a pair the junction already holds writes and emits nothing, so concurrent calls for one pair leave one row and one `link` event. Any other database error, a `CONFLICT` from a settled or busy scope included, propagates unchanged. `unlink` is one remove of that key; a failed remove propagates unchanged and emits no `unlink` event. A row a storage returns that is not a plain record throws `INVALID` naming its `table`; it never reads as a miss and is never dropped.
6. **Observation is a pure side-channel.** A `Model` owns a typed `emitter` (`ModelEventMap` — `load(name, count)` / `link(key, relation)` / `unlink(key, relation)`); `RelationManager` is event-free by design (a stateless registry has no observable lifecycle). Every event is emitted directly (the `.claude/rules/patterns.md` § Stateful emitters convention: the emitter isolates a listener throw, routing it to its own `error` handler — the `error` option, surfaced as `(error, event)`, never a domain event — itself re-entrancy-guarded) strictly after the load resolves and after the junction operation completes. `load` fires once per relation (carrying the count of rows attached across the record set — no N+1 in the events), so a buggy observer can corrupt neither the batched eager-load nor a junction write (proven by the emit-safety tests). `link` fires only when it inserted a row and `unlink` only when it removed one. `link` and `unlink` report completion within the bound scope, before any outer commit; an event can therefore precede an outer rollback.
7. **Cooperative cancellation.** Every model operation accepts the database package's abort option. Query reads pass the signal to `records`. The keyed `get` read takes no options in the database package, so `load` checks the signal before it and again before each relation in the population walk; a batched `get` already in flight runs to completion. Writes pass it to their bound storage mutation. An aborted signal surfaces unchanged as the database package's `ABORTED` error.
8. **Doc ↔ source method bijection.** Every behavioral interface's `## Methods` table lists exactly its public methods (call-signature members) — exhaustive, both directions — and each implementing class (`Model` / `RelationManager`) exposes the same public methods, no more (`.claude/rules/documentation.md` § Parity). A renamed / added / removed method breaks the gate until the table is reconciled.

The `Model` is **observable** — it owns a typed `emitter` (`ModelEventMap`) carrying its eager-load + junction moments (see [Observing](#observing)); `RelationManager` stays event-free by design (a stateless registry that merely vends models has no observable lifecycle of its own).

### Limits

Each refusal names what reopens it, and each requirement names its owner:

- **Typed loaded relations are refused.** A loaded relation property stays `Row | readonly Row[] | undefined`. A consumer that narrows a loaded relation property by hand reopens it.
- **Write-cascades belong to the database.** `Model` holds table-only storage and no transaction, so it writes no cascade. A release of that row's references reopens whether a relation declares its cascade there. The `@orkestrel/database` campaign's unique-index and references row owns it: the engine's `ON DELETE` on SQLite, and a check inside the transaction on IndexedDB.
- **The application declares the indexes.** Declare an index on each foreign-key column and each junction column a relation reads; the application owns these declarations.
- **An include returns every related row of every loaded parent.** `limit` on `find` bounds the parents, never the related rows, and a `one` relationship reads every match and keeps the first. A client page bar an include breaks, or an engine size refusal, reopens it.
- **A junction's primary column stores text, and `link` owns its value.** This requirement is the application's to meet: declare a text primary column apart from the `source` and `target` columns, because `link` writes the pair's derived key there. Each refusal that enforces it names what reopens it:
  - A numeric junction primary column refuses the row with the database's `VALIDATION` error; a consumer that declares a numeric junction primary reopens it.
  - Construction refuses a junction keyed by its `source` or `target` column with `INVALID`; a consumer whose junction must be keyed by one of those columns reopens it.
  - Junction rows an earlier release wrote under generated keys are not migrated; a consumer holding such rows reopens it.

Loaded relation properties replace same-named columns in returned rows. Grouping and indexing read the raw columns, so attachments survive that shadowing. Read an original column through `model.table` when a relation replaces it.

## Patterns

### Defining relations

Declare every relationship with its builder, then load a record with the chosen relations
attached:

```ts
import {
	createRelationManager,
	belongsTo,
	hasMany,
	hasOne,
	hasThrough,
	hasMorph,
} from '@orkestrel/relation'

const manager = createRelationManager<typeof TABLES>({
	storage: db,
	relations: {
		accounts: {
			classification: belongsTo('classificationId', 'classifications'), // foreign key on accounts
			contacts: hasMany('accountId'), // foreign key on contacts → accounts
			profile: hasOne('accountId', 'profiles'), // single, foreign key on profiles
			representatives: hasThrough('accountReps', 'accountId', 'repId', 'representatives'), // through a junction
			notes: hasMorph('entityId', 'entityType', 'account', 'notes'), // polymorphic
		},
		contacts: { account: belongsTo('accountId', 'accounts') },
	},
})

const acme = await manager.model('accounts').load('acc1', { contacts: true, classification: true })
```

The shorthands cover the common relationships — a bare string is a `belongsTo` column, and a one-element array is a `hasMany` key (both unambiguous, so they need no `relationship`):

```ts
relations: { accounts: { classification: 'classificationId', contacts: ['accountId'] } }
```

Reach for the builders for everything else: they set an explicit `relationship`, which is what disambiguates `many` from `one` (a raw `{ key }` descriptor infers `one`).

The relationships, and where each foreign key lives:

| Relationship | Builder      | Foreign key location | Returns               |
| ------------ | ------------ | -------------------- | --------------------- |
| `belongs`    | `belongsTo`  | the owning table     | single or `undefined` |
| `many`       | `hasMany`    | the related table    | array                 |
| `one`        | `hasOne`     | the related table    | single or `undefined` |
| `through`    | `hasThrough` | the junction table   | array                 |
| `morph`      | `hasMorph`   | the related table    | array                 |

### Resolving relations directly

`resolveRelationMap` and the `resolveRelation` it runs per entry are what `createRelationManager` calls at construction to turn a raw `RelationMap` into one `ResolvedRelation` per entry, and `isRelationDescriptor` is the strict guard `resolveRelation` gates each descriptor on — reach for them directly when validating a relation map before wiring a manager, or when testing a descriptor's inferred `relationship`:

```ts
import { isRelationDescriptor, resolveRelation, resolveRelationMap } from '@orkestrel/relation'

const resolved = resolveRelation('classification', belongsTo('classificationId', 'classifications'))
resolved.relationship // 'belongs'

const map = resolveRelationMap({ contacts: hasMany('accountId') })
map.get('contacts')?.relationship // 'many'

isRelationDescriptor(belongsTo('classificationId')) // true — the object form
```

`ResolvedRelation` is a union discriminated on `relationship`, so narrow on that member
before reading an arm's own columns. Each arm declares its columns required —
`ResolvedThrough` carries `through` / `source` / `target`, `ResolvedMorph` carries `key` /
`tag` / `label` — because `resolveRelation` refuses a descriptor missing one:

```ts
import { resolveRelation, hasThrough } from '@orkestrel/relation'

const resolved = resolveRelation('reps', hasThrough('accountReps', 'accountId', 'repId'))
if (resolved.relationship === 'through') {
	resolved.through // 'accountReps' — a required string on this arm
	resolved.source // 'accountId'
	resolved.target // 'repId'
}
```

Catch a malformed relation with `isRelationError`, branching on its machine-readable `code`:

```ts
import { isRelationError } from '@orkestrel/relation'

try {
	resolveRelation('bad', {})
} catch (error) {
	if (isRelationError(error)) error.code // 'INVALID'
}
```

Validate a target through a bound storage view; an undeclared target throws `INVALID` with its model, relation, and table context:

```ts
import { validateRelationTable } from '@orkestrel/relation'

validateRelationTable(storage, 'accounts', 'contacts', 'contacts')
```

### The registry surface

Beyond `model(name)`, a `RelationManager` exposes `names()` (every table name with resolved relations) and `has(name)` (whether a given table has any):

```ts
manager.names() // for example ['accounts', 'contacts']
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
	{ representatives: true },
	{ sort: 'name', direction: 'ascending', limit: 10 },
)

// Nested includes — load a relation's own relations (recurses through the registry):
const deep = await accounts.load('acc1', { contacts: { account: true } })

// Batch by key array: an array in, an array out — and this direct-relation fetch is
// still one query across all parents (no N+1), not one per key.
const [a, b] = await accounts.load(['acc1', 'acc2'], { contacts: true })
```

### Typed table access

For writes and plain queries, drop through to `model.table` — the full typed `TableInterface` for that model's table. This is the typed half; eager loading is the looser convenience layered on it.

```ts
const accounts = manager.model('accounts')
await accounts.table.set({ id: 'acc4', name: 'New Corp', classificationId: 'cls1' }) // fully typed
await accounts.table
	.query()
	.condition({ column: 'name', operator: 'starts', values: ['A'], connector: 'and' })
	.collect()
```

### Through management

A `through` relation's junction rows are managed by key — no need to model the junction table yourself or hand-write join rows. `link` / `unlink` / `links` resolve the relation's junction table + its source/target columns from the define-time `ResolvedRelation`, and throw `NOT_THROUGH` if pointed at a non-`through` relation.

```ts
await accounts.link('acc1', 'representatives', 'rep3') // one insert under computeLinkKey('acc1', 'rep3')
await accounts.link('acc1', 'representatives', 'rep3') // already linked: no write and no event
await accounts.unlink('acc1', 'representatives', 'rep1') // one remove; emits only when a row was removed
const repIds = await accounts.links('acc1', 'representatives') // the related keys reachable through the junction
```

Pass an abort signal through the same operation option used by the database package:

```ts
const controller = new AbortController()
const pending = accounts.load(
	'acc1',
	{ contacts: true, classification: true },
	{
		signal: controller.signal,
	},
)
controller.abort('stop loading')
await pending
```

### Transactions

Construct the manager inside the transaction callback so its tables and relation operations share that scope. Retain the manager only within the callback; models and tables reject work after settlement with `CONFLICT`. This example reads the contact written in its scope and asserts its count:

```ts
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { isArray, stringShape } from '@orkestrel/contract'
import { createRelationManager, hasMany } from '@orkestrel/relation'

const TABLES = {
	accounts: { id: stringShape(), name: stringShape() },
	contacts: { id: stringShape(), accountId: stringShape() },
}
const database = createDatabase({ driver: createMemoryDriver(), tables: TABLES })
const count = await database.transaction(async (storage) => {
	const manager = createRelationManager({
		storage,
		relations: { accounts: { contacts: hasMany('accountId') } },
	})
	await manager.model('accounts').table.set({ id: 'a1', name: 'Acme' })
	await storage.table('contacts').set({ id: 'c1', accountId: 'a1' })
	const account = await manager.model('accounts').load('a1', { contacts: true })
	return isArray(account?.contacts) ? account.contacts.length : 0
})
if (count !== 1) throw new Error('Expected one related contact')
```

An uncaught scope failure rolls its writes back. Model `link` and `unlink` events fire after their junction operation completes in scope and before the outer commit. Publish effects that require committed data after `database.transaction()` resolves.

### Observing

Each `Model` exposes a typed `emitter` carrying its eager-load + junction moments for fire-and-forget observers — logging, metrics, a sync layer. Subscribe through `model.emitter.on(...)`. **Emitting is observation-only**: every event fires strictly after the load resolves and after the junction operation completes, so a listener can never change what a load does (and a throwing one can't corrupt it). The `RelationManager` is event-free by design — a stateless registry that merely vends models has no observable lifecycle of its own; observe the per-model handle instead.

```ts
const accounts = manager.model('accounts')
accounts.emitter.on('load', (name, count) => metrics.record(`relation.${name}`, count))
accounts.emitter.on('link', (key, relation) => sync.push(key, relation))
```

`model(name)` returns a fresh handle on every call, and each handle owns its own emitter. Retain the handle you subscribed to; a later `manager.model('accounts')` is a different observer surface. To observe every handle a manager vends, pass the listeners once as the manager's `model` option:

```ts
const manager = createRelationManager<typeof TABLES>({
	storage: db,
	relations: { accounts: { contacts: hasMany('accountId') } },
	model: {
		on: { load: (name, count) => metrics.record(`relation.${name}`, count) },
		error: (error, event) => metrics.fault(event, error),
	},
})
```

The event vocabulary:

| Entity  | Event map       | Events                                                                |
| ------- | --------------- | --------------------------------------------------------------------- |
| `Model` | `ModelEventMap` | `load(name, count)` · `link(key, relation)` · `unlink(key, relation)` |

`load` fires once per relation an eager-load resolves (`load` / `find`, including each nested relation) — carrying the relation name and the count of related rows attached across the whole record set (the batched load has no N+1, and neither do its events — it is not one event per record); `link` / `unlink` fire after a junction row is inserted / removed, carrying the owning key + the relation name. Reads of the base rows are the table's concern (observe `model.table.emitter` for per-row `write` / `remove`).

**Listener isolation.** A listener throw never escapes into the load: the emitter isolates it and routes it to its own `error` handler (the `error` option, surfaced as `(error, event)`), never to a domain event — so a buggy observer is isolated yet not silently lost. The `error` handler runs in its own try/catch, so even a throwing handler can't recurse or escape; with no handler, the throw is swallowed silently. Because every emit sits after its transition and is isolated, a buggy observer **cannot corrupt the batched eager-load or a junction write** — the load still resolves correctly and the junction row is still written — proven by the emit-safety tests. A `Model` is reached through the `RelationManager`, which threads the `model.error` option into every handle it vends, so set that option to receive a `Model` listener throw; leave it unset and the throw is swallowed silently.

### Practices

- **Define all related models up front** — nested includes resolve through the registry, so a relation you want to nest-load must have its own entry.
- **Use the builders** — `belongsTo` / `hasMany` / `hasOne` / `hasThrough` / `hasMorph` set an explicit `relationship`; the string / array shorthands are unambiguous, but a raw `{ key }` resolves to `one`.
- **Reach for typed CRUD through `model.table`** — the table is fully typed; relation loading is the looser layer on top.
- **Request only the relations you use** — each direct relation adds one query; each `through` relation adds two.
- **Use `link` / `unlink` / `links` for `through` joins** rather than writing junction rows by hand.
- **Observe, don't drive** — subscribe to `model.emitter` (`load` / `link` / `unlink`) for metrics or a sync layer (see [Observing](#observing)); emitting is a pure side-channel, so a listener never changes what a load does (and a throwing one can't corrupt it).

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports), the `ModelInterface` / `RelationManagerInterface` ↔ `Model` / `RelationManager` method bijections, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Defining relations` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the guide's value-claiming fences and asserts the values their comments claim, the exact table calls each relationship and nesting level makes on a recording storage with a per-parent control, and the include limits.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — `resolveRelation` (shorthands, builders, inference, errors, an undeclared descriptor member refused with its fault, a wrong-typed, padded, or present-`undefined` member refused rather than repaired, the declared members and relationship candidates named in the refusal, a bounded relation name and fault text), `resolveRelationMap`, `validateRelationJunction`, `readRow`, `computeLinkKey`, `countAttached`, `indexRows`, `groupRows`.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — `isRelationDescriptor` over the object form, the builders' output, the string / array shorthands, a member holding the wrong type, a member the descriptor does not declare, and a `relationship` outside the union.
- [`tests/src/core/RelationManager.test.ts`](../tests/src/core/RelationManager.test.ts) — the manager-level surface: the registry (`count` / `names` / `has`), the typed `model(name)` accessor, and construction-time `INVALID` errors for undeclared relation and junction tables, a descriptor contract repairs would admit, and a junction keyed by its `source` or `target` column.
- [`tests/src/core/Model.test.ts`](../tests/src/core/Model.test.ts) — `Model` behavior: `load` / `find` populating each relationship, nested `includes`, the loaded relation accessors, `link` as one `add` and `unlink` as one `remove` on a recording storage, two concurrent `link` calls leaving one row on MemoryDriver and on SQLite, an absent `unlink` emitting nothing, a `CONFLICT` from a busy or settled scope propagating, a numeric junction primary refused, a non-record row from a custom storage raising `INVALID` naming its table, cooperative cancellation (including an abort between a `through` junction read and its target read), `links`, and the `emitter` (`ModelEventMap`): `load(name, count)` fires once per relation, `link` / `unlink` carry the owning key + relation, `on?` wiring through the manager's `model` option, and emit safety.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createRelationManager` wires up a working, typed manager end to end.

## See also

- [`database.md`](database.md) — the database, tables, and query layer relations build on.
- [`AGENTS.md`](../AGENTS.md) — the coding contract and its rule map.
- [`README.md`](README.md) — the guides index.
