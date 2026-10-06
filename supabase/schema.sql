-- Study With Me: accounts, friends and shared study sessions.
-- Paste this whole file into the Supabase SQL editor and run it once.

-- One profile per Google account, made on first sign-in
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null,
  avatar_url text,
  invite_code text unique not null default substr(md5(random()::text), 1, 10),
  created_at timestamptz not null default now()
);
-- Names are typed in settings now, so they're kept to a sensible length
-- (not valid: only checked from here on, so long Google names already saved stay)
alter table profiles drop constraint if exists display_name_length;
alter table profiles add constraint display_name_length
  check (length(trim(display_name)) between 1 and 40) not valid;
-- Google profile photos aren't kept; avatar_url stays empty
update profiles set avatar_url = null where avatar_url is not null;

-- Every finished study turn; started_at is unique per person, so the page can
-- upload its whole local history again without making duplicates
create table if not exists sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  started_at timestamptz not null,
  ms integer not null check (ms > 0 and ms <= 86400000),
  unique (user_id, started_at)
);

-- What each person's timer is doing right now, written by their page as it
-- changes: the turn on the clock (kind, title, ms banked before the last
-- start, and since, when it last started, or null while paused), its length
-- in timer mode, and the turns already finished on their list
create table if not exists status (
  user_id uuid primary key references profiles on delete cascade default auth.uid(),
  kind text not null check (kind in ('study', 'brk')),
  title text not null,
  started_at timestamptz,
  banked_ms integer not null default 0,
  since timestamptz,
  target_ms integer,
  laps jsonb not null default '[]',
  place text,
  updated_at timestamptz not null default now()
);
alter table status add column if not exists place text;  -- where they're studying, as they typed it

-- A friendship is one row, from whoever asked to whoever was asked
create table if not exists friendships (
  requester uuid not null references profiles on delete cascade,
  addressee uuid not null references profiles on delete cascade,
  accepted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);

-- True when a and b are accepted friends
create or replace function are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where accepted and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

alter table profiles enable row level security;
alter table sessions enable row level security;
alter table friendships enable row level security;
alter table status enable row level security;

-- Profiles are visible to anyone signed in, so friends can be found by username
drop policy if exists "profiles read" on profiles;
create policy "profiles read" on profiles for select to authenticated using (true);
drop policy if exists "profiles insert own" on profiles;
create policy "profiles insert own" on profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Only these columns can be read or written directly. Invite codes stay out of
-- reach, since anyone holding one can become that person's friend; your own
-- comes from my_invite_code()
revoke select, insert, update on profiles from anon, authenticated;
grant select (id, username, display_name, avatar_url, created_at) on profiles to authenticated;
grant insert (id, username, display_name) on profiles to authenticated;
grant update (username, display_name) on profiles to authenticated;

create or replace function my_invite_code() returns text
language sql stable security definer set search_path = public as $$
  select invite_code from profiles where id = auth.uid();
$$;
grant execute on function my_invite_code() to authenticated;

-- Sessions: your own, plus your friends'
drop policy if exists "sessions read" on sessions;
create policy "sessions read" on sessions for select to authenticated
  using (user_id = auth.uid() or are_friends(auth.uid(), user_id));
drop policy if exists "sessions insert own" on sessions;
create policy "sessions insert own" on sessions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "sessions delete own" on sessions;
create policy "sessions delete own" on sessions for delete to authenticated using (user_id = auth.uid());

-- Status: your own and your friends'; only you write yours
drop policy if exists "status read" on status;
create policy "status read" on status for select to authenticated
  using (user_id = auth.uid() or are_friends(auth.uid(), user_id));
drop policy if exists "status write" on status;
create policy "status write" on status for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "status update" on status;
create policy "status update" on status for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Rooms were removed; this clears them out of a database set up before then
drop function if exists join_room(text);
drop function if exists shares_room(uuid, uuid);
alter table status drop column if exists room_id;
alter table status drop column if exists room_name;
alter table status drop column if exists room_code;
-- (the tables before is_member, since their policies use it)
drop table if exists room_members;
drop table if exists rooms;
drop function if exists is_member(uuid, uuid);

