import type { Row, TableSchema } from '@orkestrel/database'
import { compileGuard } from '@orkestrel/contract'
import { createMemoryDriver, shapeToColumnStorage } from '@orkestrel/database'
import { describe, expect, it } from 'vitest'
import { FaultDriver, INTEGRATION_RELATIONS, INTEGRATION_TABLES } from './setup.js'

// The base test setup module's proof (`tests/setup.ts`). Its subject is the exported test
// infrastructure the workspace's suites rely on — the fixture shape maps and the
// fault-injecting driver boundary — never the relation behavior those suites assert.
// `tests/setup.ts` is host-independent, so every contract here is reachable from the
// Node-hosted `setup` project.
//
// Each expectation arrives by a route `tests/setup.ts` does not share: a column's contract
// is read back through the compiled guard rather than through the shape builder that
// declared it, and every driver assertion reads the WRAPPED driver directly so nothing the
// wrapper holds itself can satisfy it.

/** Derive the real driver schema the fixture table map declares. */
function buildFixtureSchema(): readonly TableSchema[] {
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

/** Open a real memory driver over the fixture schema. */
async function openFixtureDriver() {
	const driver = createMemoryDriver()
	await driver.open(buildFixtureSchema())
	return driver
}

describe('INTEGRATION_TABLES', () => {
	it('admits the fixture row values the consuming suites write', () => {
		const { age, id, name } = INTEGRATION_TABLES.users
		const { author, title } = INTEGRATION_TABLES.posts
		expect(compileGuard(id)('u1')).toBe(true)
		expect(compileGuard(name)('Ada')).toBe(true)
		expect(compileGuard(age)(36)).toBe(true)
		expect(compileGuard(author)('u1')).toBe(true)
		expect(compileGuard(title)('First')).toBe(true)
	})

	it('refuses a value of the wrong column type', () => {
		const { age, id } = INTEGRATION_TABLES.users
		expect(compileGuard(id)(1)).toBe(false)
		expect(compileGuard(age)('36')).toBe(false)
		expect(compileGuard(age)(36.5)).toBe(false)
	})

	it('declares a schema a real driver opens and stores rows against', async () => {
		const driver = await openFixtureDriver()
		await driver.insert('users', 'u1', { id: 'u1', name: 'Ada', age: 36 })
		await driver.insert('posts', 'p1', { id: 'p1', author: 'u1', title: 'First' })
		expect(await driver.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada', age: 36 })
		expect(await driver.keys('posts')).toEqual(['p1'])
		await driver.close()
	})
})

describe('INTEGRATION_RELATIONS', () => {
	it('declares the users to posts relation the consuming suites load', () => {
		expect(Object.keys(INTEGRATION_RELATIONS.users ?? {})).toContain('posts')
	})

	it('keys that relation on a posts column matching the users primary key', () => {
		const relation = INTEGRATION_RELATIONS.users?.posts
		if (relation === undefined || typeof relation !== 'object' || !('key' in relation)) {
			throw new Error('the users to posts relation must be a keyed descriptor')
		}
		// The target table defaults to the relation name, so `posts` carries the foreign key.
		expect(relation.model).toBeUndefined()
		const column = Object.entries(INTEGRATION_TABLES.posts).find(([name]) => name === relation.key)
		if (column === undefined) throw new Error(`posts declares no ${String(relation.key)} column`)
		const [, shape] = column
		expect(shapeToColumnStorage(shape)).toBe(shapeToColumnStorage(INTEGRATION_TABLES.users.id))
	})
})

describe('FaultDriver', () => {
	it('forwards every operation other than delete to the wrapped driver', async () => {
		const inner = await openFixtureDriver()
		const faulted = new FaultDriver(inner, 1)
		await faulted.insert('users', 'u1', { id: 'u1', name: 'Ada', age: 36 })
		await faulted.write('posts', 'p1', { id: 'p1', author: 'u1', title: 'First' })
		expect(await inner.read('users', 'u1')).toEqual({ id: 'u1', name: 'Ada', age: 36 })
		expect(await inner.keys('posts')).toEqual(['p1'])
		expect(await faulted.read('posts', 'p1')).toEqual({
			id: 'p1',
			author: 'u1',
			title: 'First',
		})
		expect(await faulted.keys('users')).toEqual(['u1'])
		const scanned: Row[] = []
		for await (const row of faulted.scan('posts')) {
			scanned.push(row)
		}
		expect(scanned).toEqual([{ id: 'p1', author: 'u1', title: 'First' }])
		const restore = await faulted.snapshot(['users'])
		await faulted.clear('users')
		expect(await inner.keys('users')).toEqual([])
		await restore()
		expect(await inner.keys('users')).toEqual(['u1'])
		await faulted.close()
	})

	it('forwards each delete before the configured one and removes the row', async () => {
		const inner = await openFixtureDriver()
		await inner.insert('posts', 'p1', { id: 'p1', author: 'u1', title: 'First' })
		await inner.insert('posts', 'p2', { id: 'p2', author: 'u1', title: 'Second' })
		const faulted = new FaultDriver(inner, 3)
		expect(await faulted.delete('posts', 'p1')).toBe(true)
		expect(await faulted.delete('posts', 'p2')).toBe(true)
		expect(await inner.keys('posts')).toEqual([])
		await faulted.close()
	})

	it('fails the configured delete and every later one, leaving the targeted rows', async () => {
		const inner = await openFixtureDriver()
		await inner.insert('posts', 'p1', { id: 'p1', author: 'u1', title: 'First' })
		await inner.insert('posts', 'p2', { id: 'p2', author: 'u1', title: 'Second' })
		await inner.insert('posts', 'p3', { id: 'p3', author: 'u1', title: 'Third' })
		const faulted = new FaultDriver(inner, 2)
		expect(await faulted.delete('posts', 'p1')).toBe(true)
		// The fault throws synchronously rather than rejecting. A suite driving the wrapper
		// through the database meets it as a rejection because the database awaits the call
		// inside its own async stack.
		expect(() => faulted.delete('posts', 'p2')).toThrow('FaultDriver delete failure')
		expect(() => faulted.delete('posts', 'p3')).toThrow('FaultDriver delete failure')
		expect(await inner.keys('posts')).toEqual(['p2', 'p3'])
		await faulted.close()
	})
})
