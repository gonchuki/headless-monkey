import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/auth/AuthProvider";
import { showRealtimeToast } from "@/components/Toast";
import { notifyUnauthorized } from "@/lib/api";
import { queryKeys } from "@/lib/query";

export type RealtimeChangeKind =
  | "renamed"
  | "added"
  | "deleted"
  | "typeChanged"
  | "requiredChanged"
  | "reordered";

export interface RealtimeChange {
  kind: RealtimeChangeKind;
  fieldId?: number;
  label?: string;
  type?: string;
  required?: boolean;
}

export type RealtimeEventType =
  | "schema.created"
  | "schema.updated"
  | "schema.deleted"
  | "entry.created"
  | "entry.updated"
  | "entry.deleted";

export interface RealtimeEvent {
  type: RealtimeEventType;
  schema: string;
  entryId?: number;
  version?: number;
  compatVersion?: number;
  by: string;
  changes?: RealtimeChange[];
}

export interface UseRealtimeOptions {
  /** Schemas currently on screen. Empty list means "all schemas" (e.g. the schema list). */
  schemas: string[];
  enabled?: boolean;
  /** Whether entry events affect this view (content screens) or are ignored (schema screens). */
  includeEntries?: boolean;
}

const RECONNECT_DELAY_MS = 2000;

export function useRealtime({ schemas, enabled = true, includeEntries = true }: UseRealtimeOptions) {
  const queryClient = useQueryClient();
  const { user, token } = useAuth();
  const [deletedSchemas, setDeletedSchemas] = useState<ReadonlySet<string>>(() => new Set());

  // A stable key keeps the effect from restarting on every render while still
  // reconnecting (and re-syncing) when the on-screen schemas change.
  const schemaKey = [...schemas].sort().join("\u0000");

  useEffect(() => {
    if (!enabled || !token || !user?.login) return;

    const currentLogin = user.login;
    const visible = schemaKey ? schemaKey.split("\u0000") : [];
    const visibleSet = new Set(visible);
    const isRelevant = (schema: string): boolean => visible.length === 0 || visibleSet.has(schema);

    let aborted = false;
    let controller: AbortController | null = null;
    let retryTimer: number | undefined;

    function invalidateVisible(): void {
      for (const schema of visible) {
        queryClient.invalidateQueries({ queryKey: queryKeys.schema(schema) });
        queryClient.invalidateQueries({ queryKey: queryKeys.entries(schema) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
    }

    function scheduleReconnect(): void {
      if (aborted) return;
      retryTimer = window.setTimeout(() => {
        void connect();
      }, RECONNECT_DELAY_MS);
    }

    function handleEvent(event: RealtimeEvent): void {
      // A change must never notify the user who made it (R26 is about others).
      if (event.by === currentLogin) return;
      // Events for schemas not on screen must not toast or invalidate.
      if (!isRelevant(event.schema)) return;

      switch (event.type) {
        case "schema.created":
          queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
          // Adding a schema changes the global all-schemas listing.
          queryClient.invalidateQueries({ queryKey: queryKeys.allEntries() });
          showRealtimeToast(event);
          break;
        case "schema.updated":
          queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
          queryClient.invalidateQueries({ queryKey: queryKeys.schema(event.schema) });
          queryClient.invalidateQueries({ queryKey: queryKeys.entries(event.schema) });
          queryClient.invalidateQueries({ queryKey: queryKeys.allEntries() });
          showRealtimeToast(event);
          break;
        case "schema.deleted":
          // Keep the last-known data for open editors so they can render
          // disabled; only the list re-syncs.
          setDeletedSchemas((prev) => {
            const next = new Set(prev);
            next.add(event.schema);
            return next;
          });
          queryClient.invalidateQueries({ queryKey: queryKeys.schemas() });
          // Removing a schema changes the global all-schemas listing.
          queryClient.invalidateQueries({ queryKey: queryKeys.allEntries() });
          showRealtimeToast(event);
          break;
        case "entry.created":
        case "entry.updated":
        case "entry.deleted":
          if (!includeEntries) return;
          queryClient.invalidateQueries({ queryKey: queryKeys.entries(event.schema) });
          queryClient.invalidateQueries({ queryKey: queryKeys.allEntries() });
          showRealtimeToast(event);
          break;
      }
    }

    async function connect(): Promise<void> {
      const nextController = new AbortController();
      controller = nextController;

      let response: Response;
      try {
        // Sanctioned exception to the "raw fetch inside useEffect is
        // forbidden" rule: EventSource cannot set the Authorization header, so
        // useRealtime reads the SSE stream via a fetch body reader (SPEC §6).
        response = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: nextController.signal,
        });
      } catch {
        scheduleReconnect();
        return;
      }

      if (response.status === 401) {
        // Token expired mid-stream: drop the session, the router sends us to
        // the login screen.
        nextController.abort();
        notifyUnauthorized();
        return;
      }
      if (!response.ok || !response.body) {
        nextController.abort();
        scheduleReconnect();
        return;
      }

      // Reconnect must re-sync from the server rather than trust the events it
      // missed while disconnected.
      invalidateVisible();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const json = dataLine.slice(5).trim();
            if (!json) continue;
            let event: RealtimeEvent;
            try {
              event = JSON.parse(json) as RealtimeEvent;
            } catch {
              continue;
            }
            handleEvent(event);
          }
        }
      } catch {
        // Stream failed mid-flight — reconnect below.
      } finally {
        nextController.abort();
      }

      scheduleReconnect();
    }

    void connect();

    return () => {
      aborted = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [schemaKey, token, enabled, includeEntries, user?.login, queryClient]);

  return { deletedSchemas };
}
