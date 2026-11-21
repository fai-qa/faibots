export const SESSION_SCHEMA = `
create table session_hosts (
  host_key text primary key, host_id text not null unique
);
create table session_environments (
  host_id text not null references session_hosts(host_id), root_key text not null,
  environment_id text not null unique, primary key(host_id,root_key)
);
create table project_sessions (
  id text primary key, project_id text not null references projects(id), host_id text not null references session_hosts(host_id),
  environment_id text not null references session_environments(environment_id), owner_id text not null,
  label text not null, mode text not null check(mode in ('fresh','fork')), parent_id text references project_sessions(id),
  engine text not null, sources text not null, created_at integer not null
);
create index project_sessions_scope on project_sessions(project_id,host_id,environment_id);
create table project_answers (
  id text primary key, session_id text not null references project_sessions(id),
  query text not null, payload text not null, created_at integer not null
);
create index project_answers_session on project_answers(session_id);
create table project_history_selection (
  session_id text not null references project_sessions(id), answer_id text not null references project_answers(id),
  primary key(session_id,answer_id)
);
`
