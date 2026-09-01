import type {
	Relation,
	RelationDescriptor,
	RelationMap,
	Relationship,
	ResolvedRelation,
} from './types.js'
import type { Row } from '@orkestrel/database'
import { isArray, isDefined, isString } from '@orkestrel/contract'
import { isRelationDescriptor } from './validators.js'
import { RelationError } from './errors.js'

// Resolve raw relation values into the flat `ResolvedRelation` form once, at
// define-time, so no inference runs during loading. The builders below set an
// explicit `relationship`; hand-written descriptors fall back to field inference.

// === Resolution

/**
 * Resolve one raw {@link Relation} value into a flat {@link ResolvedRelation}.
 *
 * @remarks
 * A `string` is a `belongs` (FK column on this table); a `readonly string[]` is a
 * `many` (FK column on the related table); a {@link RelationDescriptor} uses its
 * explicit `relationship`, or infers it from the fields present. The target model
 * defaults to the relation name. Throws `INVALID` when the relationship cannot be
 * resolved or a required field is missing.
 *
 * @param name - The relation name (its key in the {@link RelationMap})
 * @param value - The raw relation value
 * @returns The resolved relation
 */
export function resolveRelation(name: string, value: Relation): ResolvedRelation {
	if (isString(value)) {
		return { relationship: 'belongs', name, model: name, column: value }
	}
	if (isArray(value)) {
		const key = value[0]
		if (!isString(key)) {
			throw new RelationError(
				'INVALID',
				`Relation '${name}': array form needs a string FK column`,
				{
					relation: name,
				},
			)
		}
		return { relationship: 'many', name, model: name, key }
	}
	if (!isRelationDescriptor(value)) {
		throw new RelationError('INVALID', `Relation '${name}': not a string, array, or descriptor`, {
			relation: name,
		})
	}

	const model = value.model ?? name
	// Inferred from the fields present when no explicit `relationship` is set.
	let relationship: Relationship
	if (value.relationship !== undefined) {
		relationship = value.relationship
	} else if (isDefined(value.through)) {
		relationship = 'through'
	} else if (isDefined(value.tag)) {
		relationship = 'morph'
	} else if (isDefined(value.column)) {
		relationship = 'belongs'
	} else if (isDefined(value.key)) {
		relationship = 'one'
	} else {
		throw new RelationError(
			'INVALID',
			`Relation '${name}': cannot infer relationship from descriptor`,
			{ relation: name },
		)
	}

	switch (relationship) {
		case 'belongs': {
			const column = value.column
			if (column === undefined) {
				throw new RelationError('INVALID', `Relation '${name}': belongs needs 'column'`, {
					relation: name,
				})
			}
			return { relationship, name, model, column }
		}
		case 'many': {
			const key = value.key
			if (key === undefined) {
				throw new RelationError('INVALID', `Relation '${name}': many needs 'key'`, {
					relation: name,
				})
			}
			return { relationship, name, model, key }
		}
		case 'one': {
			const key = value.key
			if (key === undefined) {
				throw new RelationError('INVALID', `Relation '${name}': one needs 'key'`, {
					relation: name,
				})
			}
			return { relationship, name, model, key }
		}
		case 'through': {
			const { through, source, target } = value
			if (through === undefined || source === undefined || target === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation '${name}': through needs 'through', 'source', and 'target'`,
					{ relation: name },
				)
			}
			return {
				relationship,
				name,
				model,
				through,
				source,
				target,
			}
		}
		case 'morph': {
			const { key, tag, label } = value
			if (key === undefined || tag === undefined || label === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation '${name}': morph needs 'key', 'tag', and 'label'`,
					{ relation: name },
				)
			}
			return { relationship, name, model, key, tag, label }
		}
	}
}

/**
 * Resolve every entry of a {@link RelationMap} into a name → {@link ResolvedRelation} map.
 *
 * @param relations - The raw relation map
 * @returns A map keyed by relation name
 */
export function resolveRelationMap(relations: RelationMap): ReadonlyMap<string, ResolvedRelation> {
	const resolved = new Map<string, ResolvedRelation>()
	for (const [name, value] of Object.entries(relations)) {
		resolved.set(name, resolveRelation(name, value))
	}
	return resolved
}

// === Row projection

/**
 * Reads one column off any record.
 *
 * @remarks
 * A base row's type is closed, so the column is read with `Reflect.get` rather than
 * index access. Anything that is not an object reads as `undefined`.
 *
 * @param record - The record to read
 * @param column - The column name
 * @returns The column's value, or `undefined` when `record` is not an object
 *
 * @example
 * ```ts
 * readColumn({ accountId: 'acc1' }, 'accountId') // 'acc1'
 * ```
 */
export function readColumn(record: unknown, column: string): unknown {
	if (typeof record !== 'object' || record === null) return undefined
	return Reflect.get(record, column)
}

/**
 * Counts the related rows one relation attached across a record set.
 *
 * @remarks
 * An array-valued relation (`many` / `through` / `morph`) sums its lengths; a
 * single-valued one (`belongs` / `one`) counts each present row. This is the count a
 * `Model` carries on its `load` event.
 *
 * @param values - One relation's loaded value per record
 * @returns The total related rows attached across the set
 *
 * @example
 * ```ts
 * countAttached([[{ id: 'p1' }, { id: 'p2' }], undefined, { id: 'p3' }]) // 3
 * ```
 */
export function countAttached(values: ReadonlyArray<Row | readonly Row[] | undefined>): number {
	let total = 0
	for (const value of values) {
		if (isArray(value)) total += value.length
		else if (value !== undefined) total += 1
	}
	return total
}

// === Builders

/**
 * Build a `belongs` relation — a foreign key on THIS table points at the related row.
 *
 * @param column - The FK column on this table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { classification: belongsTo('classificationId', 'classifications') }
 * ```
 */
export function belongsTo(column: string, model?: string): RelationDescriptor {
	return { relationship: 'belongs', column, ...(model !== undefined ? { model } : {}) }
}

/**
 * Build a `many` relation — a foreign key on the RELATED table points back here.
 *
 * @param key - The FK column on the related table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 */
export function hasMany(key: string, model?: string): RelationDescriptor {
	return { relationship: 'many', key, ...(model !== undefined ? { model } : {}) }
}

/**
 * Build a `one` relation — like {@link hasMany}, but a single related row.
 *
 * @param key - The FK column on the related table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 */
export function hasOne(key: string, model?: string): RelationDescriptor {
	return { relationship: 'one', key, ...(model !== undefined ? { model } : {}) }
}

/**
 * Build a `through` relation — a junction table links the two sides (many-to-many).
 *
 * @param through - The junction table name
 * @param source - The junction FK column pointing at THIS model
 * @param target - The junction FK column pointing at the related model
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { reps: hasThrough('accountReps', 'accountId', 'repId', 'reps') }
 * ```
 */
export function hasThrough(
	through: string,
	source: string,
	target: string,
	model?: string,
): RelationDescriptor {
	return {
		relationship: 'through',
		through,
		source,
		target,
		...(model !== undefined ? { model } : {}),
	}
}

/**
 * Build a `morph` relation — a polymorphic FK plus a discriminator on the RELATED table.
 *
 * @param key - The FK column on the related table
 * @param tag - The discriminator column on the related table
 * @param label - The discriminator value identifying THIS model
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { notes: hasMorph('entityId', 'entityType', 'account', 'notes') }
 * ```
 */
export function hasMorph(
	key: string,
	tag: string,
	label: string,
	model?: string,
): RelationDescriptor {
	return { relationship: 'morph', key, tag, label, ...(model !== undefined ? { model } : {}) }
}
