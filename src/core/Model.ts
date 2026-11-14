import type {
	DatabaseStorageInterface,
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
	LoadedMap,
	ModelEventMap,
	ModelInterface,
	RelationContext,
	RelationMap,
	ResolvedBelongs,
	ResolvedMany,
	ResolvedMorph,
	ResolvedOne,
	ResolvedRelation,
	ResolvedThrough,
} from './types.js'
import { checkAbort, extractKey, isDatabaseError, isKey } from '@orkestrel/database'
import { Emitter } from '@orkestrel/emitter'
import { isArray, isBoolean, isDefined, renderPath, resolveField } from '@orkestrel/contract'
import { computeLinkKey, countAttached, groupRows, indexRows, readRow } from './helpers.js'
import { RelationError } from './errors.js'

/**
 * Pairs a typed table with relation-aware `load` / `find` and junction management.
 *
 * @remarks
 * The model's own table is fully typed (`table`); related tables are reached by
 * runtime name through the bound storage at the broad `Row` type. Loading is batched:
 * a direct relation uses one query for the whole record set, while a `through`
 * relation uses two (junction then target); both counts remain constant regardless
 * of parent count. Nested includes recurse through the registry `lookup`, so each
 * nested level is batched again. A load by primary key (`belongs`, a `through` target)
 * reads through the table's keyed `get`; a load by foreign key reads through `records`
 * with `any`. Columns are read with `resolveField` and relation properties merged with
 * `Object.assign` — no `as`.
 *
 * @remarks
 * - **Observable.** The owned {@link emitter} ({@link ModelEventMap}) carries the
 *   eager-load + junction moments — `load` (a relation resolved: its name + the count of
 *   related rows attached across the whole record set), `link` / `unlink` (a junction row
 *   written) — for fire-and-forget observers. Every event is emitted directly, strictly
 *   after the load resolves and after the junction operation completes; the emitter
 *   isolates a listener throw and routes it to its `error` handler (the `error` option),
 *   so a buggy observer can never corrupt the batched eager-load (no N+1 in the events
 *   either — one `load` per relation, not per record).
 *
 * @example
 * ```ts
 * import { Model, resolveRelationMap, hasMany } from '@orkestrel/relation'
 *
 * const relations = { posts: hasMany('author') }
 * const users = new Model(
 * 	'users',
 * 	storage.table('users'),
 * 	resolveRelationMap(relations),
 * 	relations,
 * 	() => undefined,
 * 	storage,
 * )
 * users.emitter.on('load', (name, count) => metrics.record(`relation.${name}`, count))
 * const ada = await users.load('u1', { posts: true })
 * ```
 */
export class Model<T = Row> implements ModelInterface<T> {
	readonly #name: string
	readonly #table: TableInterface<T>
	readonly #resolved: ReadonlyMap<string, ResolvedRelation>
	readonly #relations: RelationMap
	readonly #lookup: (model: string) => RelationContext | undefined
	readonly #storage: DatabaseStorageInterface
	// The push observation surface — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into the
	// batched eager-load.
	readonly #emitter: Emitter<ModelEventMap>

