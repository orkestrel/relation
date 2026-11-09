import type { DatabaseStorageInterface, RowOf, TableInterface, TableMap } from '@orkestrel/database'
import type {
	ModelInterface,
	RelationContext,
	RelationManagerInterface,
	RelationManagerOptions,
	RelationMap,
	RelationsShape,
	ResolvedRelation,
} from './types.js'
import { resolveRelationMap, validateRelationTable } from './helpers.js'
import { Model } from './Model.js'

/**
 * Resolves a {@link RelationsShape} once at construction and vends a typed
 * {@link ModelInterface} per declared table.
 *
 * @remarks
 * Holds storage both at its precise type (to type each model's own table)
 * and at the broad `DatabaseStorageInterface` (to fetch related tables by runtime name
 * while loading). Construction validates every target and junction against the
 * database's declared tables, so invalid definitions fail before an operation runs.
 * The `model` option's `on` and `error` are threaded into every model vended, and
 * each `model(name)` call constructs a handle owning its own emitter, so retain the
 * handle a subscription is taken on.
 *
 * @example
 * ```ts
 * import { RelationManager, hasMany } from '@orkestrel/relation'
 *
 * const manager = new RelationManager<typeof TABLES>({
 * 	storage: database,
 * 	relations: { users: { posts: hasMany('author') } },
 * 	model: { on: { load: (name, count) => metrics.record(`relation.${name}`, count) } },
 * })
 * const users = manager.model('users')
 * const ada = await users.load('u1', { posts: true })
 * ```
 */
export class RelationManager<T extends TableMap = TableMap> implements RelationManagerInterface<T> {
	readonly #storage: DatabaseStorageInterface<T>
	readonly #broad: DatabaseStorageInterface
	readonly #relations: RelationsShape<T>
	readonly #model: RelationManagerOptions['model']
	readonly #resolved = new Map<string, ReadonlyMap<string, ResolvedRelation>>()

	/**
	 * Constructs a registry over storage and its relation definitions.
	 *
	 * @param options - The `storage`, an optional `relations` map, and the optional
	 *   `model` emitter settings threaded into every model vended
	 * @throws An `INVALID` {@link RelationError} when a relation targets a table or a
	 *   junction the database does not declare
	 */
	constructor(options: RelationManagerOptions<T>) {
		this.#storage = options.storage
		this.#broad = options.storage
		this.#relations = options.relations ?? {}
		this.#model = options.model
		for (const [name, map] of Object.entries(this.#relations)) {
			if (map === undefined) continue
			const resolved = resolveRelationMap(map)
			for (const [relation, entry] of resolved) {
				validateRelationTable(this.#broad, name, relation, entry.model)
				if (entry.relationship === 'through') {
					validateRelationTable(this.#broad, name, relation, entry.through, true)
				}
			}
			this.#resolved.set(name, resolved)
		}
	}

	get count(): number {
		return this.#resolved.size
	}

	model<K extends keyof T & string>(name: K): ModelInterface<RowOf<T[K]>> {
		const resolved = this.#resolved.get(name) ?? new Map<string, ResolvedRelation>()
		const relations = this.#relations[name] ?? {}
		return this.#vend(name, this.#storage.table(name), resolved, relations)
	}

	names(): readonly string[] {
		return [...this.#resolved.keys()]
	}

	has(name: string): boolean {
		return this.#resolved.has(name)
	}

	// Construct a model over an opaque row type `R`, so `RowOf<T[K]>` is not
	// expanded structurally here (the instantiation-depth guard `db.table` sidesteps).
	// The `model` option's hooks and error handler reach each vended handle's own emitter.
	#vend<R>(
		name: string,
		table: TableInterface<R>,
		resolved: ReadonlyMap<string, ResolvedRelation>,
		relations: RelationMap,
	): ModelInterface<R> {
		return new Model(
			name,
			table,
			resolved,
			relations,
			(model) => this.#context(model),
			this.#broad,
			this.#model?.on,
			this.#model?.error,
		)
	}

	// Look up a related model's resolved relations + primary, for nested loading.
	#context(model: string): RelationContext | undefined {
		const resolved = this.#resolved.get(model)
		if (resolved === undefined) return undefined
		return { resolved, primary: this.#broad.table(model).primary }
	}
}
