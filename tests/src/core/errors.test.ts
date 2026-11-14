import { RelationError, isRelationError } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('isRelationError', () => {
	// The guard reads the global `Error` contract captured at load, so a later replacement of the
	// global moves neither the instance check nor the `Error.prototype` comparison.
	it('reads the global Error captured at load, not the live global', () => {
		const error = new RelationError('INVALID', 'Relation contacts: a many relation needs key')
		const plain = Object.assign(new Error('Relation contacts: a many relation needs key'), {
			code: 'INVALID',
		})
		const original = globalThis.Error
		try {
			Reflect.set(globalThis, 'Error', RangeError)
			expect(isRelationError(error)).toBe(true)
			expect(isRelationError(plain)).toBe(false)
			Reflect.set(globalThis, 'Error', RelationError)
			expect(isRelationError(error)).toBe(true)
			expect(isRelationError(plain)).toBe(false)
		} finally {
			Reflect.set(globalThis, 'Error', original)
		}
		expect(globalThis.Error).toBe(original)
	})

	it('accepts a class-instance context', () => {
		class Context {
			readonly [key: string]: unknown
			readonly offset = 8
		}

		const context: Readonly<Record<string, unknown>> = new Context()
		const error = new RelationError('INVALID', 'failure', context)
		expect(isRelationError(error)).toBe(true)
	})

	it('accepts a callable context', () => {
		const members: Readonly<Record<string, unknown>> = { offset: 8 }
		const context = Object.assign(() => undefined, members)
		const error = new RelationError('INVALID', 'failure', context)
		expect(isRelationError(error)).toBe(true)
	})
})
