import type { DatabaseInterface, Key, ReadOptions, Row, TableInterface } from '@orkestrel/database'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type {
	FindOptions,
	Include,
	Loaded,
	ModelEventMap,
	ModelInterface,
	RelationContext,
	RelationMap,
	RelationProps,
	ResolvedRelation,
} from './types.js'
import { checkAbort, extractKey } from '@orkestrel/database'
import { Emitter } from '@orkestrel/emitter'
import { isArray, isDefined } from '@orkestrel/contract'
import { RelationError } from './errors.js'

/**
 * A model — a typed table paired with relation-aware loading.
 *
 * @remarks
 * The model's own table is fully typed (`table`); related tables are reached by
 * runtime name through the database at the broad `Row` type. Loading is batched:
 * for each relation, one query fetches the related rows for the whole record set
 * (`where(col).any(keys)`), grouped in memory and attached — no N+1. Nested
 * includes recurse through the registry `lookup`, so loaded relations carry their
 * own loaded relations. Columns are read with `Reflect.get` (the base row's type
 * is closed) and relation properties merged with `Object.assign` — no `as`.
 *
 * @remarks
 * - **Observable (§13).** The owned {@link emitter} ({@link ModelEventMap}) carries the
 *   eager-load + junction moments — `load` (a relation resolved: its name + the count of
 *   related rows attached across the whole record set), `link` / `unlink` (a junction row
 *   written) — for fire-and-forget observers. Every event is emitted directly, strictly
 *   AFTER the load resolves / the junction op completes; the emitter isolates a listener
 *   throw and routes it to its `error` handler (the `error` option), so a buggy observer can
 *   never corrupt the batched eager-load (no N+1 in the events either — one `load` per
 *   relation, not per record).
 */
export class Model<T extends object = Row> implements ModelInterface<T> {
	readonly #name: string
	readonly #table: TableInterface<T>
	readonly #resolved: ReadonlyMap<string, ResolvedRelation>
	readonly #relations: RelationMap
	readonly #lookup: (model: string) => RelationContext | undefined
	readonly #database: DatabaseInterface
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into the
	// batched eager-load.
	readonly #emitter: Emitter<ModelEventMap>

	constructor(
		name: string,
		table: TableInterface<T>,
		resolved: ReadonlyMap<string, ResolvedRelation>,
		relations: RelationMap,
		lookup: (model: string) => RelationContext | undefined,
		database: DatabaseInterface,
		on?: EmitterHooks<ModelEventMap>,
		error?: EmitterErrorHandler,
	) {
		this.#name = name
		this.#table = table
		this.#resolved = resolved
		this.#relations = relations
		this.#lookup = lookup
		this.#database = database
		this.#emitter = new Emitter<ModelEventMap>({ on, error })
	}

	get emitter(): EmitterInterface<ModelEventMap> {
		return this.#emitter
	}

	get name(): string {
		return this.#name
	}

	get table(): TableInterface<T> {
		return this.#table
	}

	get relations(): RelationMap {
		return this.#relations
	}

