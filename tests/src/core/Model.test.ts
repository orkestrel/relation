import { belongsTo, createRelationManager, hasMany, hasMorph, hasOne, hasThrough } from '@src/core'
import type { Row } from '@orkestrel/database'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { isArray, isRecord, stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import { createRecorder, recordEmitterEvents } from '../../setup.js'

// `Model` behavior — the relation-aware half of the relations layer: `load` /
// `find` populating each relation kind (batched, no N+1), nested `includes`, the
// loaded relation accessors, and `link` / `unlink` / `links` junction management.
// The manager-level surface (`model()` accessor, registry counts) lives in
// RelationManager.test.ts. Uses a real memory-backed relational scenario covering
// all five relation kinds (no mocks, AGENTS §16).

// Narrow the loose `Loaded` relation properties for assertions (no `as`).
function rows(value: unknown): readonly Row[] {
	return isArray(value) ? value.filter(isRecord) : []
}
function one(value: unknown): Row {
	return isRecord(value) ? value : {}
}

async function setup() {
	const db = createDatabase({
		driver: createMemoryDriver(),
		// `accountReps` junction rows are written by `Model.link` without an `id` —
		// a key factory mints one (the accounts / contacts / etc. tables always pass
		// an explicit `id`, so this only ever fires for the junction table).
		key: () => crypto.randomUUID(),
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

describe('Model — load (relation kinds)', () => {
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
		const page = await accounts.find({ contacts: true }, { sort: 'name', direction: 'ascending' })
		expect(page.map((a) => a.name)).toEqual(['Acme', 'Beta'])
		expect(rows(page[0]?.contacts)).toHaveLength(2) // Acme
		expect(rows(page[1]?.contacts)).toHaveLength(0) // Beta
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
})

// ── Emitter — the PUSH observation surface (AGENTS §13) ──────────────────────
//
// A Model exposes a typed `emitter` (`ModelEventMap`) carrying its eager-load + junction
// moments — `load` (a relation resolved: its name + the count of related rows attached
// across the whole record set), `link` / `unlink` (a junction row written) — for
// fire-and-forget observers. Every event is emitted directly; the emitter isolates a listener
// throw (it can never escape into the batched eager-load, AGENTS §13), and every emit sits
// AFTER the load resolves / the junction op completes. A Model is reached through the
// RelationManager, which does not thread an `error` handler to it, so a listener throw is
// swallowed silently. These pin: `load` fires ONCE per relation (not per record — no N+1 in
// the events) with the attached count; `link` / `unlink` carry the owning key + relation; and
// the emit-safety guarantee — a throwing observer cannot corrupt the load result.

// The ModelEventMap event names recorded across the emitter tests — fed to the shared
// `recordEmitterEvents` (AGENTS §16.1: the per-event wiring is centralized; this file
// keeps only the names its scenarios observe).
const MODEL_EVENTS = ['load', 'link', 'unlink'] as const

describe('Model — emitter (push observation surface)', () => {
	it('fires load once per relation with the count of rows attached across the record set', async () => {
		const { accounts } = await setup()
		const events = recordEmitterEvents(accounts.emitter, MODEL_EVENTS)
		await accounts.load('acc1', { contacts: true, classification: true })
		// One `load` per relation (NOT per record): acc1 has 2 contacts, 1 classification.
		expect([...events.load.calls].sort()).toEqual([
			['classification', 1],
			['contacts', 2],
		])
	})

	it('counts the total attached across a batch / find (one event per relation, not per record)', async () => {
		const { accounts } = await setup()
		const events = recordEmitterEvents(accounts.emitter, MODEL_EVENTS)
		// find loads both accounts; acc1 has 2 contacts, acc2 has 0 → 2 attached, ONE `load`.
		await accounts.find({ contacts: true })
		expect(events.load.calls).toEqual([['contacts', 2]])
	})

	it('a nested include fires load for the nested relation too', async () => {
		const { accounts } = await setup()
		const events = recordEmitterEvents(accounts.emitter, MODEL_EVENTS)
		await accounts.load('acc1', { contacts: { account: true } })
		// `contacts` (2 attached) at the top; nested `account` resolves for the 2 contacts → 2.
		expect([...events.load.calls].sort()).toEqual([
			['account', 2],
			['contacts', 2],
		])
	})

	it('fires link then unlink carrying the owning key + relation', async () => {
		const { accounts } = await setup()
		const events = recordEmitterEvents(accounts.emitter, MODEL_EVENTS)
		await accounts.link('acc1', 'reps', 'rep3')
		await accounts.unlink('acc1', 'reps', 'rep1')
		expect(events.link.calls).toEqual([['acc1', 'reps']])
		expect(events.unlink.calls).toEqual([['acc1', 'reps']])
	})

	it('wires initial listeners through the model handle', async () => {
		const { accounts } = await setup()
		const load = createRecorder<[name: string, count: number]>()
		accounts.emitter.on('load', load.handler)
		await accounts.load('acc1', { profile: true })
		expect(load.calls).toEqual([['profile', 1]])
	})

	it('EMIT SAFETY: a throwing load listener cannot corrupt the loaded result (the emitter isolates it)', async () => {
		const { accounts } = await setup()
		accounts.emitter.on('load', () => {
			throw new Error('load observer blew up')
		})
		// THE LOAD-BEARING ASSERTION: the eager-load still resolves correctly despite the throw
		// (the emitter isolated it — a Model reached via the RelationManager has no `error`
		// handler, so it is swallowed silently — and it never escaped).
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
