export const workBriefSchema = `
  create table chief_work (
    id text primary key, conversation_id text not null references conversations(id) on delete cascade, user_entry_id text not null unique references entries(id) on delete cascade,
    objective text not null, deliverable text not null, checks text not null,
    state text not null, revision integer not null, question text not null default '',
    result text not null default '', partial integer not null default 0, evidence_ids text not null default '[]', updated_at integer not null
  );
  create index chief_work_chat on chief_work(conversation_id, updated_at);
  create table chief_decisions (
    work_id text not null references chief_work(id) on delete cascade, revision integer not null, decision text not null,
    note text not null, created_at integer not null, pending_reply integer not null,
    primary key(work_id, revision)
  );
  create table chief_work_turns (turn_id text primary key, work_id text not null references chief_work(id) on delete cascade, work_revision integer not null);
  create index chief_work_turns_work on chief_work_turns(work_id);
  create table chief_wakes (
    work_id text not null references chief_work(id) on delete cascade, revision integer not null,
    state text not null check(state in ('pending','ready','started','finished','interrupted')),
    entry_id text, primary key(work_id,revision)
  );`
