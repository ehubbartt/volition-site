-- Atomically accept a team invite.
-- Returns the new team id on success.
-- Errors raised on:
--   - invite not found / not pending / not addressed to caller
--   - either party is already on a team
--   - either party is not signed up for the event
--   - event not in 'open' status
--
-- Call via Supabase RPC: supabase.rpc('vs_accept_invite', { p_invite_id, p_user_id })

create or replace function vs_accept_invite(p_invite_id uuid, p_user_id uuid)
returns uuid
language plpgsql
as $$
declare
    v_event_id      uuid;
    v_from_user_id  uuid;
    v_to_user_id    uuid;
    v_status        text;
    v_event_status  text;
    v_from_signup   uuid;
    v_to_signup     uuid;
    v_from_team     uuid;
    v_to_team       uuid;
    v_team_id       uuid;
begin
    -- Lock the invite row
    select event_id, from_user_id, to_user_id, status
      into v_event_id, v_from_user_id, v_to_user_id, v_status
      from vs_team_invites
     where id = p_invite_id
     for update;

    if not found then
        raise exception 'invite_not_found' using errcode = 'P0001';
    end if;

    if v_to_user_id <> p_user_id then
        raise exception 'invite_not_yours' using errcode = 'P0001';
    end if;

    if v_status <> 'pending' then
        raise exception 'invite_not_pending' using errcode = 'P0001';
    end if;

    -- Confirm event is still open
    select status into v_event_status
      from vs_events
     where id = v_event_id;

    if v_event_status <> 'open' then
        raise exception 'event_not_open' using errcode = 'P0001';
    end if;

    -- Lock both users' signup rows
    select id, team_id
      into v_from_signup, v_from_team
      from vs_event_signups
     where event_id = v_event_id and user_id = v_from_user_id
     for update;

    if not found then
        raise exception 'inviter_not_signed_up' using errcode = 'P0001';
    end if;

    select id, team_id
      into v_to_signup, v_to_team
      from vs_event_signups
     where event_id = v_event_id and user_id = v_to_user_id
     for update;

    if not found then
        raise exception 'invitee_not_signed_up' using errcode = 'P0001';
    end if;

    if v_from_team is not null then
        raise exception 'inviter_already_teamed' using errcode = 'P0001';
    end if;

    if v_to_team is not null then
        raise exception 'invitee_already_teamed' using errcode = 'P0001';
    end if;

    -- Create the team
    insert into vs_teams (event_id, created_by)
         values (v_event_id, v_from_user_id)
      returning id into v_team_id;

    -- Assign both signups to the team
    update vs_event_signups
       set team_id = v_team_id
     where id in (v_from_signup, v_to_signup);

    -- Mark this invite accepted
    update vs_team_invites
       set status = 'accepted', responded_at = now()
     where id = p_invite_id;

    -- Cancel all other pending invites involving either user for this event
    update vs_team_invites
       set status = 'cancelled', responded_at = now()
     where event_id = v_event_id
       and status = 'pending'
       and id <> p_invite_id
       and (
           from_user_id in (v_from_user_id, v_to_user_id)
        or to_user_id   in (v_from_user_id, v_to_user_id)
       );

    return v_team_id;
end;
$$;