	/**
	 * Constructs a model over one table and its resolved relations.
	 *
	 * @param name - The model's table name
	 * @param table - The typed table this model's own reads and writes go through; take it
	 *   from `storage` so both belong to one scope, as `RelationManager` does
	 *   (a root table read inside a transaction refuses with `CONFLICT`)
	 * @param resolved - The model's relations, resolved by `resolveRelationMap`
	 * @param relations - The raw relation map the resolved relations came from
	 * @param lookup - Reads a related model's {@link RelationContext} for a nested include,
	 *   and returns `undefined` for a model the registry does not hold; its contexts must
	 *   resolve through the same `storage`
	 * @param storage - The broad storage used to read related and junction tables by name
	 * @param on - Initial {@link ModelEventMap} listeners
	 * @param error - Receives a listener throw as `(error, event)`. Default: the throw is
	 *   swallowed.
	 */
	constructor(
		name: string,
		table: TableInterface<T>,
		resolved: ReadonlyMap<string, ResolvedRelation>,
		relations: RelationMap,
		lookup: (model: string) => RelationContext | undefined,
		storage: DatabaseStorageInterface,
		on?: EmitterHooks<ModelEventMap>,
		error?: EmitterErrorHandler,
	) {
		this.#name = name
		this.#table = table
		this.#resolved = resolved
		this.#relations = relations
		this.#lookup = lookup
		this.#storage = storage
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
			const bases = (await this.#table.get(keys)).map((base) =>
				base === undefined ? undefined : readRow(this.#table.name, base),
			)
			const present = bases.filter(isDefined)
			const props = await this.#populate(
				present,
				include,
				this.#resolved,
				this.#table.primary,
				options,
			)
			const attachments = props.values()
			return bases.map((base) =>
				base === undefined ? undefined : Object.assign({}, base, attachments.next().value),
			)
		}
		const found = await this.#table.get(keys)
		if (found === undefined) return undefined
		const base = readRow(this.#table.name, found)
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
		const rows = records.map((record) => readRow(this.#table.name, record))
		const props = await this.#populate(rows, include, this.#resolved, this.#table.primary, options)
		return rows.map((row, index) => Object.assign({}, row, props[index]))
	}

	async link(key: Key, relation: string, target: Key, options?: OperationOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#storage.table(resolved.through)
		const id = computeLinkKey(key, target)
		try {
			await junction.add(
				{ [junction.primary]: id, [resolved.source]: key, [resolved.target]: target },
				options,
			)
		} catch (error) {
			// A busy or settled scope raises CONFLICT too, so only a held pair reads as linked.
			if (isDatabaseError(error) && error.code === 'CONFLICT' && (await junction.has(id))) return
			throw error
		}
		this.#emitter.emit('link', key, relation)
	}

	async unlink(key: Key, relation: string, target: Key, options?: OperationOptions): Promise<void> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const removed = await this.#storage
			.table(resolved.through)
			.remove(computeLinkKey(key, target), options)
		if (removed) this.#emitter.emit('unlink', key, relation)
	}

	async links(key: Key, relation: string, options?: OperationOptions): Promise<readonly Key[]> {
		checkAbort(options?.signal)
		const resolved = this.#through(relation)
		const junction = this.#storage.table(resolved.through)
		const rows = await junction.records(
			{
				conditions: [
					{
						column: resolved.source,
						operator: 'equals',
						values: [key],
						connector: 'and',
					},
				],
			},
			options,
		)
		return rows
			.map((row) => extractKey(readRow(junction.name, row), resolved.target))
			.filter(isDefined)
	}

	// === Private

	// Resolve a `through` relation by name to its own arm, or throw a descriptive error.
	#through(relation: string): ResolvedThrough {
		const resolved = this.#resolved.get(relation)
		if (resolved === undefined) {
			throw new RelationError(
				'UNKNOWN_RELATION',
				`Model ${renderPath([this.#name])} has no relation ${renderPath([relation])}; declare it in the model's relation map`,
				{ model: this.#name, relation },
			)
		}
		if (resolved.relationship !== 'through') {
			throw new RelationError(
				'NOT_THROUGH',
				`Relation ${renderPath([this.#name, relation])} is a ${resolved.relationship} relation; link, unlink, and links need a through relation built with hasThrough`,
				{ model: this.#name, relation },
			)
		}
		return resolved
	}

	// Compute the relation properties for each record (parallel to `records`).
	async #populate(
		records: readonly Row[],
		include: Include,
		resolvedMap: ReadonlyMap<string, ResolvedRelation>,
		primary: string,
		options?: OperationOptions,
	): Promise<LoadedMap[]> {
		checkAbort(options?.signal)
		const props: LoadedMap[] = records.map(() => ({}))
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
			// Observe this relation's eager-load — strictly after it resolved + was attached,
			// once per relation (not per record — the batched load has no N+1, nor do its
			// events), carrying the relation name + the count of rows attached across the set.
			this.#emitter.emit('load', resolved.name, countAttached(values))
		}
		return props
	}

