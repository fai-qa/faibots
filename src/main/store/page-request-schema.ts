// Retain a withheld request when its Page or source is withdrawn. Each use resolves the
// saved project, Page, revision and digest against the current authoritative records.
export const PAGE_REQUEST_SCHEMA = `
  alter table project_result_requests rename to prior_project_result_requests;
  create table project_result_requests (
    id text primary key, session_id text references project_sessions(id), answer_id text references project_answers(id),
    owner_id text not null, conversation_id text not null references conversations(id) on delete cascade,
    entry_id text not null unique references entries(id) on delete cascade, instruction text not null,
    state text not null check(state in ('queued','started','finished','interrupted')), turn_id text,
    page_id text, page_revision_id text, page_sha256 text, project_id text, host_id text, environment_id text,
    check((session_id is not null and answer_id is not null and page_id is null and page_revision_id is null
      and page_sha256 is null and project_id is null and host_id is null and environment_id is null)
      or (session_id is null and answer_id is null and page_id is not null and page_revision_id is not null
      and page_sha256 is not null and project_id is not null and host_id is not null and environment_id is not null))
  );
  insert into project_result_requests(rowid,id,session_id,answer_id,owner_id,conversation_id,entry_id,instruction,state,turn_id)
    select rowid,id,session_id,answer_id,owner_id,conversation_id,entry_id,instruction,state,turn_id from prior_project_result_requests;
  drop table prior_project_result_requests;
  create index project_result_dispatch on project_result_requests(state) where state in ('queued','started');
`
