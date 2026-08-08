# PLAN-23 — Revise SPEC.md to v0.7: public content API becomes a `{meta, entries}` wrapper with id-keyed `values`

## Goal

Revise `SPEC.md` to **v0.7 (BREAKING)** so the public content API contract matches the decisions settled in the Front 6 design sessions. This is a document-only plan — no server or client code changes. It is the contract that PLAN-24 (greenfield DDL) and the subsequent ref-table plans (Fronts 1–5) implement, so every contract below is binding.

The public content API — `GET /api/content/:schema` and `GET /api/content/:schema/:id` — changes from a bare JSON array (or single object) of entries with label-keyed `values`, to a uniform `{meta, entries}` wrapper where:

- `meta` carries the schema invariants: `name` (the schema name), `version` (the schema's *current* version), and `fields` (a map of `String(field_id)` → current label).
- `entries` is an array of entry objects `{ id, schema_version, values }`. The `/:id` endpoint returns the same shape with a one-element `entries` array.
- `values` is keyed by `String(field_id)` — the same stable key the editor routes and content rows use — never by label. Schema-ref values keep the `{id, schema}` enrichment on the public path.
- There is **no** `X-Schema-Version` header; `meta.version` is the single source of truth for "did the shape change." A consumer compares `meta.version` against the version it was built for; the per-entry `schema_version` remains the version the entry was saved under.
- `meta` contains no `compat_version`, no field `type`, no `required`. Values arrive already typed; editing metadata belongs to the editor API.

Additionally, this revision:
- Adds **R34**: deleting an entry that other entries reference returns 409 with the referencer count (mirrors R22's schema rule).
- Adds **R35**: changing a schema-ref field's `ref_schema` purges that field's references from every entry of the schema and leaves surviving entries conflicted until re-edited. Unlike R21 (which bumps `schema_version` to un-conflict entries after a field delete, because the entry is complete once the field is gone), R35 must **not** bump `schema_version`: after a retarget the field still exists, the entry is missing a target for it, and it is therefore not complete — it stays conflicted via the existing `compat_version` bump (retarget is a breaking change, §7) until an editor re-selects a valid target.
- Records the **construction invariant** for the conflict model: conflict remains purely version-based (`schema_version < compat_version`) because referential integrity is guaranteed by construction — referenced-entry deletion is blocked (R34) and ref_schema retargeting purges refs (R35).
- Records that an optional schema-ref field with no target serializes as an **absent key** in `values` (matching how optional scalar values are omitted), never `null`.
- Replaces the frozen §4 DDL with the greenfield baseline agreed in Front 7: cascade chains on structural FKs, a normalized `content_refs` table with `ON DELETE RESTRICT` on the target side, the `idx_content_refs_target` index, inline `UNIQUE (schema, label)`, and the `CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL)` constraint.
- Records that schema-ref storage moves out of `content_rows.value` JSON into `content_refs.target_content_id` (INTEGER). `content_rows.value` continues to hold JSON-encoded scalars for `text|number|boolean|date` only.

## Files involved

- `SPEC.md` — the only file this plan edits. Revise header/changelog, §2 requirements (R15, R18, R19, R21, new R34/R35), §4 contracts (public API bullets, DDL, value serialization), §5 invariants, and §7 examples. Do not renumber existing requirements R1–R33; append R34/R35 at the end of the Content & public API section.

## Implementation approach

1. **Header and changelog.** Change the title line to `# SPEC: headless-monkey CMS (v0.7 — 2026-08-08)` and insert a new changelog line above the v0.6 entry: `v0.7 — BREAKING: the public content API returns a {meta, entries} wrapper with values keyed by String(field_id) (not label) and a meta.fields id→label map; schema-ref storage moves to a normalized content_refs table; deleting a referenced entry is blocked (R34); ref_schema retargeting purges refs and leaves affected entries conflicted until re-edited (R35); §2 R15/R18/R19/R21, §4, §5, §7`.
2. **R15 (rewrite).** Replace the current label-keyed read-side claim. The new text must state: fields are referenced by stable numeric `field_id` in content rows, write payloads, editor `values` responses, public API `values`, and SSE events — never by label; renaming a label changes no stored data and does not invalidate content; the public API is self-describing through `meta.fields` (a `String(field_id)` → current label map), so consumers can render labels and detect shape drift by comparing `meta.version` against the version they built for.
3. **R16 (edit, one clause).** In the schema-ref validity sentence, append the absent-key rule: an *optional* schema-ref field with no target is omitted from `values` (absent key), never serialized as `null`.
4. **R18 and R19 (rewrite).** R18: `GET /api/content/:schema` returns 200 with a `{meta, entries}` response containing only valid entries (`schema_version >= compat_version`); unknown schema returns 404. R19: `GET /api/content/:schema/:id` returns 200 with the same `{meta, entries}` shape and a one-element `entries` array for a valid entry, 404 if the id does not exist, 422 if the entry exists but is conflicted. Keep R20 (unauthenticated/stateless) unchanged.
5. **R21 (edit).** Extend the requirement identified by `R21` (field-delete propagation). Keep its current version-bump behavior, and extend its row-removal sentence so deleting a field removes that field's `content_rows` **and** `content_refs` from every entry of the schema, and each surviving entry's `schema_version` is set to the schema's current version.
6. **New R34 and R35** (append to the Content & public API section, after R22; do not reuse numbers already assigned to the SSE (R23–R26) or Client (R27–R33) sections):
   - R34. Deleting an entry that is the target of any other entry's schema-ref value returns 409 naming the referencer count; the delete confirmation warns with that count before the attempt. This is the entry-level mirror of R22.
   - R35. Changing a schema-ref field's `ref_schema` propagates: that field's `content_refs` are removed from every entry of the schema, and the entries stay conflicted until re-edited (no `schema_version` bump — the entry is incomplete without a target for the still-existing field; the `compat_version` bump already carries the conflict). This is the R21-style propagation applied to a ref-target change, minus the version bump.
7. **§4 DB DDL (replace).** Replace the current DDL block with the greenfield baseline below. It must match PLAN-24's implementation verbatim; the two must be mutually consistent after both plans land:

```sql
users(id INTEGER PK AUTOINCREMENT, login TEXT NOT NULL UNIQUE,
      hashed_password TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);

schemas(name TEXT PK, creation_date TEXT NOT NULL, created_by TEXT NOT NULL,
        last_modified_date TEXT NOT NULL, last_modified_by TEXT NOT NULL,
        version INTEGER NOT NULL, compat_version INTEGER NOT NULL);

schema_fields(id INTEGER PK AUTOINCREMENT,
      schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      label TEXT NOT NULL, type TEXT NOT NULL
        CHECK(type IN ('text','number','boolean','date','schema-ref')),
      required INTEGER NOT NULL, ref_schema TEXT, sort_order INTEGER NOT NULL,
      UNIQUE (schema, label),
      CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL));

content(id INTEGER PK AUTOINCREMENT,
      schema TEXT NOT NULL REFERENCES schemas(name) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL, creation_date TEXT NOT NULL,
      created_by TEXT NOT NULL, last_modified_date TEXT NOT NULL,
      last_modified_by TEXT NOT NULL);

content_rows(content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
      value TEXT, PRIMARY KEY(content_id, field_id));

content_refs(content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES schema_fields(id) ON DELETE CASCADE,
      target_content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE RESTRICT,
      PRIMARY KEY(content_id, field_id));

CREATE INDEX idx_content_refs_target ON content_refs(target_content_id);
```

8. **§4 Public API (rewrite the two bullets).** The public API section must describe both endpoints as returning the `{meta, entries}` wrapper. Exact contract text: `GET /api/content/:schema` → 200 `{ meta: { name, version, fields: { "<field_id>": "<label>", ... } }, entries: [ { id, schema_version, values: { "<field_id>": <value>, ... } } ] }` (valid entries only); 404 unknown schema. `GET /api/content/:schema/:id` → the same shape with a one-element `entries` array; 404 unknown id; 422 conflicted. Remove the sentence claiming `values` keys are field labels; replace with: `values` keys are `String(field_id)` (the stable id, unique across versions by R13's id-stable contract); labels are provided by `meta.fields` for display and for detecting renames; schema-ref values serialize as `{id: <target_entry_id>, schema: <ref_schema_name>}`. State explicitly there is no version header — `meta.version` is authoritative.
9. **§4 Value serialization (edit).** Rewrite the "Value serialization" paragraph: `content_rows.value` (DB storage, JSON-encoded TEXT) holds `text|number|boolean|date` scalars only — text→string, number→number, boolean→boolean, date→`"YYYY-MM-DD"`. Schema-ref targets are stored as INTEGER in `content_refs.target_content_id`, never as a JSON number in `content_rows.value`. Public `values` use the same per-type encoding, with schema-ref values enriched to `{id, schema}`. An optional schema-ref with no target is omitted (absent key).
10. **§5 Constraints & invariants (add two bullets).** (a) Conflict is version-only (`schema_version < compat_version`); referential integrity is guaranteed by construction because referenced-entry deletion is blocked (R34) and ref_schema retargeting purges refs (R35). (b) Deleting an entry that is referenced by another entry's schema-ref value is blocked with 409 naming the referencer count (R34); deleting a schema that is referenced by another schema's `schema-ref` field is blocked with 409 naming the referencing schema (existing invariant, unchanged).
11. **§7 Examples (update the serialization example).** The example must show the wrapper: `GET /api/content/person` → `{ "meta": { "name": "person", "version": 3, "fields": { "5": "name", "6": "age" } }, "entries": [ { "id": 10, "schema_version": 2, "values": { "5": "Ada", "6": 36 } } ] }`. If a schema-ref field is shown, its value is `{ "id": 42, "schema": "person" }` under a `String(field_id)` key. Do not leave any §7 example with label-keyed `values` keys.
12. **Consistency sweep.** After editing, no section of SPEC.md may claim the public API `values` are label-keyed, and no section may describe the public API as a bare array/single-object response. The editor content routes (§4 "Content (editor)" bullet) remain field_id-keyed with raw schema-ref numbers — that bullet does not change except where it must stay consistent with the new storage note.

## Edge cases

- **Requirement numbering collision.** The design sessions called the new rules "R23/R24," but those numbers are already assigned to the SSE section. Do **not** renumber R23–R33; the new rules must be appended as **R34** and **R35**. Any mention of "R23/R24" from design notes is stale and must not appear in SPEC.md.
- **`schema_version` vs `meta.version`.** The per-entry `schema_version` is the version the entry was saved under; `meta.version` is the schema's current version. A mismatch between them is the intended rename/change signal. The spec must not conflate the two.
- **Absent key vs null.** The absent-key rule applies only to *optional* schema-ref fields with no target. A required schema-ref field with no target is a validation error (R16) and cannot exist in stored data.
- **Public API stays unauthenticated/stateless (R20).** The wrapper shape does not change auth semantics; `meta` is derived per-request and must not imply server-side consumer state.
- **Frozen-contract discipline.** §4 is frozen; all changes here are made through this v0.7 revision, and PLAN-24 must implement the DDL exactly as written in §4.

## Acceptance criteria

1. The first line of `SPEC.md` is `# SPEC: headless-monkey CMS (v0.7 — 2026-08-08)` and the top changelog entry starts with `v0.7 — BREAKING`.
2. `SPEC.md` contains no occurrence of the phrase `keyed by the field's unique label` (previously in R15 and the §4 public API bullet) — `grep -n "keyed by the field's unique label" SPEC.md` returns nothing.
3. The §4 public API section contains both endpoint descriptions with the literal tokens `meta`, `entries`, and `meta.fields`, and the phrase `String(field_id)` appears in the description of `values` keys — `grep -n "meta.fields" SPEC.md` and `grep -n "String(field_id)" SPEC.md` both return at least one hit inside the §4 public API section.
4. The §4 DDL block contains `content_refs`, `ON DELETE RESTRICT`, `idx_content_refs_target`, `UNIQUE (schema, label)`, and `CHECK (type != 'schema-ref' OR ref_schema IS NOT NULL)` — each of these exact strings appears in `SPEC.md`.
5. The §4 value-serialization paragraph states that schema-ref targets are stored in `content_refs.target_content_id` and that `content_rows.value` holds only `text|number|boolean|date` — `grep -n "content_refs.target_content_id" SPEC.md` returns at least one hit, and the phrase `schema-ref→target content id (number)` (the old storage claim) is absent.
6. The §2 Content & public API section contains requirements numbered `R34` and `R35`; the R34 sentence contains `409` and `referencer count`, and the R35 sentence contains `ref_schema` and explicitly states that `schema_version` is **not** bumped (the `content_refs` are removed; the entries remain conflicted). (`grep -n "R34" SPEC.md` and `grep -n "R35" SPEC.md` each return at least one hit; read the surrounding text for the required phrases.)
7. The §2 requirements list still contains `R23`, `R24`, `R25`, and `R26` with their original SSE meanings, and no requirement was renumbered — `grep -n "R23\|R24\|R25\|R26" SPEC.md` returns hits in the Multi-user (SSE) section.
8. The §7 serialization example shows the `{meta, entries}` wrapper with `meta.fields` and an `entries` array, and no example in §7 uses a field label as a `values` key. (Verifiable by reading §7 — the wrapper tokens `"meta"`, `"fields"`, and `"entries"` must appear in the §7 example block.)
9. `§5 Constraints & invariants` contains the two new bullets from step 10, including the literal phrase `referential integrity is guaranteed by construction`.
10. The editor content routes bullet in §4 still describes `values` keyed by `String(field_id)` with raw schema-ref numbers, and `SPEC.md` contains no occurrence of the label-keyed editor shape claim `the editor shape, explicitly distinct from the public API's label-keyed shape` (the word `label-keyed` may remain only where it does not describe the current public or editor `values` keys).
