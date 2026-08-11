export const queryKeys = {
  me: (token: string | null) => ["auth", "me", token ?? "anonymous"] as const,
  users: () => ["users"] as const,
  schemas: () => ["schemas"] as const,
  schema: (name: string) => ["schemas", "detail", name] as const,
  schemaPreview: (name: string, fingerprint: string) =>
    ["schemas", "detail", name, "preview", fingerprint] as const,
  entries: (schema: string) => ["schemas", "entries", schema] as const,
};
