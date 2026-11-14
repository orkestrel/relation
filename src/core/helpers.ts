import type {
	Relation,
	RelationDescriptor,
	RelationMap,
	Relationship,
	ResolvedRelation,
	ResolvedThrough,
} from './types.js'
import type { DatabaseStorageInterface, Key, Row } from '@orkestrel/database'
import { isDatabaseError } from '@orkestrel/database'
import {
	admitValue,
	describeFaults,
	isArray,
	isDefined,
	isFailure,
	isRecord,
	isString,
	renderPath,
	resolveField,
} from '@orkestrel/contract'
import { relationDescriptorContract } from './contracts.js'
import { RelationError } from './errors.js'

// Resolve raw relation values into the flat `ResolvedRelation` form once, at
// define-time, so no inference runs during loading. The builders in this file set
// an explicit `relationship`; hand-written descriptors fall back to field inference.

// === Resolution

/**
 * Validates a relation table through its bound storage, translating only an undeclared table.
 *
 * @param storage - The storage that resolves the table
 * @param model - The owning model's name
 * @param relation - The relation's name
 * @param table - The target or junction table's name
 * @param junction - If `true`, reports an undeclared junction; if `false`, reports an undeclared target. Default: `false`.
 * @throws An `INVALID` {@link RelationError} for an undeclared table; every other storage error propagates unchanged.
 *
 * @example
 * ```ts
 * validateRelationTable(storage, 'accounts', 'contacts', 'contacts')
 * ```
 */
export function validateRelationTable(
	storage: DatabaseStorageInterface,
	model: string,
	relation: string,
	table: string,
	junction = false,
): void {
	try {
		storage.table(table)
	} catch (error) {
		if (!isDatabaseError(error) || error.code !== 'NOT_FOUND') throw error
		throw new RelationError(
			'INVALID',
			junction
				? `Relation ${renderPath([model, relation])} uses undeclared junction ${renderPath([table])}; declare it in the database's tables or correct the relation's through`
				: `Relation ${renderPath([model, relation])} targets undeclared table ${renderPath([table])}; declare it in the database's tables or correct the relation's model`,
			{ model, relation, table },
		)
	}
}

/**
 * Validates that a `through` relation's junction keys its rows by a column of its own.
 *
 * @remarks
 * `link` writes the pair's `computeLinkKey` into the junction's primary column, so a junction
 * whose primary column is the relation's `source` or `target` column cannot hold that key.
 *
 * @param model - The owning model's name
 * @param resolved - The resolved `through` relation
 * @param primary - The junction table's primary-key column
 * @throws An `INVALID` {@link RelationError} when `primary` is the relation's `source` or
 *   `target` column
 *
 * @example
 * ```ts
 * validateRelationJunction('accounts', resolved, 'id') // a junction keyed by `id` passes
 * ```
 */
export function validateRelationJunction(
	model: string,
	resolved: ResolvedThrough,
	primary: string,
): void {
	const role =
		primary === resolved.source ? 'source' : primary === resolved.target ? 'target' : undefined
	if (role === undefined) return
	throw new RelationError(
		'INVALID',
		`Relation ${renderPath([model, resolved.name])} keys its junction ${renderPath([resolved.through])} by its ${role} column ${renderPath([primary])}; give the junction a separate text primary column, which link fills with computeLinkKey`,
		{ model, relation: resolved.name, table: resolved.through, column: primary },
	)
}

/**
 * Reads one row a storage returned, refusing a value that is not a plain record.
 *
 * @remarks
 * Contract's `isRecord` decides, so a class instance, an array, or a primitive that a custom
 * `DatabaseStorageInterface` returns raises rather than reading as a miss or dropping.
 *
 * @param table - The table the row came from
 * @param row - The row as the storage returned it
 * @returns The row, narrowed to a record
 * @throws An `INVALID` {@link RelationError} naming `table` when `row` is not a plain record
 *
 * @example
 * ```ts
 * readRow('accounts', { id: 'acc1' }) // { id: 'acc1' }
 * ```
 */
