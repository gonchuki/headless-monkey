import { Router, Request, Response } from "express";
import type { ContentService, ContentEntry, ContentValue } from "../services/contentService";
import type { SchemaEntry } from "../types";

interface ServiceError {
  statusCode: number;
  message: string;
}

function isErrorWithStatus(err: unknown): err is ServiceError {
  return typeof err === "object" && err !== null && "statusCode" in err && "message" in err;
}

function handleError(res: Response, err: unknown): void {
  if (isErrorWithStatus(err)) {
    res.status(err.statusCode).json({ error: err.message });
  } else {
    res.status(500).json({ error: "Internal server error" });
  }
}

interface PublicContentMeta {
  name: string;
  version: number;
  fields: Record<string, string>;
}

interface PublicContentResponse {
  meta: PublicContentMeta;
  entries: ContentEntry[];
}

/**
 * SPEC v0.7 public wire projection. Built at the HTTP boundary only: the
 * service still returns the label-keyed public shape (contentService.test.ts
 * pins it), and this is the single place that re-keys values to
 * String(field_id) and emits the {meta, entries} wrapper (SPEC §4, R15/R18/R19).
 */
function buildMeta(schema: SchemaEntry): PublicContentMeta {
  return {
    name: schema.name,
    version: schema.version,
    fields: Object.fromEntries(schema.fields.map((f) => [String(f.id), f.label])),
  };
}

/** Re-key one public entry's values from field labels to String(field_id). */
function rekeyValues(
  entry: ContentEntry,
  labelToId: Map<string, number>
): Record<string, ContentValue> {
  const values: Record<string, ContentValue> = {};
  for (const [label, value] of Object.entries(entry.values)) {
    const fieldId = labelToId.get(label);
    if (fieldId !== undefined) {
      values[String(fieldId)] = value;
    }
  }
  return values;
}

export function createContentRouter(contentService: ContentService): Router {
  const router: Router = Router();

  router.get("/:schema", (req: Request, res: Response) => {
    try {
      const schemaName = typeof req.params.schema === "string" ? req.params.schema : "";
      const schema = contentService.getSchema(schemaName);
      const labelToId = new Map(schema.fields.map((f) => [f.label, f.id]));
      const entries = contentService.listPublic(schemaName);
      const body: PublicContentResponse = {
        meta: buildMeta(schema),
        entries: entries.map((entry) => ({ ...entry, values: rekeyValues(entry, labelToId) })),
      };
      res.json(body);
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get("/:schema/:id", (req: Request, res: Response) => {
    try {
      const schemaName = typeof req.params.schema === "string" ? req.params.schema : "";
      const id = Number(req.params.id);
      const schema = contentService.getSchema(schemaName);
      const labelToId = new Map(schema.fields.map((f) => [f.label, f.id]));
      const entry = contentService.getPublic(schemaName, id);
      const body: PublicContentResponse = {
        meta: buildMeta(schema),
        entries: [{ ...entry, values: rekeyValues(entry, labelToId) }],
      };
      res.json(body);
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}
