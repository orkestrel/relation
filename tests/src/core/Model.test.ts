import type { ModelEventMap, RelationManagerOptions } from '@src/core'
import { belongsTo, createRelationManager, hasMany, hasMorph, hasOne, hasThrough } from '@src/core'
import type { DriverInterface, Row } from '@orkestrel/database'
import { createDatabase, createMemoryDriver, isDatabaseError } from '@orkestrel/database'
import { isArray, isRecord, stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import { createRecorder, createRecorders } from '@orkestrel/test'
import { FaultDriver } from '../../setup.js'

// `Model` behavior — the relation-aware half of the relations layer: `load` /
// `find` populating each relationship (batched, no N+1), nested `includes`, the
// loaded relation accessors, and `link` / `unlink` / `links` junction management.
// The manager-level surface (`model()` accessor, registry counts) lives in
// RelationManager.test.ts. Uses a real memory-backed relational scenario covering
// every relationship (no mocks).

// Narrow the loose `Loaded` relation properties for assertions (no `as`).
function rows(value: unknown): readonly Row[] {
	return isArray(value) ? value.filter(isRecord) : []
}
function one(value: unknown): Row {
	return isRecord(value) ? value : {}
}

// An observer that always throws, so the emitter's isolation and the manager's `model.error`
// handler are both observable from one load.
function throwLoadObserver(): void {
	throw new Error('load observer blew up')
}

async function setup(
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

describe('Model — surface', () => {
	it('exposes name, a fully typed underlying table, and its relation map', async () => {
		const { accounts } = await setup()
		expect(accounts.name).toBe('accounts')
		expect(await accounts.table.count()).toBe(2)
		expect((await accounts.table.get('acc1'))?.name).toBe('Acme')
		expect(Object.keys(accounts.relations).sort()).toEqual([
			'classification',
			'contacts',
			'notes',
			'profile',
			'reps',
		])
	})
})

describe('Model — load (relationships)', () => {
	it('loads belongs (single, FK on this table)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { classification: true })
		expect(one(acme?.classification).label).toBe('Commercial')
	})

	it('loads many (array, FK on related)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { contacts: true })
		expect(
			rows(acme?.contacts)
				.map((c) => c.id)
				.sort(),
		).toEqual(['con1', 'con2'])
	})

	it('loads one (single, FK on related)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { profile: true })
		expect(one(acme?.profile).bio).toBe('hi')
	})

	it('loads through (junction many-to-many)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { reps: true })
		expect(
			rows(acme?.reps)
				.map((r) => r.id)
				.sort(),
		).toEqual(['rep1', 'rep2'])
	})

	it('loads morph (polymorphic, filtered by discriminator)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { notes: true })
		const notes = rows(acme?.notes)
		expect(notes.map((n) => n.id)).toEqual(['n1']) // n2 has entityType 'contact'
	})

	it('returns undefined for a missing record', async () => {
		const { accounts } = await setup()
		expect(await accounts.load('missing', { contacts: true })).toBeUndefined()
	})
})

describe('Model — nested includes', () => {
	it('loads a relation of a relation (batched, no N+1)', async () => {
		const { accounts } = await setup()
		const acme = await accounts.load('acc1', { contacts: { account: true } })
		const contacts = rows(acme?.contacts)
		expect(contacts).toHaveLength(2)
		expect(one(contacts[0]?.account).name).toBe('Acme')
	})
})

describe('Model — load (batch)', () => {
	it('loads many keys in one call (parallel array, undefined for misses)', async () => {
		const { accounts } = await setup()
		const loaded = await accounts.load(['acc1', 'missing', 'acc2'], { contacts: true })
		expect(loaded.map((a) => a?.name)).toEqual(['Acme', undefined, 'Beta'])
		expect(rows(loaded[0]?.contacts)).toHaveLength(2)
		expect(rows(loaded[2]?.contacts)).toHaveLength(0)
	})
})

describe('Model — find', () => {
	it('loads relations across a sorted, paged set', async () => {
		const { accounts } = await setup()
		const page = await accounts.find({ contacts: true }, { sort: 'name' })
		expect(page.map((a) => a.name)).toEqual(['Acme', 'Beta'])
		expect(rows(page[0]?.contacts)).toHaveLength(2) // Acme
		expect(rows(page[1]?.contacts)).toHaveLength(0) // Beta
	})

	it('sorts descending when explicitly requested', async () => {
		const { accounts } = await setup()
		const page = await accounts.find({}, { sort: 'name', direction: 'descending' })
		expect(page.map((a) => a.name)).toEqual(['Beta', 'Acme'])
	})

	it('honors limit / offset', async () => {
		const { accounts } = await setup()
		const page = await accounts.find(
			{},
			{ sort: 'name', direction: 'ascending', offset: 1, limit: 1 },
		)
		expect(page.map((a) => a.name)).toEqual(['Beta'])
	})
})

