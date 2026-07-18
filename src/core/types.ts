import type {
	DatabaseInterface,
	Direction,
	Key,
	Row,
	RowOf,
	TableInterface,
	TablesShape,
} from '@orkestrel/database'
import type { EmitterInterface } from '@orkestrel/emitter'

// Relations — ORM-style eager loading layered on the database. A relation
// manager is created over a database and a declarative map of per-table
// relations; each model pairs a typed table with relation-aware `load` / `find`
// and through-table management. Loading is batched (one query per relation over
// the whole record set, grouped in memory — no N+1). Types are the source of
// truth (AGENTS §2).

// === Relation kinds & descriptors

/**
 * The five relation shapes.
 *
 * @remarks
 * `belongs` — a foreign key on THIS table points at the related row (single).
 * `many` — a foreign key on the RELATED table points back here (array).
 * `one` — like `many`, but a single related row.
 * `through` — a junction table links the two sides (array, many-to-many).
 * `morph` — a foreign key plus a discriminator column on the RELATED table (array, polymorphic).
 */
export type Relationship = 'belongs' | 'many' | 'one' | 'through' | 'morph'

/**
 * The object form of a relation.
 *
 * @remarks
 * The builder helpers (`belongsTo` / `hasMany` / `hasOne` / `hasThrough` /
 * `hasMorph`) set `relationship` explicitly, which removes all ambiguity — `many`
 * and `one` are otherwise indistinguishable by fields alone. When `relationship`
 * is omitted (a hand-written descriptor) it is inferred from the fields present:
 * `column` → `belongs`; `through` + `source` + `target` → `through`; `key` +
 * `tag` + `label` → `morph`; `key` alone → `one`. `model` overrides the target
 * table name (it defaults to the relation name).
 */
export interface RelationDescriptor {
	readonly relationship?: Relationship
	readonly column?: string
	readonly key?: string
	readonly through?: string
	readonly source?: string
	readonly target?: string
	readonly tag?: string
	readonly label?: string
	readonly model?: string
}

/**
 * A single relation definition.
 *
 * @remarks
 * A `string` is a `belongs` (the FK column on this table); a `readonly string[]`
 * is a `many` (the first element is the FK column on the related table); a
 * {@link RelationDescriptor} is the object form for everything else.
 */
export type Relation = string | readonly string[] | RelationDescriptor

/** A model's relations, keyed by relation name. */
export type RelationMap = Readonly<Record<string, Relation>>

/** A machine-readable {@link RelationError} code. */
export type RelationErrorCode = 'INVALID' | 'UNKNOWN_RELATION' | 'NOT_THROUGH'

/**
 * Per-table relation maps — the declarative input to `createRelationManager`.
 *
 * @remarks
 * Keys are constrained to the database's declared table names, so relations can
 * only be defined for tables that exist. A table may be omitted (no relations).
 */
export type RelationsShape<T extends TablesShape = TablesShape> = {
	readonly [K in keyof T]?: RelationMap
}

/**
 * A relation resolved at define-time into a flat, ready-to-load form.
 *
 * @remarks
 * The relationship and every column needed to load, link, and unlink are
 * precomputed from the raw {@link Relation}, so no inference runs at query time.
 */
export interface ResolvedRelation {
	readonly relationship: Relationship
	readonly name: string
	readonly model: string
	readonly column?: string
	readonly key?: string
	readonly through?: string
	readonly source?: string
	readonly target?: string
	readonly tag?: string
	readonly label?: string
}

// === Loading

/**
 * Which relations to populate when loading — and, recursively, their own.
 *
 * @remarks
 * `true` loads the relation flat; a nested {@link Include} loads it and its
 * sub-relations. `false` (or omission) skips it.
 *
 * @example
 * ```ts
 * const include: Include = { contacts: true, submissions: { policy: true } }
 * ```
 */
export interface Include {
	readonly [relation: string]: boolean | Include
}

/**
 * The relation properties attached to a {@link Loaded} row — each relation name
 * mapped to its loaded related row(s), or `undefined` when a `belongs` / `one`
 * relation misses.
 *
 * @remarks
 * The broad value type (`Row | readonly Row[] | undefined`) is narrowed at the use
 * site. This is the mutable bag a `Model` fills while populating a record set;
 * `Loaded<T>` is a base row intersected with its `Readonly` form.
 */
export type RelationProps = Record<string, Row | readonly Row[] | undefined>

/**
 * A row with its loaded relation properties attached.
 *
 * @remarks
 * The base row is fully typed (the table's row type); the relation properties
 * ({@link RelationProps}) are broad — narrow them at the use site. Typing each
 * relation property to its target row is a deliberate (documented) deferral, like
 * the database guide's deferred pieces.
 */
export type Loaded<T> = T & Readonly<RelationProps>

