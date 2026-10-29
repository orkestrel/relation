import type { RelationErrorCode } from './types.js'
import { holds, INTRINSICS, isObject } from '@orkestrel/contract'

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
 * the manager is created (`INVALID`), a reference to a relation a model does not
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
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if the error carries its own identity brand and declared members; false otherwise
 */
export function isRelationError(value: unknown): value is RelationError {
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		const brand = INTRINSICS.describe(value, Symbol.for('@orkestrel/relation.RelationError'))
		if (brand?.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (code !== 'INVALID' && code !== 'UNKNOWN_RELATION' && code !== 'NOT_THROUGH') return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return context === undefined || isObject(context)
	})
}
