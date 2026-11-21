// Each attached note starts an independently versioned Library item. Earlier attachments
// keep their original project scope and explicit attachment decision.
export const PROJECT_CONTENT_SCHEMA = `
create table project_spaces (
  id text primary key, project_id text not null unique references projects(id) on delete cascade, name text not null
);
insert into project_spaces select id,id,'Project space' from projects;
create trigger project_default_space after insert on projects begin
  insert into project_spaces values (new.id,new.id,'Project space');
end;
create table library_items (
  id text primary key, owner_id text not null references projects(id) on delete cascade
);
create table library_revisions (
  item_id text not null references library_items(id) on delete cascade,
  revision integer not null check(revision > 0),
  source_id text not null unique references project_sources(id) on delete cascade, primary key(item_id,revision)
);
create table library_access (
  project_id text not null references projects(id) on delete cascade,
  item_id text not null references library_items(id) on delete cascade,
  selected integer not null default 0, revoked integer not null default 0, primary key(project_id,item_id)
);
insert into library_items select id,project_id from project_sources;
insert into library_revisions select id,1,id from project_sources;
insert into library_access select project_id,id,1,0 from project_sources;
create table project_context (
  run_id text primary key references journey_runs(id) on delete cascade,
  space_id text not null references project_spaces(id) on delete cascade, rubric text not null,
  sources text not null, baseline_run_id text references journey_runs(id) on delete set null
);
create table space_pages (
  id text primary key, run_id text not null unique references project_context(run_id) on delete cascade,
  revision_id text not null references artifact_revisions(id) on delete cascade,
  review_id text not null references review_decisions(id) on delete cascade, created_at integer not null
);
create table project_run_turns (
  run_id text not null references project_context(run_id) on delete cascade, turn_id text not null, phase text not null,
  primary key(run_id,turn_id)
);
create table project_evaluations (
  run_id text primary key references project_context(run_id) on delete cascade, observed text not null,
  reason text not null, revision_id text, reviewer text, turns integer not null, created_at integer not null
);
create table evaluation_trials (
  id integer primary key, run_id text not null references project_evaluations(run_id) on delete cascade,
  candidate_id text not null, outcome text not null, reason text not null, created_at integer not null,
  integrity text not null, contract text not null
);
`
