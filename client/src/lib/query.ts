export const queryKeys = {
  me: (token: string | null) => ["auth", "me", token ?? "anonymous"] as const,
  users: () => ["users"] as const,
  schemas: () => ["schemas"] as const,
  schema: (name: string) => ["schemas", "detail", name] as const,
  entries: (schema: string) => ["schemas", "entries", schema] as const,
  // Global (all-schemas) listing family. The third element is an OBJECT
  // sentinel on purpose: schema names are strings, so no real schema name can
  // collide with this family, and it stays under the `["schemas", "entries"]`
  // umbrella (which is what lets broad umbrella invalidations keep working).
  allEntries: () => ["schemas", "entries", { view: "all" }] as const,
  entry: (schema: string, id: number) => ["schemas", "entries", schema, "detail", id] as const,
  entryCount: (schema: string) => ["schemas", "entryCount", schema] as const,
};
