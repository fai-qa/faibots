/** v17 keeps native dispatch metadata separate from message bodies and provider sessions. */
export const TURN_CONTEXT_SCHEMA = `
create table turn_context_receipts (
  turn_id text primary key,
  conversation_id text references conversations(id) on delete cascade,
  session_id text references project_sessions(id) on delete cascade,
  project_id text references projects(id) on delete cascade,
  payload text not null,
  check ((conversation_id is null) <> (session_id is null)),
  check (session_id is null or project_id is not null)
);
create index context_by_chat on turn_context_receipts(conversation_id);
create index context_by_session on turn_context_receipts(session_id,project_id);
`
