import type { RelationErrorCode } from './types.js'
import { holds, INTRINSICS, isFunction, isInstance, isObject, literalOf } from '@orkestrel/contract'

// Invalid relation definitions and misuse `throw` a `RelationError` carrying a
// machine-readable `code`, so a `catch` branches on `error.code`
// (`.claude/rules/typescript.md` § Errors and outcomes).

/**
 * Represents an error thrown by the relations layer, carrying a machine-readable
 * {@link RelationErrorCode}.
 *
 * @remarks
 * Thrown for: a relation value whose relationship cannot be inferred (`INVALID`), a
 * relation targeting a table or junction the database does not declare, raised when
 * the manager is created (`INVALID`), a junction keyed by its relation's `source` or
 * `target` column (`INVALID`), a row a storage returns that is not a plain record
 * (`INVALID`), a reference to a relation a model does not
 * define (`UNKNOWN_RELATION`), and `link` / `unlink` / `links` on a relation that is
 * not a `through` (`NOT_THROUGH`).
 */
export class RelationError extends Error {
	readonly code: RelationErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(
		code: RelationErrorCode,
		message: string,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		INTRINSICS.define(this, Symbol.for('@orkestrel/relation.RelationError'), { value: this })
		this.name = 'RelationError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link RelationError}.
 *
 * @remarks
 * Accepts branded instances and subclasses across package copies and module formats.
 * Requires a declared {@link RelationErrorCode} and a `context` that is absent, an object,
 * or a callable object. Refuses look-alikes, transparent proxies, and plain branded objects
 * without requiring an exact `name`.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link RelationError}; false otherwise
 *
 * @example
 * ```ts
 * try {
 * 	resolveRelation('ghost', {})
 * } catch (error) {
 * 	if (isRelationError(error) && error.code === 'INVALID') report(error.message)
 * }
 * ```
 */
export function isRelationError(value: unknown): value is RelationError {
	return holds(() => {
		const intrinsic = INTRINSICS.error
		if (!isInstance(value, intrinsic) || INTRINSICS.prototype(value) === intrinsic.prototype)
			return false
		const brand = INTRINSICS.describe(value, Symbol.for('@orkestrel/relation.RelationError'))
		if (brand === undefined || brand.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (!literalOf('INVALID', 'UNKNOWN_RELATION', 'NOT_THROUGH')(code)) return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return context === undefined || isObject(context) || isFunction(context)
	})
}