-- Friendships: either side can see and remove one; only the asked side accepts
drop policy if exists "friendships read" on friendships;
create policy "friendships read" on friendships for select to authenticated
  using (auth.uid() in (requester, addressee));
drop policy if exists "friendships request" on friendships;
create policy "friendships request" on friendships for insert to authenticated
  with check (requester = auth.uid() and not accepted);
drop policy if exists "friendships accept" on friendships;
create policy "friendships accept" on friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid());
-- Accepting only flips accepted; without this, the asked side could rewrite
-- requester and make themselves friends with anyone
revoke update on friendships from anon, authenticated;
grant update (accepted) on friendships to authenticated;
drop policy if exists "friendships remove" on friendships;
create policy "friendships remove" on friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));

-- Opening someone's invite link makes you friends straight away
create or replace function accept_invite(code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  inviter profiles;
begin
  select * into inviter from profiles where invite_code = code;
  if inviter.id is null then raise exception 'That invite link doesn''t work'; end if;
  if inviter.id = auth.uid() then return inviter.display_name; end if;
  delete from friendships
    where (requester = inviter.id and addressee = auth.uid())
       or (requester = auth.uid() and addressee = inviter.id);
  insert into friendships (requester, addressee, accepted) values (inviter.id, auth.uid(), true);
  return inviter.display_name;
end;
$$;

-- You and your friends (or, with everyone, every profile), with study time
-- today, this week (from Monday), all time, and the current streak, all
-- reckoned in the caller's time zone
drop function if exists leaderboard(text);
create or replace function leaderboard(tz text, everyone boolean default false) returns table (
  id uuid, username text, display_name text, avatar_url text,
  today_ms bigint, week_ms bigint, all_ms bigint, streak int
)
language sql stable security definer set search_path = public as $$
  with people as (
    select p.* from profiles p
    where everyone or p.id = auth.uid() or are_friends(auth.uid(), p.id)
  ),
  local as (
    select s.user_id, s.ms, (s.started_at at time zone tz)::date as day
    from sessions s join people p on p.id = s.user_id
  ),
  today as (select (now() at time zone tz)::date as d),
  days as (
    select distinct user_id, day from local
  ),
  -- Days in a row run back from today, or from yesterday if today is empty
  runs as (
    select user_id, day, day - (row_number() over (partition by user_id order by day))::int as grp
    from days
  ),
  streaks as (
    select r.user_id, count(*)::int as streak
    from runs r, today t
    where r.grp = (
      select r2.grp from runs r2
      where r2.user_id = r.user_id and r2.day in (t.d, t.d - 1)
      order by r2.day desc limit 1
    )
    group by r.user_id
  )
  select p.id, p.username, p.display_name, p.avatar_url,
    coalesce(sum(l.ms) filter (where l.day = t.d), 0)::bigint,
    coalesce(sum(l.ms) filter (where l.day >= date_trunc('week', t.d)::date), 0)::bigint,
    coalesce(sum(l.ms), 0)::bigint,
    coalesce(max(st.streak), 0)
  from people p
  cross join today t
  left join local l on l.user_id = p.id
  left join streaks st on st.user_id = p.id
  group by p.id, p.username, p.display_name, p.avatar_url, t.d;
$$;

grant execute on function accept_invite(text) to authenticated;
grant execute on function leaderboard(text, boolean) to authenticated;

-- Status, finished turns and friend requests are pushed to friends' pages as
-- they happen, so the board and requests update live
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'status') then
    alter publication supabase_realtime add table status;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sessions') then
    alter publication supabase_realtime add table sessions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'friendships') then
    alter publication supabase_realtime add table friendships;
  end if;
end;
$$;
