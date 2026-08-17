import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SchemaUpdatePreviewEntry } from "@/lib/api";

export interface SchemaSaveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  previewPending: boolean;
  previewError: string | null;
  affectedCount: number | null; // null while preview is loading
  affectedEntries: SchemaUpdatePreviewEntry[] | null; // null while preview is loading
  savePending: boolean;
  saveError: string | null;
  onConfirm: () => void;
}

const MAX_LISTED_ENTRIES = 50;

export function SchemaSaveConfirmDialog({
  open,
  onOpenChange,
  schemaName,
  previewPending,
  previewError,
  affectedCount,
  affectedEntries,
  savePending,
  saveError,
  onConfirm,
}: SchemaSaveConfirmDialogProps) {
  const previewResolved = !previewPending && !previewError && affectedEntries != null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {schemaName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {previewPending ? (
              "Checking how many entries are affected…"
            ) : previewError ? (
              "Couldn't check the impact of this change."
            ) : (
              <>
                <span className="block">This change will make stored values out of date.</span>
                <span className="mt-1 block">
                  This will affect {affectedCount} {affectedCount === 1 ? "entry" : "entries"}.
                </span>
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {previewResolved && affectedEntries.length > 0 && (
          <ul className="max-h-60 list-none space-y-1 overflow-auto rounded-md border bg-muted/40 p-2 text-sm">
            {affectedEntries.slice(0, MAX_LISTED_ENTRIES).map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-foreground">{entry.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">#{entry.id}</span>
              </li>
            ))}
            {affectedEntries.length > MAX_LISTED_ENTRIES && (
              <li className="text-xs text-muted-foreground">
                …and {affectedEntries.length - MAX_LISTED_ENTRIES} more
              </li>
            )}
          </ul>
        )}

        {saveError && (
          <Alert variant="destructive">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={previewPending || previewError != null || savePending} onClick={onConfirm}>
            {savePending ? "Saving…" : "Save changes"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}