describe('Model — through management', () => {
	it('links, lists, and unlinks junction rows', async () => {
		const { accounts } = await setup()
		expect([...(await accounts.links('acc1', 'reps'))].sort()).toEqual(['rep1', 'rep2'])
		await accounts.link('acc1', 'reps', 'rep3')
		expect([...(await accounts.links('acc1', 'reps'))].sort()).toEqual(['rep1', 'rep2', 'rep3'])
		await accounts.unlink('acc1', 'reps', 'rep1')
		expect([...(await accounts.links('acc1', 'reps'))].sort()).toEqual(['rep2', 'rep3'])
	})

	it('throws on a non-through or unknown relation', async () => {
		const { accounts } = await setup()
		await expect(accounts.links('acc1', 'contacts')).rejects.toMatchObject({ code: 'NOT_THROUGH' })
		await expect(accounts.links('acc1', 'missing')).rejects.toMatchObject({
			code: 'UNKNOWN_RELATION',
		})
	})

	it('does not duplicate or re-emit an existing link', async () => {
		const { db, accounts } = await setup()
		const events = createRecorders<ModelEventMap, 'link'>(accounts.emitter, ['link'])
		await accounts.link('acc1', 'reps', 'rep3')
		await accounts.link('acc1', 'reps', 'rep3')
		expect(await db.table('accountReps').count()).toBe(3)
		expect(events.link.calls).toEqual([['acc1', 'reps']])
	})

	it('rolls back every matching removal when one delete fails', async () => {
		const driver = new FaultDriver(createMemoryDriver(), 2)
		const { db, accounts } = await setup(driver)
		await db.table('accountReps').set({ id: 'ar3', accountId: 'acc1', repId: 'rep1' })
		const events = createRecorders<ModelEventMap, 'unlink'>(accounts.emitter, ['unlink'])
		await expect(accounts.unlink('acc1', 'reps', 'rep1')).rejects.toThrow(
			'FaultDriver delete failure',
		)
		expect(await db.table('accountReps').count()).toBe(3)
		expect(events.unlink.count).toBe(0)
	})
})

describe('Model — cancellation', () => {
	it('stops a population walk after the signal aborts between relations', async () => {
		const { accounts } = await setup()
		const controller = new AbortController()
		const events = createRecorders<ModelEventMap, 'load'>(accounts.emitter, ['load'])
		accounts.emitter.on('load', () => controller.abort('stop after first relation'))
		await expect(
			accounts.load(
				'acc1',
				{ contacts: true, classification: true },
				{ signal: controller.signal },
			),
		).rejects.toSatisfy((error: unknown) => isDatabaseError(error) && error.code === 'ABORTED')
		expect(events.load.count).toBe(1)
	})
})

// ── Emitter — the PUSH observation surface ───────────────────────────────────
//
// A Model exposes a typed `emitter` (`ModelEventMap`) carrying its eager-load + junction
// moments — `load` (a relation resolved: its name + the count of related rows attached
// across the whole record set), `link` / `unlink` (a junction row written) — for
// fire-and-forget observers. Every event is emitted directly; the emitter isolates a listener
// throw (it can never escape into the batched eager-load), and every emit sits AFTER the load
// resolves / the junction op completes. A Model is reached through the RelationManager, which
// threads its `model.on` and `model.error` options into every handle it vends. These pin:
// `load` fires ONCE per relation (not per record — no N+1 in the events) with the attached
// count; `link` / `unlink` carry the owning key + relation; the manager's `model` option seeds
// a vended handle's listeners and receives their throws; and the emit-safety guarantee — a
// throwing observer cannot corrupt the load result.

// The ModelEventMap event names recorded across the emitter tests — fed to `createRecorders`
// from `@orkestrel/test` (`.claude/rules/tests.md` § Shared test infrastructure: the per-event
// wiring is centralized; this file keeps only the names its scenarios observe).
const MODEL_EVENTS: readonly ['load', 'link', 'unlink'] = ['load', 'link', 'unlink']

// `createRecorders` takes `TName` explicitly: `TMap` appears only inside the generic `on` of
// `EventSourceInterface`, so an emitter argument yields no inference candidate. Deriving the
// union from the array keeps `TName` exactly as wide as the recorded names.
type ModelEvent = (typeof MODEL_EVENTS)[number]

