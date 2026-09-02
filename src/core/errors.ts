import type { RelationErrorCode } from './types.js'

// AGENTS §12: invalid relation definitions and misuse `throw` a `RelationError`
// carrying a machine-readable `code`, so a `catch` branches on `error.code`.

/**
 * Represents an error thrown by the relations layer.
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
		this.name = 'RelationError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link RelationError}.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link RelationError}; false otherwise
 */
export function isRelationError(value: unknown): value is RelationError {
	return value instanceof RelationError
}
