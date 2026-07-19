# Phase 2 canonical-content enforcement

The live engine is a second, fail-closed policy boundary. It does not infer doctrinal authority, licensing, review completion, or question quality from the fact that a record arrived through the canonical API.

Before mapping a question into live-engine format, `src/content/governance.ts` requires:

- a current publication or analytics-review governance attestation;
- single-answer multiple choice with four explained options and one best answer;
- a learning objective, level 1–5, difficulty mode, and retake equivalence key;
- a misconception code for every distractor;
- approved trick categories only;
- no unresolved prohibited quality flags or generic comparative-family claims;
- named, recognised-source comparative scope and an advanced-question steelman;
- explicit question rights metadata and at least one authoritative, located, rights-cleared source.

A rejected refresh retains the last validated canonical catalogue. The engine never repairs, downgrades, or silently defaults missing governance metadata. Human doctrinal, assessment, and licence review remain authoritative; a machine pass is necessary but never sufficient for publication.
