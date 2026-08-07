# PLAN-17 — Deterministic per-schema color identity (dots in listings, badges in the All view)

## Goal

Give every schema an automatically generated color derived from its name, so the same name always yields the same color (hue rotated from a checksum of the name). Surface it as:
- a small **16px dot** prepended to the schema name wherever schemas are listed;
- the **background color** of the per-schema badge on content rows in the All view (`/content`), with a contrasting text color so the badge stays legible.

This is a pure client-side feature; no API, schema, or data changes.

## Files involved

- `client/src/lib/schemaColors.ts` (new) — the deterministic color helper.
- `client/src/routes/SchemasPage.tsx` — schema list rows; prepend a dot to the schema name.
- `client/src/routes/ContentPage.tsx` — (a) the schema filter dropdown items; (b) the All-view per-row schema badge (currently `bg-muted text-muted-foreground`), which must take the schema color as background with a contrasting foreground.
- `client/src/components/NewEntrySelector.tsx` — schema dropdown items on the new-entry page; prepend a dot.
- `client/src/components/SchemaFieldRow.tsx` — the "Referenced schema" dropdown items in the schema editor; prepend a dot.
- `client/src/components/ui/select.tsx` — verify only: how `SelectItem` renders children (plain text vs. arbitrary ReactNode). If it wraps children in a text-only slot, the dot must be rendered as an inline element so it lays out next to the name.

## Implementation approach

1. **Color helper (`client/src/lib/schemaColors.ts`):**
   - Export a pure function of the schema name, e.g. `schemaColor(name: string)`. Same input → same output, always.
   - Compute a checksum of the name (a stable hash — FNV-1a or a simple char-sum are both fine; it must not depend on `Math.random`, Date, or runtime state).
   - Map the checksum to a hue: `hue = checksum % 360`. Optionally multiply by the golden angle or otherwise spread hues so adjacent names rarely collide visually, but determinism is the hard requirement.
   - Use fixed saturation/lightness (a single S/L pair works in both light and dark themes; the theme is oklch CSS variables but a plain `hsl()` string is fine and self-contained).
   - Derive the foreground (text) color from the background luminance so the badge text contrasts (e.g. compute relative luminance and pick near-black vs near-white). The same helper can return both `background` and `foreground`.
   - Return CSS color strings ready for inline `style={{ background, color }}` — hues are runtime values, so Tailwind classes cannot pre-generate them.

2. **Dot component usage:** a 16px dot = an element with `size-4 rounded-full` (Tailwind) or an inline 16×16 span, `style={{ backgroundColor: schemaColor(name).background }}`, plus `aria-hidden="true"` (purely decorative). Prepend it inside the label so it renders before the name with a small gap. Reuse this shape in:
   - `SchemasPage.tsx` schema rows (next to the schema name, which is the `<p className="truncate ...">` holding `{schema.name}`);
   - `ContentPage.tsx` filter dropdown `SelectItem`s (alongside `{schema.name}`);
   - `NewEntrySelector.tsx` `SelectItem`s (alongside `{schema.name}`);
   - `SchemaFieldRow.tsx` "Referenced schema" `SelectItem`s (alongside the schema name).

3. **All-view badge (`ContentPage.tsx`):** the badge span currently is `bg-muted ... text-muted-foreground`. Change it to use the schema's color as background and the helper-derived contrasting foreground: `style={{ backgroundColor, color }}`. Keep the existing pill shape/size classes.

4. **Select rendering check:** confirm `SelectItem` accepts arbitrary children (it should — shadcn/ui select items take ReactNode). If the item content is text-only, render the dot as an inline-block element inside the item's children so it sits beside the name.

## Edge cases

- **Determinism is the core invariant:** two renders of the same schema name must produce identical colors, across page loads and sessions. Do not seed from anything non-deterministic.
- **Legibility on the badge:** foreground must contrast against the derived background, not just against the theme's `muted-foreground`. The helper computes foreground from the same hue-derived background.
- **No server involvement:** colors are a client concern only; schemas are not renamed (the editor forbids renaming), so a name → color mapping never goes stale mid-flight.
- **Filtered view vs All view:** badges only appear in the All view per PLAN-13; the filtered view must not change. The dot appears in *all* listed dropdowns regardless of view.
- **Existing hand-rolled badges:** the app has no shadcn `badge` component; the All-view badge is a plain span — keep it a plain span with inline color styles.

## Acceptance criteria

1. `pnpm --filter client build` passes (typecheck + vite build).
2. A pure deterministic helper exists in `client/src/lib/schemaColors.ts` that returns `background` and `foreground` CSS colors from a schema name, deriving hue from a stable checksum of the name and foreground from background luminance (inspect the function; no randomness, no runtime-state dependency). Same-name → same-color can be confirmed by reading the function (pure arithmetic on the name).
3. The 16px dot appears in all four listing surfaces: `SchemasPage.tsx` rows, `ContentPage.tsx` filter dropdown, `NewEntrySelector.tsx` dropdown, and `SchemaFieldRow.tsx` referenced-schema dropdown — each rendering the schema color as its background (grep the four files for the helper's use).
4. The All-view per-row schema badge in `ContentPage.tsx` uses the schema color as background with the helper-derived contrasting foreground, replacing the previous `bg-muted`/`text-muted-foreground` styling (inspect the badge markup).
5. **Manual (cannot be verified by tests):** in a browser with ≥2 schemas — each schema shows the same dot color across the schema list, the content filter, the new-entry selector, and the schema editor's referenced-schema dropdown; the All-view badges are colored per schema and readable (text contrasts); two different schema names produce visibly different colors and the same name stays identical across reloads. Verify by hand.