export function readRow<T>(table: string, row: T): T & Row {
	if (isRecord(row)) return row
	throw new RelationError(
		'INVALID',
		`Table ${renderPath([table])} returned a row that is not a plain record; a storage must return plain record rows`,
		{ table },
	)
}

/**
 * Resolves one raw {@link Relation} value into a flat {@link ResolvedRelation}.
 *
 * @remarks
 * A `string` is a `belongs` (foreign-key column on this table); a `readonly string[]`
 * is a `many` (foreign-key column on the related table); a {@link RelationDescriptor}
 * uses its explicit `relationship`, or infers it from the fields present. The target
 * model defaults to the relation name. A descriptor must pass `relationDescriptorContract`'s
 * strict guard: an undeclared member, enumerable or not, a member holding another type, and
 * a member present as `undefined` each refuse it, and no lossless repair admits it. The
 * refusal carries the contract's audit faults, described against its schema. Every column the resolved arm declares is validated here, which is
 * what lets each arm declare its columns required.
 *
 * @param name - The relation name (its key in the {@link RelationMap})
 * @param value - The raw relation value
 * @returns The resolved relation, on the arm its `relationship` names
 * @throws An `INVALID` {@link RelationError} when the relationship cannot be resolved, when the
 *   descriptor fails its contract (the faults ride on `context.faults`), or when a column the
 *   resolved arm declares is missing
 *
 * @example
 * ```ts
 * resolveRelation('classification', belongsTo('classificationId', 'classifications')).relationship // 'belongs'
 * ```
 */
export function resolveRelation(name: string, value: Relation): ResolvedRelation {
	if (isString(value)) {
		return { relationship: 'belongs', name, model: name, column: value }
	}
	const path = renderPath([name])
	if (isArray(value)) {
		const key = value[0]
		if (!isString(key)) {
			throw new RelationError(
				'INVALID',
				`Relation ${path}: the array form needs a foreign-key column string first, such as ['accountId']`,
				{ relation: name },
			)
		}
		return { relationship: 'many', name, model: name, key }
	}
	const admitted = admitValue(relationDescriptorContract, value)
	if (isFailure(admitted)) {
		const faults = admitted.error.faults
		throw new RelationError(
			'INVALID',
			`Relation ${path}: expected a column string, a [key] array, or a relation descriptor\n${describeFaults(faults, relationDescriptorContract.schema)}`,
			{ relation: name, faults },
		)
	}
	const descriptor = admitted.value
	const model = descriptor.model ?? name
	// Inferred from the fields present when no explicit `relationship` is set.
	const relationship: Relationship | undefined =
		descriptor.relationship !== undefined
			? descriptor.relationship
			: isDefined(descriptor.through)
				? 'through'
				: isDefined(descriptor.tag)
					? 'morph'
					: isDefined(descriptor.column)
						? 'belongs'
						: isDefined(descriptor.key)
							? 'one'
							: undefined
	if (relationship === undefined) {
		throw new RelationError(
			'INVALID',
			`Relation ${path}: cannot infer the relationship; set relationship, or give column (belongs), key (one), through (through), or tag (morph)`,
			{ relation: name },
		)
	}

	switch (relationship) {
		case 'belongs': {
			const column = descriptor.column
			if (column === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation ${path}: a belongs relation needs column; build it with belongsTo(column)`,
					{ relation: name },
				)
			}
			return { relationship, name, model, column }
		}
		case 'many': {
			const key = descriptor.key
			if (key === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation ${path}: a many relation needs key; build it with hasMany(key)`,
					{ relation: name },
				)
			}
			return { relationship, name, model, key }
		}
		case 'one': {
			const key = descriptor.key
			if (key === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation ${path}: a one relation needs key; build it with hasOne(key)`,
					{ relation: name },
				)
			}
			return { relationship, name, model, key }
		}
		case 'through': {
			const { through, source, target } = descriptor
			if (through === undefined || source === undefined || target === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation ${path}: a through relation needs through, source, and target; build it with hasThrough(through, source, target)`,
					{ relation: name },
				)
			}
			return { relationship, name, model, through, source, target }
		}
		case 'morph': {
			const { key, tag, label } = descriptor
			if (key === undefined || tag === undefined || label === undefined) {
				throw new RelationError(
					'INVALID',
					`Relation ${path}: a morph relation needs key, tag, and label; build it with hasMorph(key, tag, label)`,
					{ relation: name },
				)
			}
			return { relationship, name, model, key, tag, label }
		}
	}
}

