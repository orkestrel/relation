// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`).

import type { ContractInterface, FieldPath } from '@orkestrel/contract'
import type {
	AggregateOperation,
	CursorInterface,
	DatabaseStorageInterface,
	DriverInterface,
	Key,
	OperationOptions,
	QueryInput,
	QueryInterface,
	Row,
	TableEventMap,
	TableInterface,
	TableMap,
	TableSchema,
} from '@orkestrel/database'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { RelationManagerOptions, RelationSchema } from '@src/core'
import { integerShape, isArray, isRecord, stringShape } from '@orkestrel/contract'
import {
	belongsTo,
	computeLinkKey,
	createRelationManager,
	hasMany,
	hasMorph,
	hasOne,
	hasThrough,
} from '@src/core'
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
export const INTEGRATION_RELATIONS: RelationSchema<typeof INTEGRATION_TABLES> = {
	users: { posts: hasMany('author') },
}

/** Holds the relation loading fixture's table shapes. */
export const MODEL_TABLES = {
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
}

/** Holds the registry fixture's table shapes. */
export const MANAGER_TABLES = {
	accounts: { id: stringShape(), name: stringShape() },
	contacts: { id: stringShape(), accountId: stringShape(), email: stringShape() },
}

/** Holds the registry fixture's nested relations. */
export const MANAGER_RELATIONS: RelationSchema<typeof MANAGER_TABLES> = {
	accounts: { contacts: hasMany('accountId') },
	contacts: { account: belongsTo('accountId', 'accounts') },
}

/** Holds a declared table with no relation map. */
export const LOG_TABLES = { logs: { id: stringShape(), msg: stringShape() } }

// ── Driver fault fixtures ─────────────────────────────────────────────────────

/** Injects one configured delete failure through a real driver boundary. */
export class FaultDriver implements DriverInterface {
	readonly #driver: DriverInterface
	readonly #after: number
	readonly #fault: Error
	#calls = 0

	constructor(
		driver: DriverInterface,
		after: number,
		fault = new Error('FaultDriver delete failure'),
	) {
		this.#driver = driver
		this.#after = after
		this.#fault = fault
	}

	open(schema: readonly TableSchema[]): Promise<void> {
		return this.#driver.open(schema)
	}

	close(): Promise<void> {
		return this.#driver.close()
	}

	read(table: string, key: Key): Promise<Row | undefined>
	read(table: string, keys: readonly Key[]): Promise<ReadonlyArray<Row | undefined>>
	read(
		table: string,
		keys: Key | readonly Key[],
	): Promise<Row | undefined | ReadonlyArray<Row | undefined>> {
		return isArray(keys) ? this.#driver.read(table, keys) : this.#driver.read(table, keys)
	}

	write(
		table: string,
		keys: readonly Key[],
		rows: readonly Row[],
		options?: OperationOptions,
	): Promise<void>
	write(table: string, key: Key, row: Row, options?: OperationOptions): Promise<void>
	write(
		table: string,
		keys: Key | readonly Key[],
		values: Row | readonly Row[],
		options?: OperationOptions,
	): Promise<void> {
		if (isArray(keys) && isArray(values)) return this.#driver.write(table, keys, values, options)
		if (!isArray(keys) && !isArray(values)) return this.#driver.write(table, keys, values, options)
		return Promise.reject(
			new TypeError('FaultDriver write: keys and rows must both be arrays or both be single'),
		)
	}

	insert(
		table: string,
		keys: readonly Key[],
		rows: readonly Row[],
		options?: OperationOptions,
	): Promise<void>
	insert(table: string, key: Key, row: Row, options?: OperationOptions): Promise<void>
	insert(
		table: string,
		keys: Key | readonly Key[],
		values: Row | readonly Row[],
		options?: OperationOptions,
	): Promise<void> {
		if (isArray(keys) && isArray(values)) return this.#driver.insert(table, keys, values, options)
		if (!isArray(keys) && !isArray(values)) return this.#driver.insert(table, keys, values, options)
		return Promise.reject(
			new TypeError('FaultDriver insert: keys and rows must both be arrays or both be single'),
		)
	}

