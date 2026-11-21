export const ARTIFACT_SAVE_SCHEMA = `
  create table artifact_saves (
    run_id text primary key references journey_runs(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    artifact_id text not null references artifacts(id) on delete cascade,
    pinned_root text not null, provenance text not null,
    state text not null check(state in ('expected','captured','linked','unavailable')),
    sha256 text, body blob, revision_id text references artifact_revisions(id) on delete cascade
  );`
