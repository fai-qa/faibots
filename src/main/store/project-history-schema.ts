/** Retire mixed model sessions while preserving the human-readable transcript and project records. */
export const PROJECT_HISTORY_SCHEMA = `
  create temp table scoped_history_ids (id text primary key);

  -- Older messages without a completion receipt can still be attributed to a mission step in
  -- its DM until the next owner message or automated input. Keep that next input outside it.
  with mission_dms as (
    select distinct conversation_id from entries where json_valid(trigger) and json_extract(trigger,'$.kind')='mission'
  ), phases as (
    select e.id,e.conversation_id,e.seq,max(case when e.kind='message' and
      (e.trigger is not null or e.author='user' or (json_valid(e.author) and json_extract(e.author,'$.kind')='user'))
      then e.seq end) over(partition by e.conversation_id order by e.seq) as start_seq
    from entries e join mission_dms m on m.conversation_id=e.conversation_id
  )
  insert into scoped_history_ids
    select p.id from phases p join entries start on start.conversation_id=p.conversation_id and start.seq=p.start_seq
    where json_valid(start.trigger) and json_extract(start.trigger,'$.kind')='mission';

  -- Durable execution identity also covers interleaved child exchanges and nested workers.
  with project_turns(id) as (
    select turn_id from project_run_turns union
    select t.id from turns t join project_run_turns p on p.turn_id=t.root_turn_id
  )
  insert or ignore into scoped_history_ids
    select e.id from entries e join project_turns t on t.id=json_extract(e.meta,'$.turnId') where json_valid(e.meta);
  with project_assignments(assignment_id) as (
    select d.id from delegations d join scoped_history_ids h on h.id=d.parent_entry_id
    union select a.assignment_id from assignment_admissions a join project_run_turns p on p.turn_id=a.root_turn_id
    union select a.assignment_id from assignment_admissions a join project_assignments parent on parent.assignment_id=a.parent_assignment_id
  )
  insert or ignore into scoped_history_ids
    select d.question_id from delegations d join project_assignments a on a.assignment_id=d.id;
  insert or ignore into scoped_history_ids select e.id from entries e join scoped_history_ids h on h.id=e.reply_to_id;

  update entries set meta=json_set(case when meta is null then '{}' when json_valid(meta) then meta
      else json_object('unparsed',meta) end,'$.projectScoped',json('true'))
    where id in (select id from scoped_history_ids);
  update bot_context set summary='', summarized_up_to_seq=0, engine_session_id=null,
    engine_binding=null, system_hash=null, codex_usage_baseline=null
    where conversation_id in (select e.conversation_id from entries e join scoped_history_ids h on h.id=e.id);
  drop table scoped_history_ids;
`
