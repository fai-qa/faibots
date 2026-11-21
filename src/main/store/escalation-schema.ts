// A pointer to owner-selected excerpts survives agent compaction. Text remains in its source DM.
export const ESCALATION_SCHEMA = `
create table specialist_escalations (
  id text primary key, signature text not null, source_chat text not null, specialist_id text not null,
  chief_chat text not null, chief_id text not null, work_id text, scope text, pins text not null, question text not null,
  excerpts text not null, destination_entry text unique, created_at integer not null, work_revision integer
);
create index specialist_escalations_source on specialist_escalations(source_chat,created_at);
create index specialist_escalations_work on specialist_escalations(chief_chat,work_id);
`
