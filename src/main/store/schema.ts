// Schema migrations, applied in order. PRAGMA user_version holds how many have run.
// Never edit a shipped migration: append a new one.
import { TURN_CONTEXT_SCHEMA } from './turn-context-schema'
import { DELEGATION_ATTEMPT_SCHEMA } from './delegation-attempt-schema'
import { ARTIFACT_SAVE_SCHEMA } from './artifact-save-schema'
import { workBriefSchema, workConstraintsSchema } from './work-brief-schema'
import { ASSIGNMENT_BUDGET_SCHEMA } from './assignment-budget-schema'

import { PROJECT_CONTENT_SCHEMA } from './project-content-schema'
import { SESSION_SCHEMA } from './session-schema'
import { PROJECT_IMPROVEMENTS_SCHEMA } from './project-improvements-schema'
import { ESCALATION_SCHEMA } from './escalation-schema'

export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  create table settings (
    id integer primary key check (id = 1),
    data text not null
  );

  create table bots (
    id text primary key,
    name text not null,
    handle text not null unique,
    label text not null default '',
    description text not null default '',
    soul text not null default '',
    avatar text not null,
    model text not null,
    is_primary integer not null default 0,
    tool_permissions text not null default '{}',
    mcp_server_ids text not null default '"all"',
    skill_ids text not null default '[]',
    notify integer not null default 1,
    pinned integer not null default 0,
    hidden integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );

  create table conversations (
    id text primary key,
    kind text not null check (kind in ('dm', 'group', 'exchange')),
    title text not null default '',
    bot_ids text not null,
    group_settings text,
    origin text,
    notes text not null default '',
    last_entry_at integer not null,
    unread_count integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );

  create table entries (
    id text primary key,
    conversation_id text not null references conversations(id) on delete cascade,
    seq integer not null,
    kind text not null,
    author text not null,
    text text not null default '',
    mentions text not null default '[]',
    mentions_everyone integer not null default 0,
    reply_to_id text,
    attachments text not null default '[]',
    tool_call text,
    approval text,
    is_streaming integer not null default 0,
    client_nonce text,
    meta text,
    created_at integer not null,
    updated_at integer not null,
    unique (conversation_id, seq)
  );
  create unique index entries_nonce on entries(conversation_id, client_nonce) where client_nonce is not null;

  create table bot_context (
    conversation_id text not null references conversations(id) on delete cascade,
    bot_id text not null,
    last_seen_seq integer not null default 0,
    summary text not null default '',
    summarized_up_to_seq integer not null default 0,
    engine_session_id text,
    primary key (conversation_id, bot_id)
  );

  create table providers (
    id text primary key,
    kind text not null,
    label text not null,
    base_url text,
    has_api_key integer not null default 0,
    default_model_id text not null default '',
    enabled integer not null default 1,
    created_at integer not null,
    updated_at integer not null
  );

  create table memory_profiles (
    bot_id text primary key references bots(id) on delete cascade,
    content text not null,
    updated_at integer not null
  );

  -- rid is an explicit integer key so the FTS index can point at it safely (plain rowids may
  -- change on VACUUM for tables without one).
  create table memory_facts (
    rid integer primary key,
    id text not null unique,
    bot_id text not null references bots(id) on delete cascade,
    text text not null,
    pinned integer not null default 0,
    source text,
    created_by text not null,
    created_at integer not null,
    updated_at integer not null
  );
  create index memory_facts_bot on memory_facts(bot_id, created_at);

  create virtual table memory_fts using fts5(
    text, content = 'memory_facts', content_rowid = 'rid', tokenize = 'unicode61 remove_diacritics 2'
  );
  create trigger memory_facts_ai after insert on memory_facts begin
    insert into memory_fts(rowid, text) values (new.rid, new.text);
  end;
  create trigger memory_facts_ad after delete on memory_facts begin
    insert into memory_fts(memory_fts, rowid, text) values ('delete', old.rid, old.text);
  end;
  create trigger memory_facts_au after update of text on memory_facts begin
    insert into memory_fts(memory_fts, rowid, text) values ('delete', old.rid, old.text);
    insert into memory_fts(rowid, text) values (new.rid, new.text);
  end;

  create table secrets (
    id text primary key,
    name text not null,
    description text not null default '',
    bot_id text references bots(id) on delete cascade,
    created_at integer not null,
    updated_at integer not null
  );
  create unique index secrets_name on secrets(coalesce(bot_id, ''), name);

  create table mcp_servers (
    id text primary key,
    name text not null unique,
    data text not null,
    created_at integer not null,
    updated_at integer not null
  );
  `,

  /* 2: turn log for usage and daily limits, routines and their runs */ `
  alter table bots add column daily_run_limit integer not null default 0;
  alter table entries add column trigger text;

  -- One row per bot turn that reached a model. Usage totals and daily limits are queries over it.
  create table turns (
    id text primary key,
    bot_id text not null references bots(id) on delete cascade,
    conversation_id text not null,
    conversation_kind text not null,
    trigger text not null check (trigger in ('user', 'group', 'agent', 'routine')),
    status text not null,
    provider_id text not null default '',
    model_id text not null default '',
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    started_at integer not null,
    ended_at integer not null,
    error text
  );
  create index turns_bot_time on turns(bot_id, started_at);
  create index turns_time on turns(started_at);

  create table routines (
    id text primary key,
    bot_id text not null references bots(id) on delete cascade,
    name text not null,
    prompt text not null,
    schedule text not null,
    enabled integer not null default 1,
    webhook_enabled integer not null default 0,
    webhook_token_hash text,
    created_by text not null default 'user',
    last_run_at integer,
    next_run_at integer,
    created_at integer not null,
    updated_at integer not null
  );
  create index routines_bot on routines(bot_id);

  create table routine_runs (
    id text primary key,
    routine_id text not null references routines(id) on delete cascade,
    bot_id text not null,
    trigger text not null,
    status text not null,
    started_at integer not null,
    ended_at integer,
    conversation_id text,
    entry_id text,
    summary text not null default '',
    error text
  );
  create index routine_runs_routine on routine_runs(routine_id, started_at);
  `,

  /* 3: native action identities and receipts. Retained across transcript reset/deletion. */ `
  create table actions (
    id text primary key,
    bot_id text not null,
    conversation_id text not null,
    tool_name text not null,
    input_digest text not null,
    capability text not null,
    state text not null check (state in ('prepared','claimed','dispatched','recovering','unknown','completed','denied','cancelled')),
    attempt text,
    approved_digest text,
    receipt text,
    created_at integer not null,
    updated_at integer not null
  );
  create index actions_unresolved on actions(bot_id, conversation_id, tool_name, input_digest, state);
  `,

  /* 4: reservations survive a crash before usage logging; routine acceptance is distinct from execution. */ `
  create table automatic_run_admissions (
    id text primary key,
    bot_id text not null,
    started_at integer not null
  );
  create index automatic_admissions_bot_time on automatic_run_admissions(bot_id, started_at);
  alter table routines add column acceptance text;
  alter table routine_runs add column acceptance text;
  `,

  /* 5: which engine made a stored session, and a hash of the last system block delivered to it. */ `
  alter table bot_context add column engine_binding text;
  alter table bot_context add column system_hash text;
  `,

  /* 6: first journey (M1a): record-only projects, note sources, Markdown artifacts, their
     host-snapshotted revisions and reviewed decisions. Spaces/host/environment stay deferred. */ `
  create table projects (
    id text primary key,
    name text not null,
    description text not null default '',
    created_at integer not null,
    updated_at integer not null
  );

  create table project_sources (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    attachment_id text not null,
    name text not null,
    sha256 text not null,
    size_bytes integer not null,
    kind text not null check (kind in ('md', 'txt', 'pdf')),
    created_at integer not null
  );
  create index project_sources_project on project_sources(project_id);

  create table artifacts (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    name text not null,
    created_at integer not null,
    updated_at integer not null
  );
  create index artifacts_project on artifacts(project_id);

  create table artifact_revisions (
    id text primary key,
    artifact_id text not null references artifacts(id) on delete cascade,
    revision_no integer not null,
    sha256 text not null,
    provenance text not null default '{}',
    created_at integer not null,
    unique (artifact_id, revision_no)
  );

  create table review_decisions (
    id text primary key,
    artifact_revision_id text not null references artifact_revisions(id) on delete cascade,
    rubric text not null,
    reviewer text not null,
    decision text not null check (decision in ('accepted', 'repair', 'partial', 'rejected')),
    explanation text not null default '',
    created_at integer not null
  );
  create index review_decisions_revision on review_decisions(artifact_revision_id);
  `,

  /* 7: first journey (M1c): mission runs with their B1-B11 budgets; artifacts gain
     their kind (proposal) and host state (draft -> reviewed). */ `
  alter table artifacts add column kind text not null default 'proposal';
  alter table artifacts add column status text not null default 'draft';

  create table journey_runs (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    artifact_id text references artifacts(id) on delete set null,
    status text not null check (status in ('working', 'waiting_review', 'complete', 'partial', 'failed')),
    error text,
    budgets text not null default '{}',
    started_at integer not null,
    ended_at integer
  );
  create index journey_runs_project on journey_runs(project_id, started_at);
  `,

  /* 8: durable send_to_agent assignments, fenced child execution and parent delivery. */ `
  create table delegations (
    id text primary key,
    caller_id text not null,
    child_id text not null,
    input_hash text not null,
    parent_entry_id text not null references entries(id) on delete cascade,
    question_id text not null references entries(id) on delete cascade,
    state text not null check (state in ('assigned','answered','failed','reconciliation_required')),
    lease text,
    engine text,
    system_hash text,
    receipt text,
    delivered_at integer,
    created_at integer not null,
    updated_at integer not null,
    check ((state = 'assigned') = (lease is not null))
  );
  create index delegations_pending on delegations(id) where delivered_at is null;
  `,
  PROJECT_CONTENT_SCHEMA,
  PROJECT_IMPROVEMENTS_SCHEMA,
  workBriefSchema,
  ASSIGNMENT_BUDGET_SCHEMA,
  SESSION_SCHEMA,
  ESCALATION_SCHEMA,
  ARTIFACT_SAVE_SCHEMA,
  DELEGATION_ATTEMPT_SCHEMA,
  TURN_CONTEXT_SCHEMA,
  /* 18: Codex exec reports cumulative thread usage. Older turn values remain as observed. */ `
  alter table bot_context add column codex_usage_baseline text;
  alter table turns add column codex_usage_state text check(codex_usage_state in ('measured','unknown'));
  alter table turns add column root_turn_id text;
  alter table automatic_run_admissions add column root_turn_id text;
  create index turns_by_root on turns(root_turn_id);
  create index admissions_by_root on automatic_run_admissions(root_turn_id);
  create index entries_by_turn on entries(json_extract(meta,'$.turnId')) where json_valid(meta);
  `,
  /* 19: an explicit selected-result request owns exactly one user entry in fai's DM. */ `
  create table project_result_requests (
    id text primary key, session_id text not null references project_sessions(id),
    answer_id text not null references project_answers(id), owner_id text not null,
    conversation_id text not null references conversations(id) on delete cascade,
    entry_id text not null unique references entries(id) on delete cascade,
    instruction text not null, state text not null check(state in ('queued','started','finished','interrupted')),
    turn_id text
  );
  create index project_result_dispatch on project_result_requests(state) where state in ('queued','started');
  `,
  /* 20: keep the original per-job scope and assignment limit across turns. */ workConstraintsSchema,
  /* 21: index existing assignment and reply links for the scoped exchange transcript. */ `
  create index delegation_parent_entry on delegations(parent_entry_id);
  create index delegation_question on delegations(question_id);
  create index assignment_children on assignment_admissions(parent_assignment_id);
  create index message_replies on entries(reply_to_id) where kind='message' and reply_to_id is not null;
  `
]
