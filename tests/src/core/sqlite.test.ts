import { belongsTo, createRelationManager, hasMany, hasMorph, hasOne, hasThrough } from '@src/core'
import type { DatabaseInterface, Row } from '@orkestrel/database'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { createSQLiteDriver } from '@orkestrel/database/server'
import { isArray, isRecord, stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'

// Driver-portability (UNIT 6b): the SAME multi-kind relation scenario, run once over
// the in-memory driver and once over a real SQLite driver (`@orkestrel/database/server`),
// must attach identical results — proving the batched query shape (`where(col).any(keys)`)
// is not a memory-driver-only accident. `@orkestrel/sqlite` is a devDependency alongside
// this (the family's own SQLite wrapper); the driver under test here is the database
// module's native `createSQLiteDriver` (a `:memory:` SQLite database, no file I/O).

const TABLES = {
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
} as const

function rows(value: unknown): readonly Row[] {
	return isArray(value) ? value.filter(isRecord) : []
}
function one(value: unknown): Row {
	return isRecord(value) ? value : {}
}

async function seed(db: DatabaseInterface<typeof TABLES>): Promise<void> {
	await db.table('classifications').set({ id: 'cls1', label: 'Commercial' })
	await db.table('accounts').set({ id: 'acc1', name: 'Acme', classificationId: 'cls1' })
	await db.table('accounts').set({ id: 'acc2', name: 'Beta', classificationId: 'cls1' })
	await db.table('contacts').set({ id: 'con1', accountId: 'acc1', email: 'a@x.com' })
	await db.table('contacts').set({ id: 'con2', accountId: 'acc1', email: 'b@x.com' })
	await db.table('profiles').set({ id: 'pro1', accountId: 'acc1', bio: 'hi' })
	await db.table('reps').set({ id: 'rep1', name: 'Rae' })
	await db.table('reps').set({ id: 'rep2', name: 'Bo' })
	await db.table('accountReps').set({ id: 'ar1', accountId: 'acc1', repId: 'rep1' })
	await db.table('accountReps').set({ id: 'ar2', accountId: 'acc1', repId: 'rep2' })
	await db.table('notes').set({ id: 'n1', entityId: 'acc1', entityType: 'account', body: 'kept' })
	await db
		.table('notes')
		.set({ id: 'n2', entityId: 'acc1', entityType: 'contact', body: 'skipped' })
}

async function run(db: DatabaseInterface<typeof TABLES>) {
	await seed(db)
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
		},
	})
	const accounts = manager.model('accounts')
	const acme = await accounts.load('acc1', {
		classification: true,
		contacts: true,
		profile: true,
		reps: true,
		notes: true,
	})
	return {
		classification: one(acme?.classification).label,
		contacts: rows(acme?.contacts)
			.map((c) => c.id)
			.sort(),
		profile: one(acme?.profile).bio,
		reps: rows(acme?.reps)
			.map((r) => r.id)
			.sort(),
		notes: rows(acme?.notes).map((n) => n.id),
	}
}

describe('Model — driver portability (UNIT 6b, SQLite vs memory)', () => {
	it('attaches identical relation results over a real SQLite driver as over the memory driver', async () => {
		const memory = await run(createDatabase({ driver: createMemoryDriver(), tables: TABLES }))
		const sqlite = await run(
			createDatabase({ driver: createSQLiteDriver(':memory:'), tables: TABLES }),
		)
		expect(sqlite).toEqual(memory)
	})
})