/**
 * Resolves every entry of a {@link RelationMap} into a name → {@link ResolvedRelation} map.
 *
 * @param relations - The raw relation map
 * @returns A map keyed by relation name
 */
export function resolveRelationMap(relations: RelationMap): ReadonlyMap<string, ResolvedRelation> {
	return new Map(
		Object.entries(relations).map(([name, value]) => [name, resolveRelation(name, value)]),
	)
}

// === Row projection

/**
 * Computes the junction row's primary key for one pair of a `through` relation.
 *
 * @remarks
 * The key is the JSON text of `[key, target]`, so each pair has one key and a string key
 * stays apart from the number it spells. `link` inserts under this key and `unlink` removes
 * it, which is why a junction's primary column must store text.
 *
 * @param key - The owning record's primary key
 * @param target - The related record's primary key
 * @returns The pair's junction key
 *
 * @example
 * ```ts
 * computeLinkKey('acc1', 'rep1') // '["acc1","rep1"]'
 * ```
 */
export function computeLinkKey(key: Key, target: Key): string {
	return JSON.stringify([key, target])
}

/**
 * Counts the related rows one relation attached across a record set.
 *
 * @remarks
 * An array-valued relation (`many` / `through` / `morph`) sums its lengths; a
 * single-valued one (`belongs` / `one`) counts each present row. This is the count a
 * `Model` carries on its `load` event.
 *
 * @param values - One relation's loaded value per record
 * @returns The total related rows attached across the set
 *
 * @example
 * ```ts
 * countAttached([[{ id: 'p1' }, { id: 'p2' }], undefined, { id: 'p3' }]) // 3
 * ```
 */
export function countAttached(values: ReadonlyArray<Row | readonly Row[] | undefined>): number {
	return Iterator.from(values).reduce(
		(total, value) => total + (isArray(value) ? value.length : value === undefined ? 0 : 1),
		0,
	)
}

/**
 * Indexes rows by the string form of one column, for keyed lookups.
 *
 * @remarks
 * The column is read with `resolveField` and its value stringified, so a numeric
 * and a string foreign key meet at the same entry. A later row with a key an earlier
 * row already holds replaces it, and a row missing the column indexes under the string
 * `'undefined'`. This is the projection a `belongs` load and a `through` load use to
 * attach one related row per key.
 * Optional `values` supply the attached rows by position; keys always come from `rows`.
 *
 * @param rows - The rows to index
 * @param column - The column to key on
 * @param values - The rows to attach by position. Default: `rows`. Missing positions are omitted.
 * @returns A read-only map from each key's string form to its row
 *
 * @example
 * ```ts
 * indexRows([{ id: 'r1' }, { id: 'r2' }], 'id').get('r1') // { id: 'r1' }
 * ```
 */
export function indexRows(
	rows: readonly Row[],
	column: string,
	values: readonly Row[] = rows,
): ReadonlyMap<string, Row> {
	return new Map(
		Iterator.from(rows).flatMap((row, index): ReadonlyArray<readonly [string, Row]> => {
			const value = values[index]
			return value === undefined ? [] : [[String(resolveField(row, column)), value]]
		}),
	)
}

