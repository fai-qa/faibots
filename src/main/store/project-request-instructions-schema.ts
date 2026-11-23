export const PROJECT_REQUEST_INSTRUCTIONS_SCHEMA = `
  create table project_request_instructions (
    entry_id text primary key references project_result_requests(entry_id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    candidate_id text references improvement_candidates(id)
  );
`
