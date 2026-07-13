import { belongsTo, createRelationManager, hasMany } from '@src/core'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'

// Manager-level behavior — the registry surface (`count` / `models` / `has`) and
// the typed `model(name)` accessor. Relation loading, nested includes, and
// through management are `Model`'s own surface and live in Model.test.ts.

async function setup() {
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

describe('RelationManager — registry', () => {
	it('tracks the defined models', async () => {
		const { manager } = await setup()
		expect(manager.count).toBe(2)
		expect([...manager.models()].sort()).toEqual(['accounts', 'contacts'])
		expect(manager.has('accounts')).toBe(true)
		expect(manager.has('missing')).toBe(false)
	})

	it('counts zero models when no relations are declared', async () => {
		const db = createDatabase({
			driver: createMemoryDriver(),
			tables: { accounts: { id: stringShape(), name: stringShape() } },
		})
		const manager = createRelationManager({ database: db })
		expect(manager.count).toBe(0)
		expect(manager.models()).toEqual([])
	})
})

describe('RelationManager — model() accessor', () => {
	it('vends a model over the table, typed by that table and named for it', async () => {
		const { manager } = await setup()
		const accounts = manager.model('accounts')
		expect(accounts.name).toBe('accounts')
		// The model's table is the fully typed underlying table.
		expect(await accounts.table.count()).toBe(2)
		expect((await accounts.table.get('acc1'))?.name).toBe('Acme')
	})

	it('vends a model even for a declared table with no relations', async () => {
		const db = createDatabase({
			driver: createMemoryDriver(),
			tables: { logs: { id: stringShape(), msg: stringShape() } },
		})
		await db.table('logs').set({ id: 'l1', msg: 'hi' })
		const manager = createRelationManager({ database: db })
		const logs = manager.model('logs')
		expect(logs.name).toBe('logs')
		expect((await logs.table.get('l1'))?.msg).toBe('hi')
		expect(Object.keys(logs.relations)).toEqual([])
	})
})
