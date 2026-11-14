import type { Guard } from '@orkestrel/contract'
import type { RelationDescriptor } from './types.js'
import { relationDescriptorContract } from './contracts.js'

// === Descriptor guard

/**
 * Narrows a value to a {@link RelationDescriptor} (the object form of a relation).
 *
 * @remarks
 * The guard of the compiled `relationDescriptorContract`: a plain record whose every
 * member is optional, with `relationship` one of the `Relationship` values and `column`,
 * `key`, `through`, `source`, `target`, `tag`, `label`, and `model` strings. A member
 * present with an `undefined` value, a member holding another type, and an enumerable,
 * string-keyed member the descriptor does not declare each refuse it. That is what lets
 * `resolveRelation` read each member after one narrow and report a malformed definition
 * as an `INVALID` `RelationError`.
 *
 * @example
 * ```ts
 * isRelationDescriptor(belongsTo('accountId')) // true
 * isRelationDescriptor({ column: 42 }) // false — `column` is declared a string
 * isRelationDescriptor({ column: 'accountId', comment: 'x' }) // false — `comment` is undeclared
 * ```
 */
export const isRelationDescriptor: Guard<RelationDescriptor> = relationDescriptorContract.is
