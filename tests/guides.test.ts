// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. `FENCE_LANGUAGES`, `EXAMPLE_LANGUAGE`,
// `MODULES`, `INTERNAL`, and `ROOT_FILES` are this package's own, and are the only part
// a sibling package changes.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { captureError, readProperty, requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'
import { stringShape } from '@orkestrel/contract'
import {
	belongsTo,
	createRelationManager,
	hasMany,
	hasThrough,
	isRelationDescriptor,
	isRelationError,
	resolveRelation,
	resolveRelationMap,
} from '@src/core'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/relation': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the `names no symbol internal that the barrel
 * already exports` case fails when a name here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
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
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
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

	it('lists the tables carrying relations and reports membership', () => {
		const database = createDatabase({
			driver: createMemoryDriver(),
			tables: {
				accounts: { id: stringShape(), name: stringShape(), classificationId: stringShape() },
				contacts: { id: stringShape(), accountId: stringShape(), email: stringShape() },
				classifications: { id: stringShape(), label: stringShape() },
			},
		})
		const manager = createRelationManager({
			database,
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
