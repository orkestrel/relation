import type { RelationDescriptor } from './types.js'
import { isRecord } from '@orkestrel/contract'

// === Descriptor guard

/**
 * Narrows a value to a {@link RelationDescriptor} (the object form of a relation).
 *
 * @param value - The value to test
 * @returns True if `value` is a plain record; false otherwise
 */
export function isRelationDescriptor(value: unknown): value is RelationDescriptor {
	return isRecord(value)
}
