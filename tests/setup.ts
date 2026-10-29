// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`).

import type { DriverInterface, Key, OperationOptions, Row, TableSchema } from '@orkestrel/database'
import type { RelationManagerOptions, RelationsShape } from '@src/core'
import { integerShape, isArray, isRecord, stringShape } from '@orkestrel/contract'
import { belongsTo, createRelationManager, hasMany, hasMorph, hasOne, hasThrough } from '@src/core'
import { createDatabase, createMemoryDriver, shapeToColumnStorage } from '@orkestrel/database'

// ── Relation test fixtures ────────────────────────────────────────────────────
// Shared, environment-agnostic scenario builders for the `relation` module's tests —
// a `users` / `posts` schema (matching the database module's own integration
// fixtures) with a `users` → `posts` `many` relation.

/** Holds the shared `users` / `posts` shape maps for the cross-suite integration tests. */
export const INTEGRATION_TABLES = {
	users: { id: stringShape(), name: stringShape(), age: integerShape() },
	posts: { id: stringShape(), author: stringShape(), title: stringShape() },
} as const

/** Holds the shared relation map over {@link INTEGRATION_TABLES} — `users` has many `posts`. */
export const INTEGRATION_RELATIONS: RelationsShape<typeof INTEGRATION_TABLES> = {
	users: { posts: hasMany('author') },
}

// ── Driver fault fixtures ─────────────────────────────────────────────────────

/** Injects one configured delete failure through a real driver boundary. */
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

/** Narrows a loaded relation to a record array. */
export function rows(value: unknown): readonly Row[] {
	return isArray(value) ? value.filter(isRecord) : []
}
/** Narrows a loaded relation to a record. */
export function one(value: unknown): Row {
	return isRecord(value) ? value : {}
}

// An observer that always throws, so the emitter's isolation and the manager's `model.error`
// handler are both observable from one load.
/** Throws from a load observer to exercise listener isolation. */
export function throwLoadObserver(): void {
	throw new Error('load observer blew up')
}

/** Opens the relation-loading fixture over a real driver. */
export async function setup(
	driver: DriverInterface = createMemoryDriver(),
	model?: RelationManagerOptions['model'],
) {
	const db = createDatabase({
		driver,
		tables: {
			accounts: { id: stringShape(), name: stringShape(), classificationId: stringShape() },
			contacts: { id: stringShape(), accountId: stringShape(), email: stringShape() },
			classifications: { id: stringShape(), label: stringShape() },
			profiles: { id: stringShape(), accountId: stringShape(), bio: stringShape() },
			reps: { id: stringShape(), name: stringShape() },
			accountReps: { id: stringShape(), accountId: stringShape(), repId: stringShape() },
			notes: {
				id: stringShape(),
				entityId: stringShape(),
				entityType: stringShape(),
				body: stringShape(),
			},
		},
	})

	await db.table('classifications').set({ id: 'cls1', label: 'Commercial' })
	await db.table('accounts').set({ id: 'acc1', name: 'Acme', classificationId: 'cls1' })
	await db.table('accounts').set({ id: 'acc2', name: 'Beta', classificationId: 'cls1' })
	await db.table('contacts').set({ id: 'con1', accountId: 'acc1', email: 'a@x.com' })
	await db.table('contacts').set({ id: 'con2', accountId: 'acc1', email: 'b@x.com' })
	await db.table('profiles').set({ id: 'pro1', accountId: 'acc1', bio: 'hi' })
	await db.table('reps').set({ id: 'rep1', name: 'Rae' })
	await db.table('reps').set({ id: 'rep2', name: 'Bo' })
	await db.table('reps').set({ id: 'rep3', name: 'Cy' })
	await db.table('accountReps').set({ id: 'ar1', accountId: 'acc1', repId: 'rep1' })
	await db.table('accountReps').set({ id: 'ar2', accountId: 'acc1', repId: 'rep2' })
	await db.table('notes').set({ id: 'n1', entityId: 'acc1', entityType: 'account', body: 'kept' })
	await db
		.table('notes')
		.set({ id: 'n2', entityId: 'acc1', entityType: 'contact', body: 'skipped' })

	const manager = createRelationManager({
		database: db,
		relations: {
			accounts: {
				classification: belongsTo('classificationId', 'classifications'),
				contacts: hasMany('accountId'),
				profile: hasOne('accountId', 'profiles'),
				reps: hasThrough('accountReps', 'accountId', 'repId', 'reps'),
				notes: hasMorph('entityId', 'entityType', 'account', 'notes'),
			},
			contacts: { account: belongsTo('accountId', 'accounts') },
		},
		...(model !== undefined ? { model } : {}),
	})
	return { db, manager, accounts: manager.model('accounts') }
}

/** Opens the manager registry fixture. */
export async function createManagerFixture() {
	const db = createDatabase({
		driver: createMemoryDriver(),
		tables: {
			accounts: { id: stringShape(), name: stringShape() },
			contacts: { id: stringShape(), accountId: stringShape(), email: stringShape() },
		},
	})
	await db.table('accounts').set({ id: 'acc1', name: 'Acme' })
	await db.table('accounts').set({ id: 'acc2', name: 'Beta' })
	await db.table('contacts').set({ id: 'con1', accountId: 'acc1', email: 'a@x.com' })

	const manager = createRelationManager({
		database: db,
		relations: {
			accounts: { contacts: hasMany('accountId') },
			contacts: { account: belongsTo('accountId', 'accounts') },
		},
	})
	return { db, manager }
}

/** Derives the real driver schema the fixture table map declares. */
export function buildFixtureSchema(): readonly TableSchema[] {
	return Object.entries(INTEGRATION_TABLES).map(([name, columns]) => ({
		name,
		primary: 'id',
		columns: Object.entries(columns).map(([column, shape]) => ({
			name: column,
			storage: shapeToColumnStorage(shape),
			optional: false,
			nullable: false,
		})),
		indexes: [],
	}))
}

/** Opens a real memory driver over the fixture schema. */
export async function openFixtureDriver() {
	const driver = createMemoryDriver()
	await driver.open(buildFixtureSchema())
	return driver
}