/**
 * Groups rows by the string form of one column, for one-to-many lookups.
 *
 * @remarks
 * The column is read with `resolveField` and its value stringified, so a numeric
 * and a string foreign key meet at the same group. Rows keep their input order inside
 * a group, a key no row carries is absent rather than empty, and a row missing the
 * column groups under the string `'undefined'`. This is the projection a `many` load
 * and a `morph` load use to attach every related row per key.
 * Optional `values` supply the attached rows by position; keys always come from `rows`.
 *
 * @param rows - The rows to group
 * @param column - The column to key on
 * @param values - The rows to attach by position. Default: `rows`. Missing positions are omitted.
 * @returns A read-only map from each key's string form to its rows, in input order
 *
 * @example
 * ```ts
 * groupRows([{ author: 'u1' }, { author: 'u1' }], 'author').get('u1')?.length // 2
 * ```
 */
export function groupRows(
	rows: readonly Row[],
	column: string,
	values: readonly Row[] = rows,
): ReadonlyMap<string, readonly Row[]> {
	const pairs = Iterator.from(rows.entries()).flatMap(
		([index, row]): ReadonlyArray<readonly [string, Row]> => {
			const value = values[index]
			return value === undefined ? [] : [[String(resolveField(row, column)), value]]
		},
	)
	return new Map(
		Iterator.from(Map.groupBy(pairs, ([key]) => key)).map(
			([key, group]): readonly [string, readonly Row[]] => [key, group.map(([, value]) => value)],
		),
	)
}

// === Builders

/**
 * Builds a `belongs` relation — a foreign key on the owning table points at the related row
 * (single).
 *
 * @param column - The foreign-key column on this table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { classification: belongsTo('classificationId', 'classifications') }
 * ```
 */
export function belongsTo(column: string, model?: string): RelationDescriptor {
	return { relationship: 'belongs', column, ...(model !== undefined ? { model } : {}) }
}

/**
 * Builds a `many` relation — a foreign key on the related table points back at the owning row
 * (array).
 *
 * @param key - The foreign-key column on the related table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 */
export function hasMany(key: string, model?: string): RelationDescriptor {
	return { relationship: 'many', key, ...(model !== undefined ? { model } : {}) }
}

/**
 * Builds a `one` relation — like {@link hasMany}, but a single related row.
 *
 * @param key - The foreign-key column on the related table
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 */
export function hasOne(key: string, model?: string): RelationDescriptor {
	return { relationship: 'one', key, ...(model !== undefined ? { model } : {}) }
}

/**
 * Builds a `through` relation — a junction table links the two sides (many-to-many).
 *
 * @param through - The junction table name
 * @param source - The junction foreign-key column pointing at the owning model
 * @param target - The junction foreign-key column pointing at the related model
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { reps: hasThrough('accountReps', 'accountId', 'repId', 'reps') }
 * ```
 */
export function hasThrough(
	through: string,
	source: string,
	target: string,
	model?: string,
): RelationDescriptor {
	return {
		relationship: 'through',
		through,
		source,
		target,
		...(model !== undefined ? { model } : {}),
	}
}

/**
 * Builds a `morph` relation — a polymorphic foreign key plus a discriminator column on the
 * related table (array).
 *
 * @param key - The foreign-key column on the related table
 * @param tag - The discriminator column on the related table
 * @param label - The discriminator value identifying the owning model
 * @param model - Target table name (defaults to the relation name)
 * @returns A {@link RelationDescriptor}
 *
 * @example
 * ```ts
 * { notes: hasMorph('entityId', 'entityType', 'account', 'notes') }
 * ```
 */
export function hasMorph(
	key: string,
	tag: string,
	label: string,
	model?: string,
): RelationDescriptor {
	return { relationship: 'morph', key, tag, label, ...(model !== undefined ? { model } : {}) }
}
