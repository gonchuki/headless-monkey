import type { FieldWithId } from "../types";

export type ChangeKind =
  | "renamed"
  | "added"
  | "deleted"
  | "typeChanged"
  | "requiredChanged"
  | "reordered";

export interface ChangeItem {
  kind: ChangeKind;
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
  changes?: ChangeItem[];
}

export type RealtimeListener = (event: RealtimeEvent) => void;
export type Unsubscribe = () => void;

/**
 * In-memory fan-out emitter keyed by schema name. Subscribers register for a
 * single schema or for every schema (`null`); the SSE endpoint subscribes to
 * all schemas and the client filters to the schemas on screen.
 */
export class EventsEmitter {
  private all = new Set<RealtimeListener>();
  private bySchema = new Map<string, Set<RealtimeListener>>();

  subscribe(schema: string | null, listener: RealtimeListener): Unsubscribe {
    if (schema === null) {
      this.all.add(listener);
      return () => {
        this.all.delete(listener);
      };
    }

    let listeners = this.bySchema.get(schema);
    if (!listeners) {
      listeners = new Set();
      this.bySchema.set(schema, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) {
        this.bySchema.delete(schema);
      }
    };
  }

  emit(event: RealtimeEvent): void {
    for (const listener of [...this.all]) {
      listener(event);
    }
    const listeners = this.bySchema.get(event.schema);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    }
  }
}

/**
 * Builds the `changes` list for a `schema.updated` event by diffing the
 * id-stable fields before and after the update. Each field keeps its numeric
 * `field_id` (R15); comparing old vs. new per id yields the change kinds.
 */
export function computeSchemaChanges(
  oldFields: FieldWithId[],
  newFields: FieldWithId[]
): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const oldById = new Map(oldFields.map((field) => [field.id, field]));
  const newById = new Map(newFields.map((field) => [field.id, field]));

  for (const [id, oldField] of oldById) {
    if (!newById.has(id)) {
      changes.push({ kind: "deleted", fieldId: id, label: oldField.label });
    }
  }

  for (const [id, newField] of newById) {
    const oldField = oldById.get(id);
    if (!oldField) {
      changes.push({
        kind: "added",
        fieldId: id,
        label: newField.label,
        type: newField.type,
        required: newField.required,
      });
      continue;
    }

    if (oldField.type !== newField.type) {
      changes.push({
        kind: "typeChanged",
        fieldId: id,
        label: newField.label,
        type: newField.type,
      });
    }
    if (oldField.required !== newField.required) {
      changes.push({
        kind: "requiredChanged",
        fieldId: id,
        label: newField.label,
        required: newField.required,
      });
    }
    if (oldField.label !== newField.label) {
      changes.push({ kind: "renamed", fieldId: id, label: newField.label });
    }
    if (oldField.sort_order !== newField.sort_order) {
      changes.push({ kind: "reordered", fieldId: id, label: newField.label });
    }
  }

  return changes;
}