	delete(table: string, key: Key, options?: OperationOptions): Promise<boolean>
	delete(
		table: string,
		keys: readonly Key[],
		options?: OperationOptions,
	): Promise<readonly boolean[]>
	delete(
		table: string,
		keys: Key | readonly Key[],
		options?: OperationOptions,
	): Promise<boolean | readonly boolean[]> {
		this.#calls += 1
		if (this.#calls >= this.#after) throw this.#fault
		return isArray(keys)
			? this.#driver.delete(table, keys, options)
			: this.#driver.delete(table, keys, options)
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
		tables: MODEL_TABLES,
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
	await db
		.table('accountReps')
		.set({ id: computeLinkKey('acc1', 'rep1'), accountId: 'acc1', repId: 'rep1' })
	await db
		.table('accountReps')
		.set({ id: computeLinkKey('acc1', 'rep2'), accountId: 'acc1', repId: 'rep2' })
	await db.table('notes').set({ id: 'n1', entityId: 'acc1', entityType: 'account', body: 'kept' })
	await db
		.table('notes')
		.set({ id: 'n2', entityId: 'acc1', entityType: 'contact', body: 'skipped' })

	const manager = createRelationManager<typeof MODEL_TABLES>({
		storage: db,
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
		tables: MANAGER_TABLES,
	})
	await db.table('accounts').set({ id: 'acc1', name: 'Acme' })
	await db.table('accounts').set({ id: 'acc2', name: 'Beta' })
	await db.table('contacts').set({ id: 'con1', accountId: 'acc1', email: 'a@x.com' })

	const manager = createRelationManager<typeof MANAGER_TABLES>({
		storage: db,
		relations: MANAGER_RELATIONS,
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

/** Holds the transaction fixture's nested and custom-primary relations. */
export const STORAGE_RELATIONS = {
	accounts: {
		contacts: hasMany('accountCode'),
		reps: hasThrough('junction', 'accountCode', 'repCode', 'reps'),
	},
	contacts: { account: belongsTo('accountCode', 'accounts') },
}

/** Holds custom-primary table shapes for transaction proofs. */
export const STORAGE_TABLES = {
	accounts: { code: stringShape(), name: stringShape() },
	contacts: { id: stringShape(), accountCode: stringShape() },
	reps: { code: stringShape(), name: stringShape() },
	junction: { id: stringShape(), accountCode: stringShape(), repCode: stringShape() },
}

/** Opens custom-primary tables with derived-key junctions for scope settlement proofs. */
export async function createStorageFixture() {
	const db = createDatabase({
		driver: createMemoryDriver(),
		tables: STORAGE_TABLES,
		primary: { accounts: 'code', reps: 'code' },
	})
	await db.table('reps').set({ code: 'r1', name: 'Rae' })
	await db.table('reps').set({ code: 'r2', name: 'Bo' })
	await db
		.table('junction')
		.set({ id: computeLinkKey('a1', 'r1'), accountCode: 'a1', repCode: 'r1' })
	await db
		.table('junction')
		.set({ id: computeLinkKey('a0', 'r2'), accountCode: 'a0', repCode: 'r2' })
	return db
}

// ── Call recording ────────────────────────────────────────────────────────────

/** Receives one table call as the table's name and the method called. */
export type TableCallHandler = (table: string, method: string) => void

/** Replaces one row a table read returns, given the table's name; a test's view of a storage. */
export type RowProjector = (table: string, row: Row) => Row

/** Represents a row a custom storage returns as a class instance rather than a plain record. */
export class EntityRow {
	readonly [column: string]: unknown

	constructor(row: Row) {
		Object.assign(this, row)
	}
}

/**
 * Records every call on a real table, then forwards it; a projector, when given, replaces each row
 * `get` and `records` return after the real read resolves.
 */
export class RecordingTable implements TableInterface {
	readonly #table: TableInterface
	readonly #record: TableCallHandler
	readonly #project: RowProjector | undefined

	constructor(table: TableInterface, record: TableCallHandler, project?: RowProjector) {
		this.#table = table
		this.#record = record
		this.#project = project
	}

	get emitter(): EmitterInterface<TableEventMap> {
		return this.#table.emitter
	}

	get name(): string {
		return this.#table.name
	}

	get primary(): string {
		return this.#table.primary
	}

	get contract(): ContractInterface<Row> {
		return this.#table.contract
	}

	get(key: Key): Promise<Row | undefined>
	get(keys: readonly Key[]): Promise<ReadonlyArray<Row | undefined>>
	async get(keys: Key | readonly Key[]): Promise<Row | undefined | ReadonlyArray<Row | undefined>> {
		this.#record(this.#table.name, 'get')
		if (isArray(keys)) {
			return (await this.#table.get(keys)).map((row) =>
				row === undefined ? undefined : this.#view(row),
			)
		}
		const row = await this.#table.get(keys)
		return row === undefined ? undefined : this.#view(row)
	}

	resolve(key: Key): Promise<Row>
	resolve(keys: readonly Key[]): Promise<readonly Row[]>
	resolve(keys: Key | readonly Key[]): Promise<Row | readonly Row[]> {
		this.#record(this.#table.name, 'resolve')
		return isArray(keys) ? this.#table.resolve(keys) : this.#table.resolve(keys)
	}

	has(key: Key): Promise<boolean>
	has(keys: readonly Key[]): Promise<readonly boolean[]>
	has(keys: Key | readonly Key[]): Promise<boolean | readonly boolean[]> {
		this.#record(this.#table.name, 'has')
		return isArray(keys) ? this.#table.has(keys) : this.#table.has(keys)
	}

	keys(): Promise<readonly Key[]> {
		this.#record(this.#table.name, 'keys')
		return this.#table.keys()
	}

	async records(input?: QueryInput, options?: OperationOptions): Promise<readonly Row[]> {
		this.#record(this.#table.name, 'records')
		return (await this.#table.records(input, options)).map((row) => this.#view(row))
	}

	count(input?: QueryInput, options?: OperationOptions): Promise<number> {
		this.#record(this.#table.name, 'count')
		return this.#table.count(input, options)
	}

	aggregate(
		operation: AggregateOperation,
		column: FieldPath,
		input?: QueryInput,
		options?: OperationOptions,
	): Promise<number | undefined> {
		this.#record(this.#table.name, 'aggregate')
		return this.#table.aggregate(operation, column, input, options)
	}

	scan(input?: QueryInput, options?: OperationOptions): AsyncIterable<Row> {
		this.#record(this.#table.name, 'scan')
		return this.#table.scan(input, options)
	}

	set(row: Row, options?: OperationOptions): Promise<Key>
	set(rows: readonly Row[], options?: OperationOptions): Promise<readonly Key[]>
	set(input: Row | readonly Row[], options?: OperationOptions): Promise<Key | readonly Key[]> {
		this.#record(this.#table.name, 'set')
		return isArray(input) ? this.#table.set(input, options) : this.#table.set(input, options)
	}

	add(row: Row, options?: OperationOptions): Promise<Key>
	add(rows: readonly Row[], options?: OperationOptions): Promise<readonly Key[]>
	add(input: Row | readonly Row[], options?: OperationOptions): Promise<Key | readonly Key[]> {
		this.#record(this.#table.name, 'add')
		return isArray(input) ? this.#table.add(input, options) : this.#table.add(input, options)
	}

	update(key: Key, changes: Partial<Row>, options?: OperationOptions): Promise<boolean>
	update(
		keys: readonly Key[],
		changes: Partial<Row>,
		options?: OperationOptions,
	): Promise<readonly boolean[]>
	update(
		keys: Key | readonly Key[],
		changes: Partial<Row>,
		options?: OperationOptions,
	): Promise<boolean | readonly boolean[]> {
		this.#record(this.#table.name, 'update')
		return isArray(keys)
			? this.#table.update(keys, changes, options)
			: this.#table.update(keys, changes, options)
	}

	remove(key: Key, options?: OperationOptions): Promise<boolean>
	remove(keys: readonly Key[], options?: OperationOptions): Promise<boolean>
	remove(keys: Key | readonly Key[], options?: OperationOptions): Promise<boolean> {
		this.#record(this.#table.name, 'remove')
		return isArray(keys) ? this.#table.remove(keys, options) : this.#table.remove(keys, options)
	}

	clear(): Promise<void> {
		this.#record(this.#table.name, 'clear')
		return this.#table.clear()
	}

	query(): QueryInterface<Row> {
		this.#record(this.#table.name, 'query')
		return this.#table.query()
	}

	cursor(): Promise<CursorInterface<Row>> {
		this.#record(this.#table.name, 'cursor')
		return this.#table.cursor()
	}

	// Apply the projector, when one was given, to one row a read returned.
	#view(row: Row): Row {
		return this.#project === undefined ? row : this.#project(this.#table.name, row)
	}
}

/** Hands out a {@link RecordingTable} over each table of a real storage. */
export class RecordingStorage implements DatabaseStorageInterface {
	readonly #storage: DatabaseStorageInterface
	readonly #record: TableCallHandler
	readonly #project: RowProjector | undefined

	constructor(storage: DatabaseStorageInterface, record: TableCallHandler, project?: RowProjector) {
		this.#storage = storage
		this.#record = record
		this.#project = project
	}

	table(name: string): TableInterface {
		return new RecordingTable(this.#storage.table(name), this.#record, this.#project)
	}
}

/** Holds the load fixture's relations: every relationship, nested both ways. */
export const LOAD_RELATIONS: RelationSchema<typeof MODEL_TABLES> = {
	accounts: {
		classification: belongsTo('classificationId', 'classifications'),
		contacts: hasMany('accountId'),
		profile: hasOne('accountId', 'profiles'),
		reps: hasThrough('accountReps', 'accountId', 'repId', 'reps'),
		notes: hasMorph('entityId', 'entityType', 'account', 'notes'),
	},
	contacts: { account: belongsTo('accountId', 'accounts') },
	reps: { accounts: hasThrough('accountReps', 'repId', 'accountId', 'accounts') },
}

/**
 * Opens the loading fixture with `parents` accounts, each holding `related` rows of every
 * relationship, behind a storage that reports every table call to `record` and passes each
 * row it reads through `project` when one is given.
 */
export async function createLoadFixture(
	parents: number,
	related: number,
	record: TableCallHandler,
	driver: DriverInterface = createMemoryDriver(),
	project?: RowProjector,
) {
	const db = createDatabase({ driver, tables: MODEL_TABLES })
	const accounts = Array.from({ length: parents }, (_, index) => `acc${index}`)
	const items = Array.from({ length: related }, (_, index) => index)
	await db.table('classifications').set({ id: 'cls1', label: 'Commercial' })
	await db.table('reps').set(items.map((item) => ({ id: `rep${item}`, name: `Rep ${item}` })))
	await db
		.table('accounts')
		.set(accounts.map((id) => ({ id, name: `Account ${id}`, classificationId: 'cls1' })))
	await db
		.table('contacts')
		.set(
			accounts.flatMap((id) =>
				items.map((item) => ({ id: `${id}-con${item}`, accountId: id, email: `${item}@x.com` })),
			),
		)
	await db
		.table('profiles')
		.set(
			accounts.flatMap((id) =>
				items.map((item) => ({ id: `${id}-pro${item}`, accountId: id, bio: 'bio' })),
			),
		)
	await db.table('accountReps').set(
		accounts.flatMap((id) =>
			items.map((item) => ({
				id: computeLinkKey(id, `rep${item}`),
				accountId: id,
				repId: `rep${item}`,
			})),
		),
	)
	await db.table('notes').set(
		accounts.flatMap((id) =>
			items.map((item) => ({
				id: `${id}-note${item}`,
				entityId: id,
				entityType: 'account',
				body: 'kept',
			})),
		),
	)
	const manager = createRelationManager<TableMap>({
		storage: new RecordingStorage(db, record, project),
		relations: LOAD_RELATIONS,
	})
	return { db, keys: accounts, accounts: manager.model('accounts') }
}
