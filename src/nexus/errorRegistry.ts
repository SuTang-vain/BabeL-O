/**
 * Error Registry for BabeL-O (nexus re-export)
 *
 * Canonical definitions live in src/shared/errorRegistry.ts.
 * This file re-exports for backward compatibility and nexus-scoped collocation.
 *
 * Governance: Nexus owns error definition. Client consumes server hints.
 */

export {
  ERROR_REGISTRY,
  humanizeError,
  listErrorCodes,
  isKnownErrorCode,
} from '../shared/errorRegistry.js'

export type { ErrorDefinition } from '../shared/errorRegistry.js'
