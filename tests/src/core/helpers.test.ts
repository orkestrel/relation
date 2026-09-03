import {
	belongsTo,
	countAttached,
	groupRows,
	hasMany,
	hasMorph,
	hasOne,
	hasThrough,
	indexRows,
	isRelationDescriptor,
	isRelationError,
	readColumn,
	RelationError,
	resolveRelation,
	resolveRelationMap,
} from '@src/core'
import { captureError, readProperty } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'

describe('resolveRelation — shorthand', () => {
	it('resolves a string to belongs', () => {
		expect(resolveRelation('account', 'accountId')).toEqual({
			relationship: 'belongs',
			name: 'account',
			model: 'account',
			column: 'accountId',
		})
	})

	it('resolves a string array to many', () => {
		expect(resolveRelation('contacts', ['accountId'])).toEqual({
			relationship: 'many',
			name: 'contacts',
			model: 'contacts',
			key: 'accountId',
		})
	})
})

describe('resolveRelation — builders', () => {
	it('belongsTo / hasMany / hasOne carry an explicit relationship', () => {
		expect(
			resolveRelation('classification', belongsTo('classificationId', 'classifications')),
		).toEqual({
			relationship: 'belongs',
			name: 'classification',
			model: 'classifications',
			column: 'classificationId',
		})
		// hasMany and hasOne are distinguished by `relationship` (both would be `{ key }` otherwise).
		expect(resolveRelation('contacts', hasMany('accountId')).relationship).toBe('many')
		expect(resolveRelation('profile', hasOne('accountId', 'profiles'))).toEqual({
			relationship: 'one',
			name: 'profile',
			model: 'profiles',
			key: 'accountId',
		})
	})

	it('hasThrough / hasMorph carry their fields', () => {
		expect(
			resolveRelation('reps', hasThrough('accountReps', 'accountId', 'repId', 'reps')),
		).toEqual({
			relationship: 'through',
			name: 'reps',
			model: 'reps',
			through: 'accountReps',
			source: 'accountId',
			target: 'repId',
		})
		expect(
			resolveRelation('notes', hasMorph('entityId', 'entityType', 'account', 'notes')),
		).toEqual({
			relationship: 'morph',
			name: 'notes',
			model: 'notes',
			key: 'entityId',
			tag: 'entityType',
			label: 'account',
		})
	})

	it('defaults the target model to the relation name when a builder omits it', () => {
		expect(resolveRelation('reps', hasThrough('accountReps', 'accountId', 'repId'))).toEqual({
			relationship: 'through',
			name: 'reps',
			model: 'reps',
			through: 'accountReps',
			source: 'accountId',
			target: 'repId',
		})
	})
})

describe('resolveRelation — raw descriptor inference', () => {
	it('infers the relationship from fields when none is set', () => {
		expect(resolveRelation('a', { column: 'aId' }).relationship).toBe('belongs')
		expect(resolveRelation('b', { key: 'bId' }).relationship).toBe('one')
		expect(resolveRelation('c', { through: 'j', source: 's', target: 't' }).relationship).toBe(
			'through',
		)
		expect(resolveRelation('d', { key: 'k', tag: 'tag', label: 'l' }).relationship).toBe('morph')
	})

	it('throws INVALID on an unresolvable value', () => {
		expect(() => resolveRelation('x', [])).toThrow(RelationError)
		expect(() => resolveRelation('x', {})).toThrow(RelationError)
		// missing required fields for the declared relationship
		expect(() => resolveRelation('x', { relationship: 'through', through: 'j' })).toThrow(
			RelationError,
		)
	})

	// A relation map read from JSON is where a wrong-typed member arrives, and it is the reach
	// `isRelationDescriptor` guards: a number `column` resolved as a `belongs` would produce a
	// `ResolvedBelongs` whose `column` is declared a string, and the load would silently attach
	// nothing instead of reporting the malformed definition. No literal typed `Relation` can hold a
	// wrong-typed member — the type checker refuses it — so a parsed value never reaches
	// `resolveRelation` at all; the guard's refusal is the proof.
	it('refuses a descriptor whose member holds the wrong type', () => {
		const column: unknown = JSON.parse('{"column": 42}')
		const through: unknown = JSON.parse('{"through": 7, "source": "s", "target": "t"}')
		const relationship: unknown = JSON.parse('{"relationship": "sideways", "column": "aId"}')
		expect(isRelationDescriptor(column)).toBe(false)
		expect(isRelationDescriptor(through)).toBe(false)
		expect(isRelationDescriptor(relationship)).toBe(false)
	})

	it('reports INVALID as the code of the error an unresolvable descriptor throws', () => {
		const error = captureError(() => resolveRelation('a', {}))
		expect(isRelationError(error)).toBe(true)
		expect(readProperty(error, 'code')).toBe('INVALID')
	})
})

