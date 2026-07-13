import { createDatabase, createMemoryDriver, createRelationManager } from '@src/core'
import { describe, expect, it } from 'vitest'
import { INTEGRATION_RELATIONS, INTEGRATION_TABLES } from '../../../setup.js'

// The relations factory — that `createRelationManager` wires up a working manager.
// The full Model / manager behavior is covered in Model.test.ts / RelationManager.test.ts;
// here we only assert the factory returns a usable, typed manager end to end, using
// the shared users/posts fixtures (tests/setup.ts).

describe('createRelationManager', () => {
	it('returns a working manager (typed model() accessor + a basic eager-load)', async () => {
		const db = createDatabase({ driver: createMemoryDriver(), tables: INTEGRATION_TABLES })
		await db.table('users').set({ id: 'u1', name: 'Ada', age: 36 })
		await db.table('posts').set([
			{ id: 'p1', author: 'u1', title: 'First' },
			{ id: 'p2', author: 'u1', title: 'Second' },
		])

		const manager = createRelationManager({ database: db, relations: INTEGRATION_RELATIONS })
		const users = manager.model('users')
		expect(users.name).toBe('users')

		const ada = await users.load('u1', { posts: true })
		expect(ada?.name).toBe('Ada')
		expect(Array.isArray(ada?.posts) ? ada?.posts.length : 0).toBe(2)
	})
})
