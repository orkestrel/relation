import { literalShape, objectShape, optionalShape, stringShape } from '@orkestrel/contract'

/**
 * Declares the object form of a relation as a closed contract shape.
 *
 * @remarks
 * Every member is optional: `relationship` is one of the `Relationship` values, and
 * `column`, `key`, `through`, `source`, `target`, `tag`, `label`, and `model` are strings.
 * The object is closed, so an enumerable, string-keyed member the descriptor does not declare
 * refuses it.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { relationDescriptorShape } from '@orkestrel/relation'
 *
 * createContract(relationDescriptorShape).is({ column: 'accountId', comment: 'x' }) // false
 * ```
 */
export const relationDescriptorShape = objectShape({
	relationship: optionalShape(literalShape(['belongs', 'many', 'one', 'through', 'morph'])),
	column: optionalShape(stringShape()),
	key: optionalShape(stringShape()),
	through: optionalShape(stringShape()),
	source: optionalShape(stringShape()),
	target: optionalShape(stringShape()),
	tag: optionalShape(stringShape()),
	label: optionalShape(stringShape()),
	model: optionalShape(stringShape()),
})
