import { toast } from "@/components/ui/toast";
import type { RealtimeEvent } from "@/hooks/useRealtime";

function changeSummary(changes?: RealtimeEvent["changes"]): string | undefined {
  if (!changes || changes.length === 0) return undefined;
  const parts = changes.map((change) => {
    switch (change.kind) {
      case "added":
        return `added field "${change.label}"`;
      case "deleted":
        return `deleted field "${change.label}"`;
      case "renamed":
        return `renamed field "${change.label}"`;
      case "typeChanged":
        return `changed type of "${change.label}"`;
      case "requiredChanged":
        return change.required ? `made "${change.label}" required` : `made "${change.label}" optional`;
      case "reordered":
        return `reordered field "${change.label}"`;
      default:
        return "";
    }
  });
  const summary = parts.filter(Boolean).join(", ");
  return summary === "" ? undefined : summary;
}

/**
 * Renders the transient notification for a realtime event from another user
 * (R26). This is the `<Toast />` role over the shadcn toast primitive.
 */
export function showRealtimeToast(event: RealtimeEvent): void {
  switch (event.type) {
    case "schema.created":
      toast.add({ type: "info", title: `${event.by} created schema ${event.schema}` });
      break;
    case "schema.updated":
      toast.add({
        type: "info",
        title: `${event.by} updated schema ${event.schema}`,
        description: changeSummary(event.changes),
      });
      break;
    case "schema.deleted":
      toast.add({ type: "warning", title: `${event.by} deleted schema ${event.schema}` });
      break;
    case "entry.created":
      toast.add({
        type: "info",
        title: `${event.by} created entry #${event.entryId} in ${event.schema}`,
      });
      break;
    case "entry.updated":
      toast.add({
        type: "info",
        title: `${event.by} updated entry #${event.entryId} in ${event.schema}`,
      });
      break;
    case "entry.deleted":
      toast.add({
        type: "warning",
        title: `${event.by} deleted entry #${event.entryId} from ${event.schema}`,
      });
      break;
  }
}
