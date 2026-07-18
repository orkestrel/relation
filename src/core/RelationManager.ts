import type { DatabaseInterface, RowOf, TableInterface, TablesShape } from '@orkestrel/database'
import type {
	ModelInterface,
	RelationContext,
	RelationManagerInterface,
	RelationManagerOptions,
	RelationMap,
	RelationsShape,
	ResolvedRelation,
} from './types.js'
import { resolveRelationMap } from './helpers.js'
import { Model } from './Model.js'

/**
 * The relation registry — resolves a {@link RelationsShape} once at construction
 * and vends a typed {@link ModelInterface} per declared table.
 *
 * @remarks
 * Holds the database both at its precise type (to type each model's own table)
 * and at the broad `DatabaseInterface` (to fetch related tables by runtime name
 * while loading). Relation targets are validated lazily — a relation to a missing
 * table fails when that relation is first loaded.
 */
export class RelationManager<
	T extends TablesShape = TablesShape,
> implements RelationManagerInterface<T> {
	readonly #database: DatabaseInterface<T>
	readonly #broad: DatabaseInterface
	readonly #relations: RelationsShape<T>
	readonly #resolved = new Map<string, ReadonlyMap<string, ResolvedRelation>>()

	constructor(options: RelationManagerOptions<T>) {
		this.#database = options.database
		this.#broad = options.database
		this.#relations = options.relations ?? {}
		for (const [name, map] of Object.entries(this.#relations)) {
			if (map !== undefined) this.#resolved.set(name, resolveRelationMap(map))
		}
	}

	get count(): number {
		return this.#resolved.size
	}

	model<K extends keyof T & string>(name: K): ModelInterface<RowOf<T[K]>> {
		const resolved = this.#resolved.get(name) ?? new Map<string, ResolvedRelation>()
		const relations = this.#relations[name] ?? {}
		return this.#vend(name, this.#database.table(name), resolved, relations)
	}

	models(): readonly string[] {
		return [...this.#resolved.keys()]
	}

	has(name: string): boolean {
		return this.#resolved.has(name)
	}

	// Construct a model over an opaque row type `R`, so `RowOf<T[K]>` is not
	// expanded structurally here (the instantiation-depth guard `db.table` sidesteps).
	#vend<R>(
		name: string,
		table: TableInterface<R>,
		resolved: ReadonlyMap<string, ResolvedRelation>,
		relations: RelationMap,
	): ModelInterface<R> {
		return new Model(name, table, resolved, relations, (model) => this.#context(model), this.#broad)
	}

	// Look up a related model's resolved relations + primary, for nested loading.
	#context(model: string): RelationContext | undefined {
		const resolved = this.#resolved.get(model)
		if (resolved === undefined) return undefined
		return { resolved, primary: this.#broad.table(model).primary }
	}
}