describe('resolveRelationMap', () => {
	it('resolves every entry by name', () => {
		const map = resolveRelationMap({
			contacts: hasMany('accountId'),
			classification: belongsTo('classificationId', 'classifications'),
		})
		expect([...map.keys()].sort()).toEqual(['classification', 'contacts'])
		expect(map.get('contacts')?.relationship).toBe('many')
		expect(map.get('classification')?.model).toBe('classifications')
	})
})

describe('readColumn', () => {
	it('projects a column off a record', () => {
		expect(readColumn({ accountId: 'acc1' }, 'accountId')).toBe('acc1')
	})

	it('reads a missing column and a non-object as undefined', () => {
		expect(readColumn({ accountId: 'acc1' }, 'missing')).toBeUndefined()
		expect(readColumn(null, 'accountId')).toBeUndefined()
		expect(readColumn('acc1', 'accountId')).toBeUndefined()
		expect(readColumn(undefined, 'accountId')).toBeUndefined()
	})
})

describe('countAttached', () => {
	it('sums array lengths and counts each present single row', () => {
		expect(countAttached([[{ id: 'p1' }, { id: 'p2' }], undefined, { id: 'p3' }])).toBe(3)
	})

	it('counts an empty set and empty arrays as zero', () => {
		expect(countAttached([])).toBe(0)
		expect(countAttached([[], [], undefined])).toBe(0)
	})
})

describe('indexRows', () => {
	it('keys each row by the string form of its column', () => {
		const index = indexRows([{ id: 'r1' }, { id: 'r2' }], 'id')
		expect([...index.keys()].sort()).toEqual(['r1', 'r2'])
		expect(index.get('r1')).toEqual({ id: 'r1' })
		expect(index.get('missing')).toBeUndefined()
	})

	it('stringifies a numeric key so it meets its string form', () => {
		expect(indexRows([{ id: 7 }], 'id').get('7')).toEqual({ id: 7 })
	})

	it('indexes an empty row set as an empty map', () => {
		expect(indexRows([], 'id').size).toBe(0)
	})

	it('keeps the last row when a key repeats', () => {
		const index = indexRows(
			[
				{ id: 'r1', rank: 1 },
				{ id: 'r1', rank: 2 },
			],
			'id',
		)
		expect(index.size).toBe(1)
		expect(index.get('r1')).toEqual({ id: 'r1', rank: 2 })
	})

	it('indexes a row missing the column under the undefined string', () => {
		const index = indexRows([{ other: 'x' }], 'id')
		expect(index.get('undefined')).toEqual({ other: 'x' })
	})
})

describe('groupRows', () => {
	it('collects every row sharing a key, in input order', () => {
		const groups = groupRows(
			[
				{ id: 'p1', author: 'u1' },
				{ id: 'p2', author: 'u2' },
				{ id: 'p3', author: 'u1' },
			],
			'author',
		)
		expect(groups.get('u1')?.map((row) => row.id)).toEqual(['p1', 'p3'])
		expect(groups.get('u2')?.map((row) => row.id)).toEqual(['p2'])
	})

	it('stringifies a numeric key so it meets its string form', () => {
		expect(groupRows([{ author: 7 }], 'author').get('7')).toHaveLength(1)
	})

	it('groups an empty row set as an empty map', () => {
		expect(groupRows([], 'author').size).toBe(0)
	})

	it('reports a key no row carries as undefined rather than an empty group', () => {
		expect(groupRows([{ author: 'u1' }], 'author').get('u2')).toBeUndefined()
	})

	it('groups a row missing the column under the undefined string', () => {
		expect(groupRows([{ other: 'x' }], 'author').get('undefined')).toHaveLength(1)
	})
})
