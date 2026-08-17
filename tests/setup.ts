// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`).

import type { EmitterInterface, EventMap } from '@orkestrel/emitter'
import type { RecorderInterface } from '@orkestrel/test'
import { createRecorder } from '@orkestrel/test'
import { integerShape, stringShape } from '@orkestrel/contract'
import type { DriverInterface, Key, OperationOptions, Row, TableSchema } from '@orkestrel/database'
import type { RelationsShape } from '@src/core'
import { hasMany } from '@src/core'

// ── Emitter event recording ───────────────────────────────────────────────────

/** A {@link createRecorder} per listed event of an `EmitterInterface`, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: RecorderInterface<TMap[K]>
}

/**
 * Wire one {@link createRecorder} onto `emitter` for each of the named events — the
 * one generic form of the per-entity `recordXEvents` bundles (AGENTS §16.1). Each
 * recorder subscribes via `emitter.on(name, recorder.handler)` and is returned keyed
 * by its event name, typed with that event's argument tuple — so a test asserts what
 * fired (`events.load.calls`) and with which payload.
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names to record (inferred from `events`)
 * @param emitter - The emitter to subscribe the recorders to
 * @param events - The event names to record (each becomes a key of the result)
 * @returns A recorder per name, each subscribed and keyed by event name
 */
export function recordEmitterEvents<TMap extends EventMap, TName extends keyof TMap>(
	emitter: EmitterInterface<TMap>,
	events: readonly TName[],
): EmitterRecorders<TMap, TName> {
	// Accumulate into a `Partial` of the exact mapped shape — every value keeps its
	// precise per-event tuple type, all keys optional until assigned. Once every
	// listed name is present we narrow `Partial` → total through a guard (§14).
	const recorders: Partial<EmitterRecorders<TMap, TName>> = {}
	for (const name of events) {
		const recorder = createRecorder<TMap[typeof name]>()
		emitter.on(name, recorder.handler)
		recorders[name] = recorder
	}
	if (!isTotal(recorders, events)) {
		throw new Error('recordEmitterEvents: a recorder was not wired for every event')
	}
	return recorders
}

/**
 * Narrow an accumulated `Partial<EmitterRecorders>` to its total mapped form once every
 * listed event has a recorder present — the §14 guard standing in for an assertion in
 * {@link recordEmitterEvents}.
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names that must each have a recorder
 * @param recorders - The partially-accumulated recorder map to narrow
 * @param events - The event names that must all be present for the map to be total
 * @returns Whether every listed event has a recorder (narrowing `recorders` to total)
 */
export function isTotal<TMap extends EventMap, TName extends keyof TMap>(
	recorders: Partial<EmitterRecorders<TMap, TName>>,
	events: readonly TName[],
): recorders is EmitterRecorders<TMap, TName> {
	return events.every((name) => recorders[name] !== undefined)
}

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

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
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
