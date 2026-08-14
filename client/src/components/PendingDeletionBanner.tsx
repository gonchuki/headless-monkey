import { useState } from "react";
import { Eye } from "@phosphor-icons/react";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SchemaDraft } from "@/hooks/useSchemas";
import type { ContentListEntry } from "@/lib/api";
import { entryLabel } from "@/lib/entries";

export interface PendingDeletionBannerProps {
  /** Tombstoned fields in the draft; the banner renders when this is non-empty. */
  deletedFields: SchemaDraft[];
  /** The schema's total entry count. */
  entryCount?: number;
  /** Rows for the "View affected entries" overlay. */
  entries?: ContentListEntry[];
  entriesPending?: boolean;
  /** Copy explaining why Save is disabled (if the tombstones would leave the schema invalid). */
  blockReason?: string | null;
  /** Field ID used to derive the human-readable entry label. */
  labelFieldId: number | null;
}

export function PendingDeletionBanner({
  deletedFields,
  entryCount,
  entries,
  entriesPending = false,
  blockReason = null,
  labelFieldId,
}: PendingDeletionBannerProps) {
  const [open, setOpen] = useState(false);

  if (deletedFields.length === 0) {
    return null;
  }

  const names = deletedFields.map((field) => field.label.trim() || "Unnamed");

  return (
    <Alert variant="destructive">
      <AlertAction>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Eye aria-hidden="true" />
          View affected entries
        </Button>
      </AlertAction>
      <AlertTitle>Fields pending deletion</AlertTitle>
      <AlertDescription>
        {names.length === 1 ? (
          <span className="block">
            The field &quot;{names[0]}&quot; will be deleted when you save your changes.
          </span>
        ) : (
          <span className="block">
            {names.length} fields will be deleted when you save your changes: {names.join(", ")}.
          </span>
        )}
        {entryCount != null && (
          <span className="mt-1 block">
            This schema has {entryCount} {entryCount === 1 ? "entry" : "entries"}.
          </span>
        )}
        {blockReason && <span className="mt-1 block">{blockReason}</span>}
      </AlertDescription>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Affected entries</DialogTitle>
            <DialogDescription>
              Fields removed from this schema have their values deleted from these entries when you save.
            </DialogDescription>
          </DialogHeader>
          {entriesPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading entries…</p>
          ) : entries == null || entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No entries in this schema yet.</p>
          ) : (
            <ul className="max-h-60 list-none space-y-1 overflow-auto rounded-md border bg-muted/40 p-2 text-sm">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-foreground">{entryLabel(entry, labelFieldId)}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </Alert>
  );
}