describe('Model — emitter (push observation surface)', () => {
	it('fires load once per relation with the count of rows attached across the record set', async () => {
		const { accounts } = await setup()
		const events = createRecorders<ModelEventMap, ModelEvent>(accounts.emitter, MODEL_EVENTS)
		await accounts.load('acc1', { contacts: true, classification: true })
		// One `load` per relation (NOT per record): acc1 has 2 contacts, 1 classification.
		expect([...events.load.calls].sort()).toEqual([
			['classification', 1],
			['contacts', 2],
		])
	})

	it('counts the total attached across a batch / find (one event per relation, not per record)', async () => {
		const { accounts } = await setup()
		const events = createRecorders<ModelEventMap, ModelEvent>(accounts.emitter, MODEL_EVENTS)
		// find loads both accounts; acc1 has 2 contacts, acc2 has 0 → 2 attached, ONE `load`.
		await accounts.find({ contacts: true })
		expect(events.load.calls).toEqual([['contacts', 2]])
	})

	it('a nested include fires load for the nested relation too', async () => {
		const { accounts } = await setup()
		const events = createRecorders<ModelEventMap, ModelEvent>(accounts.emitter, MODEL_EVENTS)
		await accounts.load('acc1', { contacts: { account: true } })
		// `contacts` (2 attached) at the top; nested `account` resolves for the 2 contacts → 2.
		expect([...events.load.calls].sort()).toEqual([
			['account', 2],
			['contacts', 2],
		])
	})

	it('fires link then unlink carrying the owning key + relation', async () => {
		const { accounts } = await setup()
		const events = createRecorders<ModelEventMap, ModelEvent>(accounts.emitter, MODEL_EVENTS)
		await accounts.link('acc1', 'reps', 'rep3')
		await accounts.unlink('acc1', 'reps', 'rep1')
		expect(events.link.calls).toEqual([['acc1', 'reps']])
		expect(events.unlink.calls).toEqual([['acc1', 'reps']])
	})

	it('delivers load to a listener subscribed on the handle', async () => {
		const { accounts } = await setup()
		const load = createRecorder<[name: string, count: number]>()
		accounts.emitter.on('load', load.handler)
		await accounts.load('acc1', { profile: true })
		expect(load.calls).toEqual([['profile', 1]])
	})

	it('seeds a vended handle with the initial listeners the manager model option carries', async () => {
		const load = createRecorder<[name: string, count: number]>()
		const { accounts } = await setup(createMemoryDriver(), { on: { load: load.handler } })
		await accounts.load('acc1', { profile: true })
		expect(load.calls).toEqual([['profile', 1]])
	})

	it('routes a throwing listener to the error handler the manager model option carries', async () => {
		const failures = createRecorder<[error: unknown, event: string]>()
		const { accounts } = await setup(createMemoryDriver(), {
			on: { load: throwLoadObserver },
			error: failures.handler,
		})
		// The load still resolves — the emitter isolates the throw and reports it as
		// `(error, event)` to the handler the manager threaded in.
		const acme = await accounts.load('acc1', { contacts: true })
		expect(
			rows(acme?.contacts)
				.map((contact) => contact.id)
				.sort(),
		).toEqual(['con1', 'con2'])
		expect(failures.calls.map(([, event]) => event)).toEqual(['load'])
		expect(
			failures.calls.map(([error]) => (error instanceof Error ? error.message : undefined)),
		).toEqual(['load observer blew up'])
	})

	it('EMIT SAFETY: a throwing load listener cannot corrupt the loaded result (the emitter isolates it)', async () => {
		const { accounts } = await setup()
		accounts.emitter.on('load', () => {
			throw new Error('load observer blew up')
		})
		// THE LOAD-BEARING ASSERTION: the eager-load still resolves correctly despite the throw
		// (the emitter isolated it — this manager carries no `model.error` option, so the throw
		// is swallowed silently — and it never escaped).
		const acme = await accounts.load('acc1', { contacts: true })
		const contacts = rows(acme?.contacts)
		expect(contacts.map((c) => c.id).sort()).toEqual(['con1', 'con2'])
	})

	it('EMIT SAFETY: a throwing link listener cannot corrupt the junction write', async () => {
		const { accounts } = await setup()
		accounts.emitter.on('link', () => {
			throw new Error('link observer blew up')
		})
		// The junction row is still written despite the throwing observer.
		await accounts.link('acc1', 'reps', 'rep3')
		expect([...(await accounts.links('acc1', 'reps'))].sort()).toEqual(['rep1', 'rep2', 'rep3'])
	})

	it('EMIT SAFETY: a throwing load listener still resolves the load (isolation)', async () => {
		const { accounts } = await setup()
		accounts.emitter.on('load', () => {
			throw new Error('load listener blew up')
		})
		// The load STILL resolves — the throw never escaped.
		const acme = await accounts.load('acc1', { classification: true })
		expect(one(acme?.classification).label).toBe('Commercial')
	})
})
