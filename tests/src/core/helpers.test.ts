import {
	belongsTo,
	computeLinkKey,
	countAttached,
	groupRows,
	hasMany,
	hasMorph,
	hasOne,
	hasThrough,
	indexRows,
	readRow,
	isRelationDescriptor,
	isRelationError,
	RelationError,
	resolveRelation,
	resolveRelationMap,
	validateRelationJunction,
	validateRelationTable,
} from '@src/core'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { FAULT_TEXT_LIMIT } from '@orkestrel/contract'
import { captureError, invokeUnchecked, readProperty } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { EntityRow, MANAGER_TABLES } from '../../setup.js'

describe('validateRelationTable', () => {
	it('resolves a declared target without performing a data operation', () => {
		const storage = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		expect(validateRelationTable(storage, 'accounts', 'contacts', 'contacts')).toBeUndefined()
		expect(storage.status).toBe('idle')
	})
	it.each([false, true])('translates a missing table with junction=%s', (junction) => {
		const storage = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		expect(() =>
			validateRelationTable(storage, 'accounts', 'contacts', 'missing', junction),
		).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				context: { model: 'accounts', relation: 'contacts', table: 'missing' },
				message: junction
					? "Relation accounts.contacts uses undeclared junction missing; declare it in the database's tables or correct the relation's through"
					: "Relation accounts.contacts targets undeclared table missing; declare it in the database's tables or correct the relation's model",
			}),
		)
	})
	it('propagates a closed root error without translating its code', async () => {
		const storage = createDatabase({ driver: createMemoryDriver(), tables: MANAGER_TABLES })
		await storage.close()
		expect(() => validateRelationTable(storage, 'accounts', 'contacts', 'contacts')).toThrow(
			expect.objectContaining({ code: 'CLOSED' }),
		)
	})
})

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

	// A relation map read from JSON or written in JavaScript reaches `resolveRelation` with members
	// the `Relation` type refuses at compile time, so these cases call it through
	// `invokeUnchecked`. Each value is one contract's lossless repairs would admit; the strict
	// guard refuses it instead, and the audit's faults name the member.
	it.each([
		[{ column: 42 }, { reason: 'type', path: ['column'], expected: 'string', received: '42' }],
		[
			{ relationship: ' belongs ', column: 'accountId' },
			{ reason: 'type', path: ['relationship'], expected: 'literal', received: '" belongs "' },
		],
		[
			{ key: 'accountId', column: undefined },
			{ reason: 'type', path: ['column'], expected: 'string', received: 'undefined' },
		],
	])('refuses %o rather than repairing it', (descriptor, fault) => {
		const error = captureError(() =>
			invokeUnchecked(undefined, resolveRelation, ['contacts', descriptor]),
		)
		expect(isRelationError(error)).toBe(true)
		expect(readProperty(error, 'code')).toBe('INVALID')
		expect(readProperty(readProperty(error, 'context'), 'faults')).toEqual([fault])
	})

	it('refuses a descriptor whose member holds the wrong type, through the guard', () => {
		expect(isRelationDescriptor({ through: 7, source: 's', target: 't' })).toBe(false)
		expect(isRelationDescriptor({ relationship: 'sideways', column: 'aId' })).toBe(false)
	})

	it('refuses a descriptor carrying a member it does not declare, naming the member', () => {
		const descriptor = { key: 'accountId', comment: 'hand written' }
		const error = captureError(() => resolveRelation('contacts', descriptor))
		expect(isRelationError(error)).toBe(true)
		expect(readProperty(error, 'code')).toBe('INVALID')
		expect(readProperty(error, 'message')).toBe(
			`Relation contacts: expected a column string, a [key] array, or a relation descriptor\ncomment: extra; this key is not declared, remove it or use a declared key: relationship, column, key, through, source, target, tag, label, model\nsend {"relationship"?: "belongs" | "many" | "one" | "through" | "morph", "column"?: string, "key"?: string, "through"?: string, "source"?: string, "target"?: string…`,
		)
		expect(readProperty(readProperty(error, 'context'), 'faults')).toEqual([
			{ reason: 'extra', path: ['comment'] },
		])
	})

	it('refuses a descriptor carrying a non-enumerable undeclared member as extra', () => {
		const descriptor = { column: 'accountId' }
		Object.defineProperty(descriptor, 'hidden', { value: 'x', enumerable: false })
		const error = captureError(() => resolveRelation('contacts', descriptor))
		expect(isRelationError(error)).toBe(true)
		expect(readProperty(error, 'code')).toBe('INVALID')
		expect(readProperty(readProperty(error, 'context'), 'faults')).toEqual([
			{ reason: 'extra', path: ['hidden'] },
		])
	})

	it('lists the relationship candidates when the relationship is outside the union', () => {
		const error = captureError(() =>
			invokeUnchecked(undefined, resolveRelation, ['contacts', { relationship: 'sideways' }]),
		)
		expect(readProperty(error, 'message')).toBe(
			`Relation contacts: expected a column string, a [key] array, or a relation descriptor\nrelationship: type; expected literal; received "sideways"; send one of "belongs", "many", "one", "through", "morph"\nsend {"relationship"?: "belongs" | "many" | "one" | "through" | "morph", "column"?: string, "key"?: string, "through"?: string, "source"?: string, "target"?: string…`,
		)
	})

	it('keeps a refusal naming several long undeclared members within the fault text bound', () => {
		const descriptor = Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [`member${index}${'x'.repeat(400)}`, index]),
		)
		const error = captureError(() =>
			invokeUnchecked(undefined, resolveRelation, ['contacts', descriptor]),
		)
		const message: string = readProperty(error, 'message')
		expect(
			message.startsWith(
				`Relation contacts: expected a column string, a [key] array, or a relation descriptor\n"member0x`,
			),
		).toBe(true)
		expect(message.length).toBeLessThanOrEqual(85 + FAULT_TEXT_LIMIT)
	})

	it('bounds a caller-supplied relation name in the refusal', () => {
		const error = captureError(() => resolveRelation(`a b${'x'.repeat(500)}`, {}))
		const message: string = readProperty(error, 'message')
		expect(message.startsWith('Relation "a b')).toBe(true)
		expect(message.length).toBeLessThan(260)
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

describe('validateRelationJunction', () => {
	const reps = resolveRelation('reps', hasThrough('accountReps', 'accountId', 'repId'))

	it('passes a junction keyed by a column of its own', () => {
		if (reps.relationship !== 'through') throw new Error('reps must resolve onto the through arm')
		expect(validateRelationJunction('accounts', reps, 'id')).toBeUndefined()
	})

	it.each([
		['source', 'accountId'],
		['target', 'repId'],
	])('refuses a junction keyed by its %s column', (role, column) => {
		if (reps.relationship !== 'through') throw new Error('reps must resolve onto the through arm')
		expect(() => validateRelationJunction('accounts', reps, column)).toThrow(
			expect.objectContaining({
				code: 'INVALID',
				message: `Relation accounts.reps keys its junction accountReps by its ${role} column ${column}; give the junction a separate text primary column, which link fills with computeLinkKey`,
				context: { model: 'accounts', relation: 'reps', table: 'accountReps', column },
			}),
		)
	})
})

describe('readRow', () => {
	it('returns a plain record row as given', () => {
		const row = { id: 'acc1' }
		expect(readRow('accounts', row)).toBe(row)
		const bare = Object.assign(Object.create(null), { id: 'acc1' })
		expect(readRow('accounts', bare)).toBe(bare)
	})

	it.each([new EntityRow({ id: 'acc1' }), ['acc1'], 'acc1', null, 42])(
		'refuses %o with INVALID naming the table',
		(row) => {
			expect(() => readRow('accounts', row)).toThrow(
				expect.objectContaining({
					code: 'INVALID',
					message:
						'Table accounts returned a row that is not a plain record; a storage must return plain record rows',
					context: { table: 'accounts' },
				}),
			)
		},
	)
})

describe('computeLinkKey', () => {
	it('derives the JSON text of the pair', () => {
		expect(computeLinkKey('acc1', 'rep1')).toBe('["acc1","rep1"]')
		expect(JSON.parse(computeLinkKey('acc1', 'rep1'))).toEqual(['acc1', 'rep1'])
	})

	it('keeps the order of the pair and a string key apart from the number it spells', () => {
		expect(computeLinkKey('rep1', 'acc1')).not.toBe(computeLinkKey('acc1', 'rep1'))
		expect(computeLinkKey(1, 'rep1')).not.toBe(computeLinkKey('1', 'rep1'))
	})

	it('keeps a key carrying the separator apart from a split pair', () => {
		expect(computeLinkKey('a","b', 'c')).not.toBe(computeLinkKey('a', 'b","c'))
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
	it('indexes by raw keys while attaching distinct positional values', () => {
		const raw = [{ id: 'r1' }, { id: 'r2' }]
		const values = [
			{ id: 'shadow', label: 'First' },
			{ id: 'shadow', label: 'Second' },
		]
		const indexed = indexRows(raw, 'id', values)
		expect(indexed.get('r1')).toBe(values[0])
		expect(indexed.get('r2')).toBe(values[1])
		expect(indexed.has('shadow')).toBe(false)
		expect(raw).toEqual([{ id: 'r1' }, { id: 'r2' }])
	})
	it('omits missing values and ignores values without a raw row', () => {
		expect(indexRows([{ id: 'r1' }], 'id', []).size).toBe(0)
		expect(indexRows([], 'id', [{ id: 'r1' }]).size).toBe(0)
	})
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
	it('groups by raw keys while attaching distinct positional values in order', () => {
		const raw = [{ author: 'u1' }, { author: 'u2' }, { author: 'u1' }]
		const values = [
			{ author: 'shadow', id: 'p1' },
			{ author: 'shadow', id: 'p2' },
			{ author: 'shadow', id: 'p3' },
		]
		const grouped = groupRows(raw, 'author', values)
		expect(grouped.get('u1')).toEqual([values[0], values[2]])
		expect(grouped.get('u2')).toEqual([values[1]])
		expect(grouped.has('shadow')).toBe(false)
		expect(raw).toEqual([{ author: 'u1' }, { author: 'u2' }, { author: 'u1' }])
	})
	it('omits missing values and ignores values without a raw row', () => {
		expect(groupRows([{ author: 'u1' }], 'author', []).size).toBe(0)
		expect(groupRows([], 'author', [{ author: 'u1' }]).size).toBe(0)
	})
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
