# headless-monkey

Minimal CMS with a public read-only data API and an authenticated control panel for schema and content management.

`prompt-starter.md` is the original reference prompt this project was specced from; `SPEC.md` (binding) and `AGENTS.md` (engineering conventions) are the operative docs derived from it.

## Requirements

- Node.js 20+
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env   # then fill in ADMIN_PASSWORD and JWT_SECRET
```

`.env` (repo root) variables: `ADMIN_PASSWORD`, `JWT_SECRET`, `PORT`, `DATABASE_PATH`.

## Run

```sh
pnpm dev      # runs server + client; client proxies /api to the server
pnpm test     # runs server tests (vitest)
pnpm build    # builds both packages
```