	load(key: Key, include: Include, options?: ReadOptions): Promise<Loaded<T> | undefined>
	load(
		keys: readonly Key[],
		include: Include,
		options?: ReadOptions,
	): Promise<readonly (Loaded<T> | undefined)[]>
	async load(
		keys: Key | readonly Key[],
		include: Include,
		options?: ReadOptions,
	): Promise<(Loaded<T> | undefined) | readonly (Loaded<T> | undefined)[]> {
		checkAbort(options?.signal)
		if (isArray(keys)) {
			// Batch: one `get`, then one populate over all present rows (no N+1).
			const bases = await this.#table.get(keys)
			const present = bases.filter(isDefined)
			const props = await this.#populate(
				present,
				include,
				this.#resolved,
				this.#table.primary,
				options?.signal,
			)
			let next = 0
			return bases.map((base) =>
				base === undefined ? undefined : Object.assign({}, base, props[next++]),
			)
		}
		const base = await this.#table.get(keys)
		if (base === undefined) return undefined
		const [props] = await this.#populate(
			[base],
			include,
			this.#resolved,
			this.#table.primary,
			options?.signal,
		)
		return Object.assign({}, base, props)
	}

	async find(include: Include, options?: FindOptions): Promise<readonly Loaded<T>[]> {
		checkAbort(options?.signal)
		const query = this.#table.query()
		if (options?.sort !== undefined) {
			if (options.direction === 'descending') query.descending(options.sort)
			else query.ascending(options.sort)
		}
		if (options?.offset !== undefined) query.offset(options.offset)
		if (options?.limit !== undefined) query.limit(options.limit)
		const records = await query.all()
		const props = await this.#populate(
			records,
			include,
			this.#resolved,
			this.#table.primary,
			options?.signal,
		)
		return records.map((record, index) => Object.assign({}, record, props[index]))
	}

	/**
	 * Insert a junction row for a `through` relation — idempotent.
	 *
	 * @remarks
	 * When a junction row already exists for `(key, target)`, `link` returns without
	 * writing and without emitting `link` — a no-op link is silent, never a duplicate
	 * insert. The junction table has no declared primary key on its FK pair, so a fresh
	 * insert relies on the database's `key` factory (`createDatabase({ key })`) to mint
	 * one; a database created without one throws a `VALIDATION` `DatabaseError` on the
	 * underlying `set`.
	 *
	 * @param key - The owning record's key
	 * @param relation - The `through` relation's name
	 * @param target - The related record's key to link
	 * @param options - Optional `{ signal }` — checked at entry (cooperative cancellation)
	 */
	async link(key: Key, relation: string, target: Key, options?: ReadOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const source = resolved.source ?? ''
		const column = resolved.target ?? ''
		const junction = this.#database.table(resolved.through ?? '')
		const existing = await junction
			.query()
			.where(source)
			.equals(key)
			.and(column)
			.equals(target)
			.first()
		// Idempotent: a matching junction row already exists — no write, no `link` event.
		if (existing !== undefined) return
		await junction.set({ [source]: key, [column]: target }, options)
		// Observe the inserted junction row — AFTER the driver write, so a swallowed listener
		// throw can't perturb the link (carries the owning key + the relation name).
		this.#emitter.emit('link', key, relation)
	}

	async unlink(key: Key, relation: string, target: Key, options?: ReadOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction
			.query()
			.where(resolved.source ?? '')
			.equals(key)
			.and(resolved.target ?? '')
			.equals(target)
			.all()
		// Atomic: every matching junction row is removed inside one transaction, so a
		// mid-loop fault (a wrapping/failing driver) leaves the junction unchanged rather
		// than partially deleted.
		await this.#database.transaction(async () => {
			for (const row of rows) {
				const id = extractKey(row, junction.primary)
				if (id !== undefined) await junction.remove(id, options)
			}
		}, options)
		// Observe the removed junction — AFTER the transaction commits.
		this.#emitter.emit('unlink', key, relation)
	}

	async links(key: Key, relation: string, options?: ReadOptions): Promise<readonly Key[]> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction
			.query()
			.where(resolved.source ?? '')
			.equals(key)
			.all()
		const target = resolved.target ?? ''
		// Dedupe — defense-in-depth against pre-existing duplicate junction rows.
		const keys = new Set<Key>()
		for (const row of rows) {
			const value = extractKey(row, target)
			if (value !== undefined) keys.add(value)
		}
		return [...keys]
	}

	// === Private

	// Read a column off any record (the base row's type is closed — no index access).
	#field(record: object, column: string): unknown {
		return Reflect.get(record, column)
	}

	// Resolve a `through` relation by name, or throw a descriptive error.
	#through(relation: string): ResolvedRelation {
		const resolved = this.#resolved.get(relation)
		if (resolved === undefined) {
			throw new RelationError(
				'UNKNOWN_RELATION',
				`Model '${this.#name}' has no relation '${relation}'`,
				{ model: this.#name, relation },
			)
		}
		if (resolved.relationship !== 'through') {
			throw new RelationError(
				'NOT_THROUGH',
				`Relation '${relation}' on '${this.#name}' is not a through`,
				{ model: this.#name, relation },
			)
		}
		return resolved
	}

	// Compute the relation properties for each record (parallel to `records`).
	async #populate(
		records: readonly object[],
		include: Include,
		resolvedMap: ReadonlyMap<string, ResolvedRelation>,
		primary: string,
		signal?: AbortSignal,
	): Promise<RelationProps[]> {
		checkAbort(signal)
		const props: RelationProps[] = records.map(() => ({}))
		for (const [name, sub] of Object.entries(include)) {
			if (sub === false) continue
			// Cooperative cancellation: checked between each per-relation batched query, not
			// mid-query (query terminals take no signal — AGENTS: cancellation here is
			// cooperative between queries).
			checkAbort(signal)
			const resolved = resolvedMap.get(name)
			if (resolved === undefined) continue
			const values = await this.#load(records, resolved, sub, primary, signal)
			values.forEach((value, index) => {
				props[index][resolved.name] = value
			})
			// Observe this relation's eager-load — AFTER it resolved + was attached, ONCE per
			// relation (not per record — the batched load has no N+1, nor do its events),
			// carrying the relation name + the total related rows attached across the set.
			this.#emitter.emit('load', resolved.name, this.#attached(values))
		}
		return props
	}

	// The total related rows a relation's values attached across the record set — an
	// array-valued relation (`many` / `through` / `morph`) sums its lengths, a single-
	// valued one (`belongs` / `one`) counts each present row. The `load` event's `count`.
	#attached(values: readonly (Row | readonly Row[] | undefined)[]): number {
		let total = 0
		for (const value of values) {
			if (isArray(value)) total += value.length
			else if (value !== undefined) total += 1
		}
		return total
	}

	// Dispatch one relation to its loader, returning a value per record.
	async #load(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		signal?: AbortSignal,
	): Promise<(Row | readonly Row[] | undefined)[]> {
		switch (resolved.relationship) {
			case 'belongs':
				return this.#loadBelongs(records, resolved, sub, signal)
			case 'many':
				return this.#loadMany(records, resolved, sub, primary, signal)
			case 'one':
				return this.#loadOne(records, resolved, sub, primary, signal)
			case 'through':
				return this.#loadThrough(records, resolved, sub, primary, signal)
			case 'morph':
				return this.#loadMorph(records, resolved, sub, primary, signal)
		}
	}

	async #loadBelongs(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		signal?: AbortSignal,
	): Promise<(Row | undefined)[]> {
		const column = resolved.column ?? ''
		const keys = [
			...new Set(records.map((record) => this.#field(record, column)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => undefined)
		const related = this.#database.table(resolved.model)
		const rows = await related.query().where(related.primary).any(keys).all()
		const index = this.#index(await this.#nest(resolved.model, rows, sub, signal), related.primary)
		return records.map((record) => {
			const fk = this.#field(record, column)
			return isDefined(fk) ? index.get(String(fk)) : undefined
		})
	}

	async #loadMany(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		signal?: AbortSignal,
	): Promise<(readonly Row[])[]> {
		const foreign = resolved.key ?? ''
		const keys = [
			...new Set(records.map((record) => this.#field(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = await this.#database.table(resolved.model).query().where(foreign).any(keys).all()
		const groups = this.#group(await this.#nest(resolved.model, rows, sub, signal), foreign)
		return records.map((record) => groups.get(String(this.#field(record, primary))) ?? [])
	}

	async #loadOne(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		signal?: AbortSignal,
	): Promise<(Row | undefined)[]> {
		const groups = await this.#loadMany(records, resolved, sub, primary, signal)
		return groups.map((group) => (group.length > 0 ? group[0] : undefined))
	}

	async #loadThrough(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		signal?: AbortSignal,
	): Promise<(readonly Row[])[]> {
		const source = resolved.source ?? ''
		const target = resolved.target ?? ''
		const parents = [
			...new Set(records.map((record) => this.#field(record, primary)).filter(isDefined)),
		]
		if (parents.length === 0) return records.map(() => [])

		const junctions = await this.#database
			.table(resolved.through ?? '')
			.query()
			.where(source)
			.any(parents)
			.all()
		const targetsBySource = new Map<string, unknown[]>()
		for (const junction of junctions) {
			const value = this.#field(junction, target)
			if (!isDefined(value)) continue
			const owner = String(this.#field(junction, source))
			const list = targetsBySource.get(owner)
			if (list !== undefined) list.push(value)
			else targetsBySource.set(owner, [value])
		}

		const targets = [...new Set([...targetsBySource.values()].flat())]
		if (targets.length === 0) return records.map(() => [])
		const related = this.#database.table(resolved.model)
		const rows = await related.query().where(related.primary).any(targets).all()
		const index = this.#index(await this.#nest(resolved.model, rows, sub, signal), related.primary)

		return records.map((record) => {
			// Dedupe — defense-in-depth against pre-existing duplicate junction rows.
			const seen = new Set<string>()
			const out: Row[] = []
			for (const value of targetsBySource.get(String(this.#field(record, primary))) ?? []) {
				const key = String(value)
				if (seen.has(key)) continue
				const row = index.get(key)
				if (row !== undefined) {
					seen.add(key)
					out.push(row)
				}
			}
			return out
		})
	}

	async #loadMorph(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		signal?: AbortSignal,
	): Promise<(readonly Row[])[]> {
		const foreign = resolved.key ?? ''
		const keys = [
			...new Set(records.map((record) => this.#field(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = await this.#database
			.table(resolved.model)
			.query()
			.where(foreign)
			.any(keys)
			.and(resolved.tag ?? '')
			.equals(resolved.label ?? '')
			.all()
		const groups = this.#group(await this.#nest(resolved.model, rows, sub, signal), foreign)
		return records.map((record) => groups.get(String(this.#field(record, primary))) ?? [])
	}

	// Recursively load a nested include onto related rows (when `sub` is an Include).
	async #nest(
		model: string,
		rows: readonly Row[],
		sub: boolean | Include,
		signal?: AbortSignal,
	): Promise<readonly Row[]> {
		if (typeof sub === 'boolean' || rows.length === 0) return rows
		const context = this.#lookup(model)
		if (context === undefined) return rows
		const props = await this.#populate(rows, sub, context.resolved, context.primary, signal)
		return rows.map((row, index) => Object.assign({}, row, props[index]))
	}

	// Index rows by the string form of a column (for one-to-one key lookups).
	#index(rows: readonly Row[], column: string): Map<string, Row> {
		const map = new Map<string, Row>()
		for (const row of rows) map.set(String(this.#field(row, column)), row)
		return map
	}

	// Group rows by the string form of a column (for one-to-many lookups).
	#group(rows: readonly Row[], column: string): Map<string, Row[]> {
		const map = new Map<string, Row[]>()
		for (const row of rows) {
			const key = String(this.#field(row, column))
			const group = map.get(key)
			if (group !== undefined) group.push(row)
			else map.set(key, [row])
		}
		return map
	}
}
