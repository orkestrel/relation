import type { RelationDescriptor } from './types.js'
import { isRecord } from '@orkestrel/contract'

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
