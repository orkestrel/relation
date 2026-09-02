import {
	belongsTo,
	countAttached,
	hasMany,
	hasMorph,
	hasOne,
	hasThrough,
	readColumn,
	RelationError,
	resolveRelation,
	resolveRelationMap,
} from '@src/core'
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
