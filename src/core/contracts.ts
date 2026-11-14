import type { ContractInterface } from '@orkestrel/contract'
import type { RelationDescriptor } from './types.js'
import { createContract } from '@orkestrel/contract'
import { relationDescriptorShape } from './shapers.js'

/**
 * Holds the compiled contract of a relation descriptor, which `resolveRelation` admits through.
 *
 * @example
 * ```ts
 * import { relationDescriptorContract } from '@orkestrel/relation'
 *
 * relationDescriptorContract.audit({ column: 'accountId', comment: 'x' }) // [{ reason: 'extra', path: ['comment'] }]
 * ```
 */
export const relationDescriptorContract: ContractInterface<RelationDescriptor> =
	createContract(relationDescriptorShape)
