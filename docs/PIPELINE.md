# Pipeline Stages

> ⚙️ **This file is meant to be generated**, but the generator (a `gen:docs` script reading
> `src/pipeline/stages.manifest.ts`) was never written — there's no such script in
> `package.json`. This remains a placeholder rather than fabricated content. The real,
> current description of all 12 stages (4 ingest + 8 query) — what each does, why it
> exists, the tool, and a link to its ADR — lives in
> [ARCHITECTURE.md §2–3](./ARCHITECTURE.md#2-ingest-pipeline-offline) and, with full
> command examples, in each stage's own `README.md` (linked from
> `src/pipeline/stages.manifest.ts`'s `doc` field).

If built, this file would render `stages.manifest.ts` into one page per stage: what it
does, why it exists, what breaks without it, the tool + version, rejected alternatives,
and a link to the governing ADR — the same data that already feeds the UI's `/stages`
endpoint and hover cards, so there'd be one source of truth instead of three.
