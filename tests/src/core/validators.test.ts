import { belongsTo, isRelationDescriptor } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('isRelationDescriptor', () => {
	it('accepts records, rejects strings and arrays', () => {
		expect(isRelationDescriptor({ column: 'x' })).toBe(true)
		expect(isRelationDescriptor(belongsTo('accountId'))).toBe(true)
		expect(isRelationDescriptor('x')).toBe(false)
		expect(isRelationDescriptor(['x'])).toBe(false)
	})
})
