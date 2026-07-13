import type {
	Relation,
	RelationDescriptor,
	RelationMap,
	Relationship,
	ResolvedRelation,
} from './types.js'
import { isArray, isDefined, isRecord, isString } from '../contracts/index.js'
import { RelationError } from './errors.js'

// Resolve raw relation values into the flat `ResolvedRelation` form once, at
// define-time, so no inference runs during loading. The builders below set an
// explicit `relationship`; hand-written descriptors fall back to field inference.

// === Descriptor guard

/**
 * Narrow a value to a {@link RelationDescriptor} (the object form of a relation).
 *
 * @param value - The value to test
 * @returns `true` when `value` is a plain record
 */
export function isRelationDescriptor(value: unknown): value is RelationDescriptor {
	return isRecord(value)
}

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
	const infer = (): Relationship => {
		if (isDefined(value.through)) return 'through'
		if (isDefined(value.tag)) return 'morph'
		if (isDefined(value.column)) return 'belongs'
		if (isDefined(value.key)) return 'one'
		throw new RelationError(
			'INVALID',
			`Relation '${name}': cannot infer relationship from descriptor`,
			{ relation: name },
		)
	}
	const relationship = value.relationship ?? infer()
	const require = (present: boolean, fields: string): void => {
		if (!present) {
			throw new RelationError('INVALID', `Relation '${name}': ${relationship} needs ${fields}`, {
				relation: name,
			})
		}
	}

	switch (relationship) {
		case 'belongs':
			require(isDefined(value.column), `'column'`)
			return { relationship, name, model, column: value.column }
		case 'many':
			require(isDefined(value.key), `'key'`)
			return { relationship, name, model, key: value.key }
		case 'one':
			require(isDefined(value.key), `'key'`)
			return { relationship, name, model, key: value.key }
		case 'through':
			require(isDefined(value.through) &&
				isDefined(value.source) &&
				isDefined(value.target), `'through', 'source', and 'target'`)
			return {
				relationship,
				name,
				model,
				through: value.through,
				source: value.source,
				target: value.target,
			}
		case 'morph':
			require(isDefined(value.key) &&
				isDefined(value.tag) &&
				isDefined(value.label), `'key', 'tag', and 'label'`)
			return { relationship, name, model, key: value.key, tag: value.tag, label: value.label }
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
