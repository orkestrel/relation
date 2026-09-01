import type {
	DatabaseInterface,
	Key,
	OperationOptions,
	Row,
	TableInterface,
} from '@orkestrel/database'
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
import { countAttached, readColumn } from './helpers.js'
import { RelationError } from './errors.js'

/**
 * A model — a typed table paired with relation-aware loading.
 *
 * @remarks
 * The model's own table is fully typed (`table`); related tables are reached by
 * runtime name through the database at the broad `Row` type. Loading is batched:
 * a direct relation uses one query for the whole record set, while a `through`
 * relation uses two (junction then target); both counts remain constant regardless
 * of parent count. Nested includes recurse through the registry `lookup`, so each
 * nested level is batched again. Columns are read with `Reflect.get` (the base row's
 * type is closed) and relation properties merged with `Object.assign` — no `as`.
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
export class Model<T = Row> implements ModelInterface<T> {
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
		this.#emitter = new Emitter<ModelEventMap>({
			...(on !== undefined ? { on } : {}),
			...(error !== undefined ? { error } : {}),
		})
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

	load(key: Key, include: Include, options?: OperationOptions): Promise<Loaded<T> | undefined>
	load(
		keys: readonly Key[],
		include: Include,
		options?: OperationOptions,
	): Promise<ReadonlyArray<Loaded<T> | undefined>>
	async load(
		keys: Key | readonly Key[],
		include: Include,
		options?: OperationOptions,
	): Promise<(Loaded<T> | undefined) | ReadonlyArray<Loaded<T> | undefined>> {
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
				options,
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
			options,
		)
		return Object.assign({}, base, props)
	}

	async find(include: Include, options?: FindOptions): Promise<ReadonlyArray<Loaded<T>>> {
		checkAbort(options?.signal)
		const records = await this.#table.records(
			{
				...(options?.sort !== undefined
					? {
							order: [
								{
									column: options.sort,
									direction: options.direction ?? 'ascending',
								},
							],
						}
					: {}),
				...(options?.offset !== undefined ? { offset: options.offset } : {}),
				...(options?.limit !== undefined ? { limit: options.limit } : {}),
			},
			options,
		)
		const props = await this.#populate(
			records,
			include,
			this.#resolved,
			this.#table.primary,
			options,
		)
		return records.map((record, index) => Object.assign({}, record, props[index]))
	}

	async link(key: Key, relation: string, target: Key, options?: OperationOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const source = resolved.source ?? ''
		const column = resolved.target ?? ''
		const junction = this.#database.table(resolved.through ?? '')
		const existing = await junction.count(
			{
				conditions: [
					{ column: source, operator: 'equals', values: [key], connector: 'and' },
					{ column, operator: 'equals', values: [target], connector: 'and' },
				],
			},
			options,
		)
		if (existing > 0) return
		await junction.set({ [source]: key, [column]: target }, options)
		// Observe the inserted junction row — AFTER the driver write, so a swallowed listener
		// throw can't perturb the link (carries the owning key + the relation name).
		this.#emitter.emit('link', key, relation)
	}

	async unlink(key: Key, relation: string, target: Key, options?: OperationOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction.records(
			{
				conditions: [
					{
						column: resolved.source ?? '',
						operator: 'equals',
						values: [key],
						connector: 'and',
					},
					{
						column: resolved.target ?? '',
						operator: 'equals',
						values: [target],
						connector: 'and',
					},
				],
			},
			options,
		)
		await this.#database.transaction(async (transaction) => {
			const scoped = transaction.table(resolved.through ?? '')
			for (const row of rows) {
				const id = extractKey(row, junction.primary)
				if (id !== undefined) await scoped.remove(id, options)
			}
		}, options)
		// Observe the removal only after the transaction commits.
		this.#emitter.emit('unlink', key, relation)
	}

	async links(key: Key, relation: string, options?: OperationOptions): Promise<readonly Key[]> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#database.table(resolved.through ?? '')
		const rows = await junction.records(
			{
				conditions: [
					{
						column: resolved.source ?? '',
						operator: 'equals',
						values: [key],
						connector: 'and',
					},
				],
			},
			options,
		)
		const target = resolved.target ?? ''
		const keys: Key[] = []
		for (const row of rows) {
			const value = extractKey(row, target)
			if (value !== undefined) keys.push(value)
		}
		return keys
	}

	// === Private

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
		records: readonly unknown[],
		include: Include,
		resolvedMap: ReadonlyMap<string, ResolvedRelation>,
		primary: string,
		options?: OperationOptions,
	): Promise<RelationProps[]> {
		checkAbort(options?.signal)
		const props: RelationProps[] = records.map(() => ({}))
		for (const [name, sub] of Object.entries(include)) {
			if (sub === false) continue
			checkAbort(options?.signal)
			const resolved = resolvedMap.get(name)
			if (resolved === undefined) continue
			const values = await this.#load(records, resolved, sub, primary, options)
			values.forEach((value, index) => {
				const target = props[index]
				if (target !== undefined) target[resolved.name] = value
			})
			// Observe this relation's eager-load — AFTER it resolved + was attached, ONCE per
			// relation (not per record — the batched load has no N+1, nor do its events),
			// carrying the relation name + the total related rows attached across the set.
			this.#emitter.emit('load', resolved.name, countAttached(values))
		}
		return props
	}

	// Dispatch one relation to its loader, returning a value per record.
	async #load(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<Row | readonly Row[] | undefined>> {
		switch (resolved.relationship) {
			case 'belongs':
				return this.#loadBelongs(records, resolved, sub, options)
			case 'many':
				return this.#loadMany(records, resolved, sub, primary, options)
			case 'one':
				return this.#loadOne(records, resolved, sub, primary, options)
			case 'through':
				return this.#loadThrough(records, resolved, sub, primary, options)
			case 'morph':
				return this.#loadMorph(records, resolved, sub, primary, options)
		}
	}

	async #loadBelongs(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		options?: OperationOptions,
	): Promise<Array<Row | undefined>> {
		const column = resolved.column ?? ''
		const keys = [...new Set(records.map((record) => readColumn(record, column)).filter(isDefined))]
		if (keys.length === 0) return records.map(() => undefined)
		const related = this.#database.table(resolved.model)
		const rows = await related.records(
			{
				conditions: [
					{
						column: related.primary,
						operator: 'any',
						values: keys,
						connector: 'and',
					},
				],
			},
			options,
		)
		const index = this.#index(await this.#nest(resolved.model, rows, sub, options), related.primary)
		return records.map((record) => {
			const fk = readColumn(record, column)
			return isDefined(fk) ? index.get(String(fk)) : undefined
		})
	}

	async #loadMany(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const foreign = resolved.key ?? ''
		const keys = [
			...new Set(records.map((record) => readColumn(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = await this.#database.table(resolved.model).records(
			{
				conditions: [{ column: foreign, operator: 'any', values: keys, connector: 'and' }],
			},
			options,
		)
		const groups = this.#group(await this.#nest(resolved.model, rows, sub, options), foreign)
		return records.map((record) => groups.get(String(readColumn(record, primary))) ?? [])
	}

	async #loadOne(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<Row | undefined>> {
		const groups = await this.#loadMany(records, resolved, sub, primary, options)
		return groups.map((group) => (group.length > 0 ? group[0] : undefined))
	}

	async #loadThrough(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const source = resolved.source ?? ''
		const target = resolved.target ?? ''
		const parents = [
			...new Set(records.map((record) => readColumn(record, primary)).filter(isDefined)),
		]
		if (parents.length === 0) return records.map(() => [])

		const junctions = await this.#database.table(resolved.through ?? '').records(
			{
				conditions: [{ column: source, operator: 'any', values: parents, connector: 'and' }],
			},
			options,
		)
		const targetsBySource = new Map<string, unknown[]>()
		for (const junction of junctions) {
			const value = readColumn(junction, target)
			if (!isDefined(value)) continue
			const owner = String(readColumn(junction, source))
			const list = targetsBySource.get(owner)
			if (list !== undefined) list.push(value)
			else targetsBySource.set(owner, [value])
		}

		const targets = [...new Set([...targetsBySource.values()].flat())]
		if (targets.length === 0) return records.map(() => [])
		const related = this.#database.table(resolved.model)
		const rows = await related.records(
			{
				conditions: [
					{
						column: related.primary,
						operator: 'any',
						values: targets,
						connector: 'and',
					},
				],
			},
			options,
		)
		const index = this.#index(await this.#nest(resolved.model, rows, sub, options), related.primary)

		return records.map((record) => {
			const out: Row[] = []
			for (const value of targetsBySource.get(String(readColumn(record, primary))) ?? []) {
				const row = index.get(String(value))
				if (row !== undefined) out.push(row)
			}
			return out
		})
	}

	async #loadMorph(
		records: readonly unknown[],
		resolved: ResolvedRelation,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const foreign = resolved.key ?? ''
		const keys = [
			...new Set(records.map((record) => readColumn(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = await this.#database.table(resolved.model).records(
			{
				conditions: [
					{ column: foreign, operator: 'any', values: keys, connector: 'and' },
					{
						column: resolved.tag ?? '',
						operator: 'equals',
						values: [resolved.label ?? ''],
						connector: 'and',
					},
				],
			},
			options,
		)
		const groups = this.#group(await this.#nest(resolved.model, rows, sub, options), foreign)
		return records.map((record) => groups.get(String(readColumn(record, primary))) ?? [])
	}

	// Recursively load a nested include onto related rows (when `sub` is an Include).
	async #nest(
		model: string,
		rows: readonly Row[],
		sub: boolean | Include,
		options?: OperationOptions,
	): Promise<readonly Row[]> {
		if (typeof sub === 'boolean' || rows.length === 0) return rows
		const context = this.#lookup(model)
		if (context === undefined) return rows
		const props = await this.#populate(rows, sub, context.resolved, context.primary, options)
		return rows.map((row, index) => Object.assign({}, row, props[index]))
	}

	// Index rows by the string form of a column (for one-to-one key lookups).
	#index(rows: readonly Row[], column: string): Map<string, Row> {
		const map = new Map<string, Row>()
		for (const row of rows) map.set(String(readColumn(row, column)), row)
		return map
	}

	// Group rows by the string form of a column (for one-to-many lookups).
	#group(rows: readonly Row[], column: string): Map<string, Row[]> {
		const map = new Map<string, Row[]>()
		for (const row of rows) {
			const key = String(readColumn(row, column))
			const group = map.get(key)
			if (group !== undefined) group.push(row)
			else map.set(key, [row])
		}
		return map
	}
}
