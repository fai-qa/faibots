// Original worker identity remains fenced after its active lease is cleared.
// Historical terminal work has no reconstructible lease and cannot accept a late return.
export const DELEGATION_ATTEMPT_SCHEMA = `
  create table delegation_attempts (
    assignment_id text primary key references delegations(id) on delete cascade,
    original_lease text not null,
    late_text text,
    observed_at integer,
    check ((late_text is null) = (observed_at is null)),
    check (length(late_text) <= 4000)
  );
  create trigger delegation_attempt_identity before update of assignment_id,original_lease on delegation_attempts
    begin select raise(abort,'Original delegation attempt is immutable.'); end;
  create trigger delegation_observation_once before update of observed_at,late_text on delegation_attempts
    when old.observed_at is not null
    begin select raise(abort,'Late observation is already recorded.'); end;
  insert into delegation_attempts(assignment_id,original_lease)
    select id,lease from delegations where state='assigned' and lease is not null;
`
