// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import type { Include } from '@src/core'
import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/relation'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/relation.md'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ [PACKAGE_NAME]: 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isArray, isRecord, parseJSON, stringShape } = await import('@orkestrel/contract')
	const {
		computeSymbolKey,
		createSourceManager,
		extractFenceImports,
		findMissing,
		findMissingSymbols,
		findUnexampled,
		isExternalLink,
		resolveLink,
	} = await import('@orkestrel/guide')
	const { createDatabase, createMemoryDriver } = await import('@orkestrel/database')
	const { captureError, createRecorder, readProperty, requireValue } =
		await import('@orkestrel/test')
	const {
		belongsTo,
		createRelationManager,
		hasMany,
		hasThrough,
		isRelationDescriptor,
		isRelationError,
		resolveRelation,
		resolveRelationMap,
	} = await import('@src/core')
	const { describe, expect, it } = await import('vitest')
	const { MODEL_TABLES, createLoadFixture, one, rows: related } = await import('./setup.js')
	const sources = createSourceManager({ files, modules: MODULES })
	const own = requireValue(
		rows.find((row) => row.entry.spec === GUIDE_SPEC),
		`Missing manifest row: ${GUIDE_SPEC}`,
	)
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(own.entry.spec).toBe(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('extracts a non-empty documented surface', () => {
				expect(guide.surface().length).toBeGreaterThan(0)
			})
			it('re-exports every direct declaration that is not named internal', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
			})
			it('names no symbol internal that the barrel already exports', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
			})
			it('re-exports only direct declarations', () => {
				expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
			})
			it('documents every barrel export', () => {
				expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
			})
			it('documents only barrel exports', () => {
				expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
			})

			it('exposes no hidden module-scope declarations', () => {
				expect(source.hidden().map(computeSymbolKey)).toEqual([])
			})

			for (const group of guide.methods()) {
				const members = source.methods(group.interface).map((method) => method.name)
				const documented = group.methods.map((method) => method.name)
				const entity = group.interface.replace(/Interface$/, '')
				describe(`${group.interface}`, () => {
					it('documents at least one method', () => {
						expect(group.methods.length).toBeGreaterThan(0)
					})
					it('documents every interface method', () => {
						expect(findMissing(members, documented)).toEqual([])
					})
					it('documents no phantom method', () => {
						expect(findMissing(documented, members)).toEqual([])
					})
					it(`${entity} exposes no undocumented method`, () => {
						const extra =
							entity === group.interface
								? []
								: findMissing(
										source.methods(entity).map((method) => method.name),
										documented,
									)
						expect(extra).toEqual([])
					})
				})
			}

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides with `npm run docs`, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist `npm run docs` prints, so a failure here is read the way that command's
			// output is.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			for (const group of guide.methods()) {
				const entity = group.interface.replace(/Interface$/, '')
				const documented = group.methods.map((method) => method.name)
				const examples =
					entity === group.interface
						? source.examples(group.interface).map((example) => example.name)
						: source
								.examples(group.interface)
								.map((example) => example.name)
								.concat(source.examples(entity).map((example) => example.name))
				describe(`${group.interface} examples`, () => {
					it('documents an example for every method', () => {
						const fences = guide
							.fences()
							.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
							.map((fence) => fence.code)
						expect(findUnexampled(documented, fences, examples)).toEqual([])
					})
				})
			}

			it('imports only real exports in every ```ts fence', () => {
				const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				for (const fence of fences) {
					for (const { specifier, names } of extractFenceImports(fence.code)) {
						const imported = sources.source(specifier)
						if (imported === undefined) continue
						const surface = imported.surface().map((symbol) => symbol.name)
						expect(findMissing(names, surface)).toEqual([])
					}
				}
			})

			it('resolves every relative link', () => {
				const broken = guide
					.links()
					.filter((href) => !isExternalLink(href))
					.map((href) => resolveLink(entry.spec, href))
					.filter((path) => !source.exists(path))
				expect(broken).toEqual([])
			})
			it('links only to test files that exist', () => {
				const missing = guide
					.tests()
					.map((href) => resolveLink(entry.spec, href))
					.filter((path) => !source.exists(path))
				expect(missing).toEqual([])
			})
		})
	}

	// The parity assertions in the manifest loop prove that every documented name resolves. They
	// cannot prove that a fence's `// value` comment is true, so each fence in `guides/relation.md`
	// that claims a value is transcribed here and its claim asserted against the real exports. The
	// block sits outside the loop because the loop registers once per manifest entry.
	describe('executable guide fences', () => {
		it('T9 constructs a transaction manager and reads its own related writes', async () => {
			const TABLES = {
				accounts: { id: stringShape(), name: stringShape() },
				contacts: { id: stringShape(), accountId: stringShape() },
			}
			const database = createDatabase({ driver: createMemoryDriver(), tables: TABLES })
			const count = await database.transaction(async (storage) => {
				const manager = createRelationManager({
					storage,
					relations: { accounts: { contacts: hasMany('accountId') } },
				})
				await manager.model('accounts').table.set({ id: 'a1', name: 'Acme' })
				await storage.table('contacts').set({ id: 'c1', accountId: 'a1' })
				const account = await manager.model('accounts').load('a1', { contacts: true })
				return isArray(account?.contacts) ? account.contacts.length : 0
			})
			expect(count).toBe(1)
		})
		it('resolves a builder descriptor onto the belongs arm', () => {
			const resolved = resolveRelation(
				'classification',
				belongsTo('classificationId', 'classifications'),
			)
			expect(resolved.relationship).toBe('belongs')
		})

		it('resolves a relation map entry onto the many arm', () => {
			const map = resolveRelationMap({ contacts: hasMany('accountId') })
			expect(map.get('contacts')?.relationship).toBe('many')
		})

		it('narrows a builder descriptor to the object form', () => {
			expect(isRelationDescriptor(belongsTo('classificationId'))).toBe(true)
		})

		it('carries through, source, and target as required members of the through arm', () => {
			const resolved = resolveRelation('reps', hasThrough('accountReps', 'accountId', 'repId'))
			expect(resolved).toEqual({
				relationship: 'through',
				name: 'reps',
				model: 'reps',
				through: 'accountReps',
				source: 'accountId',
				target: 'repId',
			})
		})

		it('reports INVALID as the code a malformed relation throws', () => {
			const error = captureError(() => resolveRelation('bad', {}))
			expect(isRelationError(error)).toBe(true)
			expect(readProperty(error, 'code')).toBe('INVALID')
		})

		// Invariant 3, "Batch loading — no N+1": every table call a load makes, read on a storage
		// that records each call on the real tables. The fixture holds many related rows of every
		// relationship per parent, so a per-parent or per-row read would show as extra calls.
		it('reads each direct relation with one call and each through with two, at every nesting level', async () => {
			const calls = createRecorder<[table: string, method: string]>()
			const { accounts, keys } = await createLoadFixture(20, 25, calls.handler)
			const cases: ReadonlyArray<readonly [Include, ReadonlyArray<readonly [string, string]>]> = [
				[{ classification: true }, [['classifications', 'get']]],
				[{ contacts: true }, [['contacts', 'records']]],
				[{ profile: true }, [['profiles', 'records']]],
				[{ notes: true }, [['notes', 'records']]],
				[
					{ reps: true },
					[
						['accountReps', 'records'],
						['reps', 'get'],
					],
				],
				[
					{ contacts: { account: true } },
					[
						['contacts', 'records'],
						['accounts', 'get'],
					],
				],
				[
					{ reps: { accounts: true } },
					[
						['accountReps', 'records'],
						['reps', 'get'],
						['accountReps', 'records'],
						['accounts', 'get'],
					],
				],
				[
					{ contacts: { account: { reps: { accounts: true } } } },
					[
						['contacts', 'records'],
						['accounts', 'get'],
						['accountReps', 'records'],
						['reps', 'get'],
						['accountReps', 'records'],
						['accounts', 'get'],
					],
				],
			]
			for (const [include, expected] of cases) {
				calls.clear()
				const loaded = await accounts.load(keys, include)
				expect(loaded).toHaveLength(20)
				expect(calls.calls).toEqual([['accounts', 'get'], ...expected])
			}
		})

		// The control for the preceding proof: the recorder sees one call per read, so a load made
		// once per parent shows twice the calls per parent.
		it('counts a per-parent load as one get and one relation read per parent', async () => {
			const calls = createRecorder<[table: string, method: string]>()
			const { accounts, keys } = await createLoadFixture(20, 25, calls.handler)
			for (const key of keys) await accounts.load(key, { classification: true })
			expect(calls.count).toBe(40)
		})

		it('returns every related row of every loaded parent, with limit bounding the parents', async () => {
			const calls = createRecorder<[table: string, method: string]>()
			const { accounts } = await createLoadFixture(20, 25, calls.handler)
			const page = await accounts.find({ contacts: true }, { sort: 'id', limit: 2 })
			expect(page.map((account) => account.id)).toEqual(['acc0', 'acc1'])
			expect(page.map((account) => related(account.contacts).length)).toEqual([25, 25])
		})

		it('reads every match of a one relationship and keeps one', async () => {
			const calls = createRecorder<[table: string, method: string]>()
			const { accounts, db } = await createLoadFixture(1, 25, calls.handler)
			const account = await accounts.load('acc0', { profile: true })
			expect(calls.calls).toEqual([
				['accounts', 'get'],
				['profiles', 'records'],
			])
			expect(await db.table('profiles').count()).toBe(25)
			expect(one(account?.profile).id).toBe('acc0-pro0')
		})

		it('lists the tables carrying relations and reports membership', () => {
			const database = createDatabase({
				driver: createMemoryDriver(),
				tables: MODEL_TABLES,
			})
			const manager = createRelationManager<typeof MODEL_TABLES>({
				storage: database,
				relations: {
					accounts: {
						classification: belongsTo('classificationId', 'classifications'),
						contacts: hasMany('accountId'),
					},
					contacts: { account: belongsTo('accountId', 'accounts') },
				},
			})
			expect([...manager.names()].sort()).toEqual(['accounts', 'contacts'])
			expect(manager.has('accounts')).toBe(true)
			expect(manager.has('unrelated_table')).toBe(false)
		})
	})
})
