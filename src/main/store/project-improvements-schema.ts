export const PROJECT_IMPROVEMENTS_SCHEMA = `
  create table improvement_candidates (
    id text primary key, project_id text not null references projects(id) on delete cascade,
    version integer not null, instruction text not null, required_text text not null,
    matched text not null references journey_runs(id), heldout text not null references journey_runs(id),
    base text, decision text not null check(decision in ('proposed','approved','rejected')),
    created_at integer not null, reviewed_at integer,
    unique(project_id,version), check(matched != heldout)
  );
  create table improvement_runs (
    run_id text primary key references journey_runs(id) on delete cascade,
    candidate_id text not null references improvement_candidates(id) on delete cascade,
    lane text not null check(lane in ('production','matched','heldout')),
    baseline_id text references journey_runs(id), observed text not null check(observed in ('pending','passed','failed')),
    reason text not null, sha256 text, created_at integer not null
  );
  create index improvement_run_version on improvement_runs(candidate_id,lane,created_at);
  create table improvement_history (
    seq integer primary key, project_id text not null references projects(id) on delete cascade,
    before_id text references improvement_candidates(id), after_id text references improvement_candidates(id),
    action text not null check(action in ('publish','rollback')), created_at integer not null
  );
  create index improvement_project_history on improvement_history(project_id,seq);
`
