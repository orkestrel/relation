import { RelationError, isRelationError } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('isRelationError', () => {
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
