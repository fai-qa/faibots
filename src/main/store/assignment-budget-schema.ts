// Admissions outlive a cleared transcript so that deleting a chat cannot refund a running budget.
export const ASSIGNMENT_BUDGET_SCHEMA = `
  create table assignment_admissions (
    assignment_id text primary key,
    root_turn_id text not null,
    root_conversation_id text not null,
    parent_assignment_id text,
    created_at integer not null
  );
  create index assignment_root on assignment_admissions(root_turn_id);
  create index assignment_room on assignment_admissions(root_conversation_id, created_at);
`