	// Dispatch one relation to its loader, returning a value per record.
	async #load(
		records: readonly Row[],
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
		records: readonly Row[],
		resolved: ResolvedBelongs,
		sub: boolean | Include,
		options?: OperationOptions,
	): Promise<Array<Row | undefined>> {
		const column = resolved.column
		const keys = [...new Set(records.map((record) => resolveField(record, column)).filter(isKey))]
		if (keys.length === 0) return records.map(() => undefined)
		const related = this.#storage.table(resolved.model)
		const rows = (await related.get(keys))
			.filter((row) => row !== undefined)
			.map((row) => readRow(related.name, row))
		const index = indexRows(
			rows,
			related.primary,
			await this.#nest(resolved.model, rows, sub, options),
		)
		return records.map((record) => {
			const fk = resolveField(record, column)
			return isKey(fk) ? index.get(String(fk)) : undefined
		})
	}

	async #loadMany(
		records: readonly Row[],
		resolved: ResolvedMany | ResolvedOne,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const foreign = resolved.key
		const keys = [
			...new Set(records.map((record) => resolveField(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = (
			await this.#storage
				.table(resolved.model)
				.records(
					{ conditions: [{ column: foreign, operator: 'any', values: keys, connector: 'and' }] },
					options,
				)
		).map((row) => readRow(resolved.model, row))
		const groups = groupRows(rows, foreign, await this.#nest(resolved.model, rows, sub, options))
		return records.map((record) => groups.get(String(resolveField(record, primary))) ?? [])
	}

	async #loadOne(
		records: readonly Row[],
		resolved: ResolvedOne,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<Row | undefined>> {
		const groups = await this.#loadMany(records, resolved, sub, primary, options)
		return groups.map((group) => (group.length > 0 ? group[0] : undefined))
	}

	async #loadThrough(
		records: readonly Row[],
		resolved: ResolvedThrough,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const source = resolved.source
		const target = resolved.target
		const parents = [
			...new Set(records.map((record) => resolveField(record, primary)).filter(isDefined)),
		]
		if (parents.length === 0) return records.map(() => [])

		const junctions = (
			await this.#storage
				.table(resolved.through)
				.records(
					{ conditions: [{ column: source, operator: 'any', values: parents, connector: 'and' }] },
					options,
				)
		).map((junction) => readRow(resolved.through, junction))
		const targets = [
			...new Set(junctions.map((junction) => resolveField(junction, target)).filter(isKey)),
		]
		if (targets.length === 0) return records.map(() => [])
		checkAbort(options?.signal)
		const related = this.#storage.table(resolved.model)
		const rows = (await related.get(targets))
			.filter((row) => row !== undefined)
			.map((row) => readRow(related.name, row))
		const index = indexRows(
			rows,
			related.primary,
			await this.#nest(resolved.model, rows, sub, options),
		)
		const groups = groupRows(junctions, source)
		return records.map((record) =>
			(groups.get(String(resolveField(record, primary))) ?? [])
				.map((junction) => resolveField(junction, target))
				.filter(isKey)
				.map((value) => index.get(String(value)))
				.filter(isDefined),
		)
	}

	async #loadMorph(
		records: readonly Row[],
		resolved: ResolvedMorph,
		sub: boolean | Include,
		primary: string,
		options?: OperationOptions,
	): Promise<Array<readonly Row[]>> {
		const foreign = resolved.key
		const keys = [
			...new Set(records.map((record) => resolveField(record, primary)).filter(isDefined)),
		]
		if (keys.length === 0) return records.map(() => [])
		const rows = (
			await this.#storage.table(resolved.model).records(
				{
					conditions: [
						{ column: foreign, operator: 'any', values: keys, connector: 'and' },
						{
							column: resolved.tag,
							operator: 'equals',
							values: [resolved.label],
							connector: 'and',
						},
					],
				},
				options,
			)
		).map((row) => readRow(resolved.model, row))
		const groups = groupRows(rows, foreign, await this.#nest(resolved.model, rows, sub, options))
		return records.map((record) => groups.get(String(resolveField(record, primary))) ?? [])
	}

	// Recursively load a nested include onto related rows (when `sub` is an Include).
	async #nest(
		model: string,
		rows: readonly Row[],
		sub: boolean | Include,
		options?: OperationOptions,
	): Promise<readonly Row[]> {
		if (isBoolean(sub) || rows.length === 0) return rows
		const context = this.#lookup(model)
		if (context === undefined) return rows
		const props = await this.#populate(rows, sub, context.resolved, context.primary, options)
		return rows.map((row, index) => Object.assign({}, row, props[index]))
	}
}
