import type { DatabaseInterface, Key, Row, TableInterface } from '../databases/index.js'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '../emitters/index.js'
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
import { extractKey } from '../databases/index.js'
import { Emitter } from '../emitters/index.js'
import { isArray, isDefined } from '../contracts/index.js'
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

	load(key: Key, include: Include): Promise<Loaded<T> | undefined>
	load(keys: readonly Key[], include: Include): Promise<readonly (Loaded<T> | undefined)[]>
	async load(
		keys: Key | readonly Key[],
		include: Include,
	): Promise<(Loaded<T> | undefined) | readonly (Loaded<T> | undefined)[]> {
		if (isArray(keys)) {
			// Batch: one `get`, then one populate over all present rows (no N+1).
			const bases = await this.#table.get(keys)
			const present = bases.filter(isDefined)
			const props = await this.#populate(present, include, this.#resolved, this.#table.primary)
			let next = 0
			return bases.map((base) =>
				base === undefined ? undefined : Object.assign({}, base, props[next++]),
			)
		}
		const base = await this.#table.get(keys)
		if (base === undefined) return undefined
		const [props] = await this.#populate([base], include, this.#resolved, this.#table.primary)
		return Object.assign({}, base, props)
	}

	async find(include: Include, options?: FindOptions): Promise<readonly Loaded<T>[]> {
		const query = this.#table.query()
		if (options?.sort !== undefined) {
			if (options.direction === 'descending') query.descending(options.sort)
			else query.ascending(options.sort)
		}
		if (options?.offset !== undefined) query.offset(options.offset)
		if (options?.limit !== undefined) query.limit(options.limit)
		const records = await query.all()
		const props = await this.#populate(records, include, this.#resolved, this.#table.primary)
		return records.map((record, index) => Object.assign({}, record, props[index]))
	}

	async link(key: Key, relation: string, target: Key): Promise<void> {
		const resolved = this.#through(relation)
		await this.#database.table(resolved.through ?? '').set({
			[resolved.source ?? '']: key,
			[resolved.target ?? '']: target,
		})
		// Observe the inserted junction row — AFTER the driver write, so a swallowed listener
		// throw can't perturb the link (carries the owning key + the relation name).
		this.#emitter.emit('link', key, relation)
	}

	async unlink(key: Key, relation: string, target: Key): Promise<void> {
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction
			.query()
			.where(resolved.source ?? '')
			.equals(key)
			.and(resolved.target ?? '')
			.equals(target)
			.all()
		for (const row of rows) {
			const id = extractKey(row, junction.primary)
			if (id !== undefined) await junction.remove(id)
		}
		// Observe the removed junction — AFTER every matching row was deleted.
		this.#emitter.emit('unlink', key, relation)
	}

	async links(key: Key, relation: string): Promise<readonly Key[]> {
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction
			.query()
			.where(resolved.source ?? '')
			.equals(key)
			.all()
		const target = resolved.target ?? ''
		const keys: Key[] = []
		for (const row of rows) {
			const value = extractKey(row, target)
			if (value !== undefined) keys.push(value)
		}
		return keys
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
	): Promise<RelationProps[]> {
		const props: RelationProps[] = records.map(() => ({}))
		for (const [name, sub] of Object.entries(include)) {
			if (sub === false) continue
			const resolved = resolvedMap.get(name)
			if (resolved === undefined) continue
			const values = await this.#load(records, resolved, sub, primary)
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
	): Promise<(Row | readonly Row[] | undefined)[]> {
		switch (resolved.relationship) {
			case 'belongs':
				return this.#loadBelongs(records, resolved, sub)
			case 'many':
				return this.#loadMany(records, resolved, sub, primary)
			case 'one':
				return this.#loadOne(records, resolved, sub, primary)
			case 'through':
				return this.#loadThrough(records, resolved, sub, primary)
			case 'morph':
				return this.#loadMorph(records, resolved, sub, primary)
		}
	}

	async #loadBelongs(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
	): Promise<(Row | undefined)[]> {
		const column = resolved.column ?? ''
		const keys = [
			...new Set(records.map((record) => this.#field(record, column)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => undefined)
		const related = this.#database.table(resolved.model)
		const rows = await related.query().where(related.primary).any(keys).all()
		const index = this.#index(await this.#nest(resolved.model, rows, sub), related.primary)
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
	): Promise<(readonly Row[])[]> {
		const foreign = resolved.key ?? ''
		const keys = [
			...new Set(records.map((record) => this.#field(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = await this.#database.table(resolved.model).query().where(foreign).any(keys).all()
		const groups = this.#group(await this.#nest(resolved.model, rows, sub), foreign)
		return records.map((record) => groups.get(String(this.#field(record, primary))) ?? [])
	}

	async #loadOne(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
	): Promise<(Row | undefined)[]> {
		const groups = await this.#loadMany(records, resolved, sub, primary)
		return groups.map((group) => (group.length > 0 ? group[0] : undefined))
	}

	async #loadThrough(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
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
		const index = this.#index(await this.#nest(resolved.model, rows, sub), related.primary)

		return records.map((record) => {
			const out: Row[] = []
			for (const value of targetsBySource.get(String(this.#field(record, primary))) ?? []) {
				const row = index.get(String(value))
				if (row !== undefined) out.push(row)
			}
			return out
		})
	}

	async #loadMorph(
		records: readonly object[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
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
		const groups = this.#group(await this.#nest(resolved.model, rows, sub), foreign)
		return records.map((record) => groups.get(String(this.#field(record, primary))) ?? [])
	}

	// Recursively load a nested include onto related rows (when `sub` is an Include).
	async #nest(
		model: string,
		rows: readonly Row[],
		sub: boolean | Include,
	): Promise<readonly Row[]> {
		if (typeof sub === 'boolean' || rows.length === 0) return rows
		const context = this.#lookup(model)
		if (context === undefined) return rows
		const props = await this.#populate(rows, sub, context.resolved, context.primary)
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
