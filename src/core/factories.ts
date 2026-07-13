import type { RelationManagerInterface, RelationManagerOptions } from './types.js'
import type { TablesShape } from '@orkestrel/database'
import { RelationManager } from './RelationManager.js'

/**
 * Create a relation manager over a database and its relation definitions.
 *
 * @remarks
 * `relations` maps table names (constrained to the database's tables) to their
 * relation maps; build entries with `belongsTo` / `hasMany` / `hasOne` /
 * `hasThrough` / `hasMorph`. `manager.model(name)` returns the typed model for a
 * table — its own table is fully typed, related rows load at the `Row` type.
 *
 * @param options - The `database` and an optional `relations` map
 * @returns A typed {@link RelationManagerInterface}
 *
 * @example
 * ```ts
 * import { createRelationManager, belongsTo, hasMany } from '@src/core'
 *
 * const manager = createRelationManager({
 * 	database: db,
 * 	relations: {
 * 		accounts: { classification: belongsTo('classificationId', 'classifications'), contacts: hasMany('accountId') },
 * 		contacts: { account: belongsTo('accountId', 'accounts') },
 * 	},
 * })
 * const acme = await manager.model('accounts').load('acc1', { contacts: true, classification: true })
 * ```
 */
export function createRelationManager<T extends TablesShape>(
	options: RelationManagerOptions<T>,
): RelationManagerInterface<T> {
	return new RelationManager(options)
}
