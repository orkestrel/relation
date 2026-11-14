import type { DatabaseInterface, RowOf, TableInterface } from '@orkestrel/database'
import { belongsTo, createRelationManager, hasThrough } from '@src/core'
import { createDatabase, createMemoryDriver, isDatabaseError } from '@orkestrel/database'
import { stringShape } from '@orkestrel/contract'
import { captureError, invokeUnchecked, readProperty } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import {
	LOG_TABLES,
	MANAGER_RELATIONS,
	MANAGER_TABLES,
	MODEL_TABLES,
	createManagerFixture,
} from '../../setup.js'

describe('RelationManager — registry', () => {
	it('tracks the defined models', async () => {
		const { manager } = await createManagerFixture()
		expect(manager.count).toBe(2)
		expect([...manager.names()].sort()).toEqual(['accounts', 'contacts'])
		expect(manager.has('accounts')).toBe(true)
		expect(manager.has('missing')).toBe(false)
	})
	it('counts zero models when no relations are declared', () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		const manager = createRelationManager<typeof MANAGER_TABLES>({ storage: db })
		expect(manager.count).toBe(0)
		expect(manager.names()).toEqual([])
	})
	it('T1 retains precise root and scoped tables and accepts broad root storage', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		const root = createRelationManager<typeof MANAGER_TABLES>({
			storage: db,
			relations: MANAGER_RELATIONS,
		})
		const rootTable: TableInterface<RowOf<typeof MANAGER_TABLES.accounts>> =
			root.model('accounts').table
		await rootTable.set({ id: 'a1', name: 'Acme' })
		const name = await db.transaction(async (storage) => {
			const scoped = createRelationManager({ storage, relations: MANAGER_RELATIONS })
			const table: TableInterface<RowOf<typeof MANAGER_TABLES.accounts>> =
				scoped.model('accounts').table
			const account = await table.get('a1')
			return account?.name.toUpperCase()
		})
		expect(name).toBe('ACME')
		const broad: DatabaseInterface = db
		expect(createRelationManager({ storage: broad, relations: MANAGER_RELATIONS }).names()).toEqual(
			['accounts', 'contacts'],
		)
	})
})

describe('RelationManager — validation', () => {
	it.each([
		[{ column: 42 }],
		[{ relationship: ' belongs ', column: 'accountId' }],
		[{ key: 'accountId', column: undefined }],
	])('refuses the relation %o at construction rather than repairing it', (descriptor) => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		const error = captureError(() =>
			invokeUnchecked(undefined, createRelationManager, [
				{ storage: db, relations: { accounts: { contacts: descriptor } } },
			]),
		)
		expect(readProperty(error, 'code')).toBe('INVALID')
		expect(readProperty(readProperty(error, 'context'), 'relation')).toBe('contacts')
	})

	it.each([
		['source', 'accountId'],
		['target', 'repId'],
	])('refuses a junction keyed by its own %s column at construction', (role, column) => {
		const db = createDatabase({
			driver: createMemoryDriver(),
			tables: {
				accounts: { id: stringShape() },
				reps: { id: stringShape() },
				accountReps: { accountId: stringShape(), repId: stringShape() },
			},
			primary: { accountReps: column },
		})
		expect(() =>
			createRelationManager({
				storage: db,
				relations: { accounts: { reps: hasThrough('accountReps', 'accountId', 'repId', 'reps') } },
			}),
		).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				message: `Relation accounts.reps keys its junction accountReps by its ${role} column ${column}; give the junction a separate text primary column, which link fills with computeLinkKey`,
				context: { model: 'accounts', relation: 'reps', table: 'accountReps', column },
			}),
		)
	})

	it('T6 validates targets and junctions inside transaction storage', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MODEL_TABLES })
		await db.transaction(async (storage) => {
			expect(() =>
				createRelationManager({
					storage,
					relations: { accounts: { ghost: belongsTo('ghostId', 'ghosts') } },
				}),
			).toThrow(
				expect.objectContaining({
					code: 'INVALID',
					message:
						"Relation accounts.ghost targets undeclared table ghosts; declare it in the database's tables or correct the relation's model",
					context: { model: 'accounts', relation: 'ghost', table: 'ghosts' },
				}),
			)
			expect(() =>
				createRelationManager({
					storage,
					relations: { accounts: { reps: hasThrough('missing', 'accountId', 'repId', 'reps') } },
				}),
			).toThrow(
				expect.objectContaining({
					code: 'INVALID',
					message:
						"Relation accounts.reps uses undeclared junction missing; declare it in the database's tables or correct the relation's through",
					context: { model: 'accounts', relation: 'reps', table: 'missing' },
				}),
			)
		})
	})
	it('T7 propagates CONFLICT from settled storage and retained model reads', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		const retained = await db.transaction(async (storage) => ({
			storage,
			model: createRelationManager({ storage, relations: MANAGER_RELATIONS }).model('accounts'),
		}))
		expect(() =>
			createRelationManager({ storage: retained.storage, relations: MANAGER_RELATIONS }),
		).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
		await expect(retained.model.load('a1', { contacts: true })).rejects.toSatisfy(
			(error: unknown) => isDatabaseError(error) && error.code === 'CONFLICT',
		)
	})
	it('propagates CLOSED from construction over a closed root', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		await db.close()
		expect(() =>
			createRelationManager<typeof MANAGER_TABLES>({ storage: db, relations: MANAGER_RELATIONS }),
		).toThrow(expect.objectContaining({ code: 'CLOSED' }))
	})
	it('rejects an undeclared relation target at construction', () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		expect(() =>
			createRelationManager<typeof MANAGER_TABLES>({
				storage: db,
				relations: { accounts: { ghost: belongsTo('ghostId', 'ghosts') } },
			}),
		).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				message:
					"Relation accounts.ghost targets undeclared table ghosts; declare it in the database's tables or correct the relation's model",
				context: { model: 'accounts', relation: 'ghost', table: 'ghosts' },
			}),
		)
	})
	it('rejects an undeclared through junction at construction', () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: MODEL_TABLES })
		expect(() =>
			createRelationManager<typeof MODEL_TABLES>({
				storage: db,
				relations: { accounts: { reps: hasThrough('missing', 'accountId', 'repId', 'reps') } },
			}),
		).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				message:
					"Relation accounts.reps uses undeclared junction missing; declare it in the database's tables or correct the relation's through",
				context: { model: 'accounts', relation: 'reps', table: 'missing' },
			}),
		)
	})
})

describe('RelationManager — model() accessor', () => {
	it('vends a model over the table, typed by that table and named for it', async () => {
		const { manager } = await createManagerFixture()
		const accounts = manager.model('accounts')
		expect(accounts.name).toBe('accounts')
		expect(await accounts.table.count()).toBe(2)
		expect((await accounts.table.get('acc1'))?.name).toBe('Acme')
	})
	it('vends a model even for a declared table with no relations', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: LOG_TABLES })
		await db.table('logs').set({ id: 'l1', msg: 'hi' })
		const logs = createRelationManager<typeof LOG_TABLES>({ storage: db }).model('logs')
		expect(logs.name).toBe('logs')
		expect((await logs.table.get('l1'))?.msg).toBe('hi')
		expect(Object.keys(logs.relations)).toEqual([])
	})
})
