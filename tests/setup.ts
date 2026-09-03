// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`).

import type { DriverInterface, Key, OperationOptions, Row, TableSchema } from '@orkestrel/database'
import type { RelationsShape } from '@src/core'
import { integerShape, stringShape } from '@orkestrel/contract'
import { hasMany } from '@src/core'

// ── Relation test fixtures ────────────────────────────────────────────────────
// Shared, environment-agnostic scenario builders for the `relation` module's tests —
// a `users` / `posts` schema (matching the database module's own integration
// fixtures) with a `users` → `posts` `many` relation.

/** The shared `users` / `posts` shape maps for the cross-suite integration tests. */
export const INTEGRATION_TABLES = {
	users: { id: stringShape(), name: stringShape(), age: integerShape() },
	posts: { id: stringShape(), author: stringShape(), title: stringShape() },
} as const

/** The shared relation map over {@link INTEGRATION_TABLES} — `users` has many `posts`. */
export const INTEGRATION_RELATIONS: RelationsShape<typeof INTEGRATION_TABLES> = {
	users: { posts: hasMany('author') },
}

// ── Driver fault fixtures ─────────────────────────────────────────────────────

/** A real driver boundary that injects one configured delete failure. */
export class FaultDriver implements DriverInterface {
	readonly #driver: DriverInterface
	readonly #after: number
	#calls = 0

	constructor(driver: DriverInterface, after: number) {
		this.#driver = driver
		this.#after = after
	}

	open(schema: readonly TableSchema[]): Promise<void> {
		return this.#driver.open(schema)
	}

	close(): Promise<void> {
		return this.#driver.close()
	}

	read(table: string, key: Key): Promise<Row | undefined> {
		return this.#driver.read(table, key)
	}

	write(table: string, key: Key, row: Row, options?: OperationOptions): Promise<void> {
		return this.#driver.write(table, key, row, options)
	}

	insert(table: string, key: Key, row: Row, options?: OperationOptions): Promise<void> {
		return this.#driver.insert(table, key, row, options)
	}

	delete(table: string, key: Key, options?: OperationOptions): Promise<boolean> {
		this.#calls += 1
		if (this.#calls >= this.#after) throw new Error('FaultDriver delete failure')
		return this.#driver.delete(table, key, options)
	}

	keys(table: string): Promise<readonly Key[]> {
		return this.#driver.keys(table)
	}

	scan(table: string): AsyncIterable<Row> {
		return this.#driver.scan(table)
	}

	clear(table: string): Promise<void> {
		return this.#driver.clear(table)
	}

	snapshot(tables?: readonly string[]): Promise<() => Promise<void>> {
		return this.#driver.snapshot(tables)
	}
}
