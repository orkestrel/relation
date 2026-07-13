// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`).

import type { EmitterInterface, EventMap } from '@orkestrel/emitter'
import type { DriverInterface } from '@orkestrel/database'
import { integerShape, stringShape } from '@orkestrel/contract'
import type { RelationsShape } from '@src/core'
import { hasMany } from '@src/core'

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

// ── Emitter event recording ───────────────────────────────────────────────────

/** A {@link createRecorder} per listed event of an `EmitterInterface`, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: TestRecorderInterface<TMap[K]>
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

// ── Faulty driver wrapper ─────────────────────────────────────────────────────
// AGENTS §16.1: a real (delegating) driver, not a mock of behavior — every method
// forwards to `driver` except `delete`, which throws once the call count named by
// `after` is reached, for testing mid-loop/mid-transaction fault handling.

/**
 * Wrap a real `DriverInterface` so its `delete` throws starting from the
 * `after`-th call (1-indexed) — for proving atomicity when a multi-row removal
 * faults partway through.
 *
 * @param driver - The real driver to delegate every other method to
 * @param after - The 1-indexed call number of `delete` that starts throwing
 * @returns A `DriverInterface` identical to `driver` except a failing `delete`
 */
export function createFaultyDriver(driver: DriverInterface, after: number): DriverInterface {
	let calls = 0
	return {
		open: (schema) => driver.open(schema),
		close: () => driver.close(),
		read: (table, key) => driver.read(table, key),
		write: (table, key, row) => driver.write(table, key, row),
		delete: (table, key) => {
			calls += 1
			if (calls >= after) throw new Error('faulty driver: delete failed')
			return driver.delete(table, key)
		},
		keys: (table) => driver.keys(table),
		scan: (table) => driver.scan(table),
		clear: (table) => driver.clear(table),
		snapshot: (tables) => driver.snapshot(tables),
	}
}

// ── Recording driver wrapper ──────────────────────────────────────────────────
// AGENTS §16.1: a real (delegating) driver that tallies `scan` calls per table —
// the direct no-N+1 proof: a query without a native `records` override runs
// through the engine's `scan` fallback, so one tallied `scan` call per table IS
// one batched query, regardless of how many parent records triggered it.

/** A per-table `scan` call tally over a real driver (AGENTS §16.1). */
export interface QueryRecorderInterface {
	readonly driver: DriverInterface
	count(table: string): number
}

/**
 * Wrap a real `DriverInterface` to tally `scan` calls per table, for asserting
 * batched (no N+1) loading — one `scan` per relation regardless of parent count.
 *
 * @param driver - The real driver to delegate every method to
 * @returns A recorder exposing the wrapped `driver` and a per-table `count`
 */
export function createRecordingDriver(driver: DriverInterface): QueryRecorderInterface {
	const tally: Record<string, number> = {}
	const wrapped: DriverInterface = {
		open: (schema) => driver.open(schema),
		close: () => driver.close(),
		read: (table, key) => driver.read(table, key),
		write: (table, key, row) => driver.write(table, key, row),
		delete: (table, key) => driver.delete(table, key),
		keys: (table) => driver.keys(table),
		scan: (table) => {
			tally[table] = (tally[table] ?? 0) + 1
			return driver.scan(table)
		},
		clear: (table) => driver.clear(table),
		snapshot: (tables) => driver.snapshot(tables),
	}
	return {
		driver: wrapped,
		count(table: string) {
			return tally[table] ?? 0
		},
	}
}