/**
 * A related model's resolved relations and primary-key column, for nested loading.
 *
 * @remarks
 * The lookup result the relation registry hands a {@link ModelInterface} so it can
 * recurse into a related model's own relations. `RelationManager` produces it (one
 * per declared table); `Model` consumes it as its registry lookup's return. Shared
 * here so the producer and consumer stay in lockstep.
 */
export interface RelationContext {
	readonly resolved: ReadonlyMap<string, ResolvedRelation>
	readonly primary: string
}

/** Pagination and ordering for `find`. */
export interface FindOptions {
	readonly limit?: number
	readonly offset?: number
	readonly sort?: string
	readonly direction?: Direction
}

// === Model

/**
 * The push observation surface of a {@link ModelInterface} (AGENTS §13) — the eager-load
 * + junction-management moments a fire-and-forget observer (logging, metrics, a sync
 * layer) subscribes to.
 *
 * @typeParam TKey - The model's primary-key type (a {@link Key}); `link` / `unlink` carry
 *   the owning key so the map is `ModelEventMap<TKey>`.
 *
 * @remarks
 * `load` fires once per relation that an eager-load resolves, carrying the relation NAME +
 * the COUNT of related rows attached for the whole record set (it is the batched load
 * moment, not one event per record — there is no N+1 in the events either). `link` /
 * `unlink` fire after a junction row is inserted / removed, carrying the owning key + the
 * relation name. Listener isolation is the emitter's (AGENTS §13): every event is emitted
 * directly and a listener throw is routed to the emitter's `error` handler (the `error`
 * option), never onto this map, and sits AFTER the load resolves / the junction op completes
 * — so a throwing observer can never corrupt the eager-load batching or a junction write.
 * `RelationManager` is event-free by design (a stateless
 * registry that merely vends models — it has no observable lifecycle of its own); the
 * per-entity {@link ModelInterface} is where loading and linking happen, so the emitter
 * lives there. Subscribe via `model.emitter.on(...)`. Declared as a `type` alias (§4.5 —
 * `EventMap` is a `type` kind).
 */
export type ModelEventMap<TKey extends Key = Key> = {
	/** A relation eager-loaded — the relation name + the count of related rows attached. */
	readonly load: readonly [name: string, count: number]
	/** A junction row was inserted for a `through` relation — the owning key + relation name. */
	readonly link: readonly [key: TKey, relation: string]
	/** A junction row was removed for a `through` relation — the owning key + relation name. */
	readonly unlink: readonly [key: TKey, relation: string]
}

/**
 * A model — a typed table paired with relation-aware loading and junction
 * management.
 *
 * @remarks
 * Table operations are reached through `table` (a fully typed
 * {@link TableInterface}); relation loading and through management are on the
 * model itself. `load` fetches one record with its relations populated; `find`
 * fetches many; both batch-load (one query per relation regardless of result
 * size). `link` / `unlink` / `links` manage a `through` relation's junction rows.
 * Exposes a typed {@link emitter} (AGENTS §13) carrying the eager-load + junction
 * moments ({@link ModelEventMap}) for fire-and-forget observers — emitting is
 * observation-only (a swallowed listener throw can never corrupt the batched load).
 */
export interface ModelInterface<T = Row> {
	readonly emitter: EmitterInterface<ModelEventMap>
	readonly name: string
	readonly table: TableInterface<T>
	readonly relations: RelationMap
	load(key: Key, include: Include): Promise<Loaded<T> | undefined>
	load(keys: readonly Key[], include: Include): Promise<readonly (Loaded<T> | undefined)[]>
	find(include: Include, options?: FindOptions): Promise<readonly Loaded<T>[]>
	link(key: Key, relation: string, target: Key): Promise<void>
	unlink(key: Key, relation: string, target: Key): Promise<void>
	links(key: Key, relation: string): Promise<readonly Key[]>
}

// === Manager

/** Options for `createRelationManager`. */
export interface RelationManagerOptions<T extends TablesShape = TablesShape> {
	/**
	 * The database to build the registry over.
	 *
	 * @remarks
	 * Intersected with the broad `DatabaseInterface` so the manager gets both the
	 * precise view (typing each declared table for `model()`) and the broad view
	 * (runtime table lookup by name while resolving relations).
	 */
	readonly database: DatabaseInterface<T> & DatabaseInterface
	readonly relations?: RelationsShape<T>
}

/**
 * The relation registry — vends a typed {@link ModelInterface} per table.
 *
 * @remarks
 * Built from a database and a {@link RelationsShape}; relations are resolved once
 * at construction. `model(name)` returns the model for a declared table, typed by
 * that table's row. Follows the manager accessor pattern (`model` / `models`).
 */
export interface RelationManagerInterface<T extends TablesShape = TablesShape> {
	readonly count: number
	model<K extends keyof T & string>(name: K): ModelInterface<RowOf<T[K]>>
	models(): readonly string[]
	has(name: string): boolean
}
