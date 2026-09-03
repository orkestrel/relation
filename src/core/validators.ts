import type { RelationDescriptor } from './types.js'
import { isRecord, isString } from '@orkestrel/contract'

// === Descriptor guard

/**
 * Narrows a value to a {@link RelationDescriptor} (the object form of a relation).
 *
 * @remarks
 * A record satisfies the descriptor when every member it declares carries its declared
 * type: `relationship` is one of the `Relationship` values, and `column`, `key`,
 * `through`, `source`, `target`, `tag`, `label`, and `model` are strings. A member the
 * record omits is unconstrained, a member present with an `undefined` value is refused,
 * and a member the descriptor does not declare is carried without being checked. This
 * is what lets `resolveRelation` read each member after one narrow and report a
 * malformed definition as an `INVALID` `RelationError` instead of resolving a
 * wrong-typed column into an arm that declares it a string.
 *
 * @param value - The value to test
 * @returns True if `value` is a record whose every declared member holds its declared
 *   type; false otherwise
 *
 * @example
 * ```ts
 * isRelationDescriptor(belongsTo('accountId')) // true
 * isRelationDescriptor({ column: 42 }) // false — `column` is declared a string
 * ```
 */
export function isRelationDescriptor(value: unknown): value is RelationDescriptor {
	if (!isRecord(value)) return false
	if (
		'relationship' in value &&
		value.relationship !== 'belongs' &&
		value.relationship !== 'many' &&
		value.relationship !== 'one' &&
		value.relationship !== 'through' &&
		value.relationship !== 'morph'
	) {
		return false
	}
	for (const member of ['column', 'key', 'through', 'source', 'target', 'tag', 'label', 'model']) {
		if (member in value && !isString(value[member])) return false
	}
	return true
}
