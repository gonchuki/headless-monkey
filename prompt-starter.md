I'm building a minimal CMS with a terse data retrieval API layer and the corresponding control panel for data entry. 

The system uses an `express` server with an sqlite db (using `better-sqlite3`) and frontend uses `react-router@7` (SPA mode, for simplicity), `shadcn` with `base-ui` (not Radix) to implement interactive UI components and `phosphor-icons/react` instead of the usual and overused`lucide-react`.  Data access in the frontend is to be handled with `tanstack-query` at all times (raw fetch with `useEffect` is forbidden). Prefer skeleton loaders to notify a pure loading state when we have no data available and use optimistic updates when we are mutating data.

The system needs a thin login layer with a user/password form. A preset admin password is loaded from `.env` and is the only admin of the system, fixed `admin` username. A minimal CRUD also needs to be created to administer users on the system. Only 2 user roles exist: `admin` and `editor`.  `admin` is a user that does not exist in the DB and thus cannot access the CMS control panel, their only purpose is to add/remove editors on the system. `users` table just holds `id`, `login`, `hashed_password` and a boolean `disabled` column that allows revoking access. No additional data about editors is to be stored.

Editors land in the CMS control panel that lists existing data schemas and allows building new ones, and allows creating/editing pieces of content that peruse the schemas defined in the application. 

## Data model

Schema table has to store:
- `name`: content type (string, `UNIQUE INDEX`)
- `creation_date`: creation date
- `created_by`: created by
- `last_modified_date`: last modified date
- `last_modified_by`: last modified by
- `version`: sequential number version that increments after each edit of the schema
- `compat_version`: version number that indicates up to which previous version of the schema content is allowed to be compatible as opposed to conflicted (explained below)

`name` doubles as the identifier for the schema

Content table stores:
- `id`: autoincrement number for simplicity
- `schema`: schema it uses
- `schema_version`: schema version of the latest edit
- `creation_date`: creation date
- `created_by`: created by
- `last_modified_date`: last modified date
- `last_modified_by`: last modified by

Plus additional tables with data that joins against their respective definitions (`schema_fields`, `content_rows`, etc.).

### The `compat_version` column

Certain changes of the schema allow for compatibility with existing entries (non-breaking changes):
- a new optional field
- a field that switches type from `number` to `text`
- a field that was previously required and is made optional

`version` is always incremented by one when updating a schema, but non-breaking changes allow the `compat_version` column to retain the existing value. When a schema is created both `version` and `compat_version` are set to `1`.

Content always records the latest version of the schema that was used to edit such entry, if that version is `>= compat_version` of the schema it's based against then that content entry is considered valid, otherwise it's considered in conflict and cannot be retrieved via API (return HTTP code 422) and it's highlighted in the control panel listings so editors know about conflicts they have to solve.

## Building schemas

The user specifies a name for the schema (a unique identifier used as a content type, stored as `UNIQUE INDEX` in the db) and must add one or more required fields before being able to save the schema to the database.

Allowed typed fields (type: label) are:
- `text`: Text
- `number`: Number
- `boolean`: Boolean
- `date`: Date
- `schema-ref`: Schema

For example a Car might be defined by:
```
car {
  brand: text
  year: number
  purchase_date: date
  owner: schema-ref<Person>
}
```

where `schema-ref<Person>` is cross reference against the Person schema.

All fields are required by default and can be made optional. Circular references are forbidden (if `car` points to `person`, person cannot have a `schema-ref` field pointing back to `car`).

Schema editor renders as a 3 column sortable grid in the form of `field_label` | `field_type` | `required`.

### Deleting schemas

Deleting a schema requires confirmation. An `<Alert />` message is displayed to warn the user about pieces of data that will lose their schema and thus will be deleted in tandem with the schema on approval: no piece of data can exist without a valid schema that defines it.

### Editing schemas when data against the schema already exists

Deleting or changing the data type of a field requires confirmation. An `<Alert />` message is displayed notifying the count of affected entries.

A deleted field propagates through the db removing that piece of data from affected entries and their `schema_version` is bumped to the latest `version` of the schema (conflict is auto-solved by the write operation). Changing the data type or the `required` property of a field doesn't trigger any propagation mechanism.

rationale: Version mismatches are handled by read operations, but orphaned data is proactively removed just like when deleting entire schemas.

## Content editor 

Once a schema is defined, the data entry editor can be used to create content against that schema. The editor displays a dynamic 2-column form with schema-based rows displaying as `label: data-type-input`, where `data-type-input` is based on the corresponding schema-defined data type for that field. Required fields are marked with a red `*` next to their label.

Data entry editor can be accessed from 3 places:
- global nav: button that allows creating a new entry -> intermediate screen is displayed asking the user to select the schema to use. Disabled when no schemas exist in the db
- entry listing table: each entry row has an "edit" button to allow updating contents
- schema listing table: button per row that allows creating a new entry against the schema (skips schema selector)

Field types to use in the data entry form:
- text: `<input type="text" />`
- number: `<input type="number" />`
- date: `<input type="date" />`
- boolean: `<input type="checkbox" />`
- schema-ref: `<select>` links against data entries that match the content type of the cross referenced schema. Label with the value of the first required field on the target (based on sort order of the schema fields).

When editing content with a conflicted schema, display the old row as disabled in the UI along with the new enabled row right below it so the user can act accordingly.

# multi-user editing

Changes performed by one user are immediately reflected on the screen of logged-in peers looking at the same view or an entry that depends on the modified data. Changes from user A are notified through a toast on user's B screen if these changes affect their current view.

Data conflicts need to be solved gracefully: 
- user A deleting a field on a schema while user B is working on data that's based on that schema causes user B to see that field disabled, not abruptly deleted from their screen. 
- user A deleting a schema while user B is sitting on the schema listing screen sees the row disabled so they can't interact with it (same with data listing)
- user A deleting a schema while user B is editing that schema gets the entire schema editor disabled for user B plus a banner that notifies the user about the situation (same when editing an entry)
- user A changing the data type of a field to an incompatible type in the schema while user B is editing an entry based on that schema causes user B to see the old version of the field disabled and right below the newly typed field as empty.

The visual cue plus the toast notification lets the user handle the change without disrupting their flow. Use SSE to notify clients about changes.

# data API

the system provides a thin, stateless, unauthenticated API for data retrieval.

```
GET /api/content/car → all cars

GET /api/content/car/:id → one car
```

No pagination or search API is expected in the initial version, just respond the required data with JSON (200 if OK, 404 if the entry doesn't exist, 422 if the entry exists but uses a deprecated/conflicted schema) 

# file structure

single workspace `pnpm` repository, split `client` and `server` subfolders within `src/`.  

Split JSX at the seams: each component has a single responsibility, each `.tsx` file contains only one component. Move utilities to custom hooks, favor `useReducer` over opaque indirection via `useEffect` and `useRef`.
