import type { RelationManagerInterface, RelationManagerOptions } from './types.js'
import type { TableMap } from '@orkestrel/database'
import { RelationManager } from './RelationManager.js'

/**
 * Creates a {@link RelationManagerInterface} over a database and its relation map.
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
 * @example Defining relations
 * ```ts
 * import {
 * 	createRelationManager,
 * 	belongsTo,
 * 	hasMany,
 * 	hasOne,
 * 	hasThrough,
 * 	hasMorph,
 * } from '@orkestrel/relation'
 *
 * const manager = createRelationManager({
 * 	database: db,
 * 	relations: {
 * 		accounts: {
 * 			classification: belongsTo('classificationId', 'classifications'), // foreign key on accounts
 * 			contacts: hasMany('accountId'), // foreign key on contacts → accounts
 * 			profile: hasOne('accountId', 'profiles'), // single, foreign key on profiles
 * 			representatives: hasThrough('accountReps', 'accountId', 'repId', 'representatives'), // through a junction
 * 			notes: hasMorph('entityId', 'entityType', 'account', 'notes'), // polymorphic
 * 		},
 * 		contacts: { account: belongsTo('accountId', 'accounts') },
 * 	},
 * })
 *
 * const acme = await manager.model('accounts').load('acc1', { contacts: true, classification: true })
 * ```
 */
export function createRelationManager<T extends TableMap>(
	options: RelationManagerOptions<T>,
): RelationManagerInterface<T> {
	return new RelationManager(options)
}
