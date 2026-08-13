# PLAN-51 — Fix checkCycle to rebuild graph for schema updates

## Goal

`SchemaService.checkCycle()` reads the live DB graph via `getRefGraph()` and seeds the walk from incoming field refs. During schema update, old refs that are being changed or deleted remain in the graph, causing false positives (rejecting valid retargets) or false negatives (missing cycles through edges that were just added to other schemas). Fix by rebuilding the graph to reflect the post-update state: replace the target schema's outgoing edges with the incoming fields' refs before walking.

## Files involved

- `server/src/services/schemaService.ts` — `checkCycle()` method; modify the graph construction logic
- `server/src/repositories/schemaRepo.ts` — `getRefGraph()` method; no changes needed (it correctly returns the live DB state)

## Implementation approach

1. Extract incoming refs from the fields parameter: collect all `ref_schema` values from schema-ref type fields in the incoming fields array.

2. Rebuild the reference graph to reflect the post-update state: start with the live DB graph from `getRefGraph()`, then replace the target schema's outgoing edges with the incoming refs. This handles create (no existing edges, incoming refs are added), update with retarget (old edges replaced with new ones), and update adding/deleting fields (incoming refs represent the final state).

3. Walk the rebuilt graph from the target schema to detect cycles. The walk should start from the incoming refs (the post-update targets) and check if any path leads back to the target schema. Use the rebuilt graph for edge lookups during traversal, not the live DB graph.

4. No signature change is needed — `checkCycle()` already receives `targetSchema` and `fields`. The fix is internal: build the working graph correctly before walking.

## Edge cases

- **Self-reference**: Schema A adds a schema-ref field pointing to itself. `incomingRefs` includes "A". The walk starts from "A", checks `current === targetSchema`, throws immediately. Correct.
- **Two-schema cycle**: A→B and B→A. When updating A to add ref to B, if B already refs A, the walk from B finds A. Correct.
- **Multi-hop cycle**: A→B→C→A. Walk from B finds C, from C finds A. Correct.
- **Retarget creating cycle**: A currently refs B. Update changes A's ref to C. C refs D, D refs A. The working graph has A→C (not A→B). Walk from C finds D, from D finds A. Cycle detected. Correct.
- **Retarget breaking cycle**: A currently refs B, B refs A (existing cycle — impossible since it would have been caught at creation). This case doesn't arise in practice.

## Acceptance criteria

1. Creating a schema with a self-referencing schema-ref field returns 422 (cycle detected).
2. Updating a schema to retarget a schema-ref field that creates a cycle returns 422.
3. Updating a schema to retarget a schema-ref field that does NOT create a cycle succeeds (no false positive).
4. Creating a schema with a valid schema-ref chain (A→B→C, no cycles) succeeds.
5. The existing test suite passes — no regression in cycle detection.
