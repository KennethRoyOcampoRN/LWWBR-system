// Shared types, zod schemas, permission keys, and state-transition tables
// live here per spec §12 rule 4. Empty at M0 by design — permission keys
// land in M1, state machines in M2/M3, so this package isn't scaffolded
// ahead of the milestone that needs it (spec §12 rule 2).
export const SHARED_PACKAGE_READY = true;
