import { belongsTo, hasMany, hasMorph, hasOne, hasThrough, isRelationDescriptor } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('isRelationDescriptor', () => {
	it('accepts records, rejects strings and arrays', () => {
		expect(isRelationDescriptor({ column: 'x' })).toBe(true)
		expect(isRelationDescriptor(belongsTo('accountId'))).toBe(true)
		expect(isRelationDescriptor('x')).toBe(false)
		expect(isRelationDescriptor(['x'])).toBe(false)
	})

	it('accepts what every builder produces', () => {
		expect(isRelationDescriptor(belongsTo('classificationId', 'classifications'))).toBe(true)
		expect(isRelationDescriptor(hasMany('accountId'))).toBe(true)
		expect(isRelationDescriptor(hasOne('accountId', 'profiles'))).toBe(true)
		expect(isRelationDescriptor(hasThrough('accountReps', 'accountId', 'repId', 'reps'))).toBe(true)
		expect(isRelationDescriptor(hasMorph('entityId', 'entityType', 'account', 'notes'))).toBe(true)
	})

	it('accepts an empty record and one carrying a member it does not declare', () => {
		expect(isRelationDescriptor({})).toBe(true)
		expect(isRelationDescriptor({ column: 'accountId', comment: 'hand written' })).toBe(true)
	})

	it('refuses a member declared a string that holds another type', () => {
		expect(isRelationDescriptor({ column: 42 })).toBe(false)
		expect(isRelationDescriptor({ key: null })).toBe(false)
		expect(isRelationDescriptor({ through: 7, source: 'accountId', target: 'repId' })).toBe(false)
		expect(isRelationDescriptor({ source: ['accountId'] })).toBe(false)
		expect(isRelationDescriptor({ target: {} })).toBe(false)
		expect(isRelationDescriptor({ tag: true })).toBe(false)
		expect(isRelationDescriptor({ label: 0 })).toBe(false)
		expect(isRelationDescriptor({ model: 3 })).toBe(false)
	})

	it('refuses a member present with an undefined value', () => {
		expect(isRelationDescriptor({ column: undefined })).toBe(false)
		expect(isRelationDescriptor({ relationship: undefined, key: 'accountId' })).toBe(false)
	})

	it('refuses a relationship outside the declared union', () => {
		expect(isRelationDescriptor({ relationship: 'sideways', column: 'accountId' })).toBe(false)
		expect(isRelationDescriptor({ relationship: 'belong', column: 'accountId' })).toBe(false)
		expect(isRelationDescriptor({ relationship: 3 })).toBe(false)
	})

	it('accepts every member of the relationship union', () => {
		expect(isRelationDescriptor({ relationship: 'belongs', column: 'accountId' })).toBe(true)
		expect(isRelationDescriptor({ relationship: 'many', key: 'accountId' })).toBe(true)
		expect(isRelationDescriptor({ relationship: 'one', key: 'accountId' })).toBe(true)
		expect(
			isRelationDescriptor({
				relationship: 'through',
				through: 'accountReps',
				source: 'accountId',
				target: 'repId',
			}),
		).toBe(true)
		expect(
			isRelationDescriptor({
				relationship: 'morph',
				key: 'entityId',
				tag: 'entityType',
				label: 'account',
			}),
		).toBe(true)
	})
})
