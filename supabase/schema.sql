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

-- Every finished study turn; started_at is unique per person, so the page can
-- upload its whole local history again without making duplicates
create table if not exists sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  started_at timestamptz not null,
  ms integer not null check (ms > 0 and ms <= 86400000),
  unique (user_id, started_at)
);

-- A room friends study in together, with music everyone in it hears in step:
-- a queue of YouTube videos, which one is on, whether it's playing, and where
-- it was (position, in seconds) at the moment at (ms since 1970)
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default substr(md5(random()::text), 1, 6),
  name text not null check (length(name) between 1 and 40),
  owner uuid not null references profiles on delete cascade default auth.uid(),
  music jsonb not null default '{"queue": [], "index": 0, "playing": false, "position": 0, "at": 0}',
  created_at timestamptz not null default now()
);

-- Everyone who has joined a room, so it can be found again later
create table if not exists room_members (
  room_id uuid not null references rooms on delete cascade,
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
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
  room_id uuid references rooms on delete set null,  -- the room they're in now
  room_name text,
  room_code text,
  updated_at timestamptz not null default now()
);
alter table status add column if not exists room_id uuid references rooms on delete set null;
alter table status add column if not exists room_name text;
alter table status add column if not exists room_code text;

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
alter table rooms enable row level security;
alter table room_members enable row level security;

-- True when user has joined room
create or replace function is_member(room uuid, member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_id = room and user_id = member);
$$;

-- True when a and b are in the same room right now
create or replace function shares_room(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from status sa join status sb on sa.room_id = sb.room_id
    where sa.user_id = a and sb.user_id = b
  );
$$;

-- Profiles are visible to anyone signed in, so friends can be found by username
drop policy if exists "profiles read" on profiles;
create policy "profiles read" on profiles for select to authenticated using (true);
drop policy if exists "profiles insert own" on profiles;
create policy "profiles insert own" on profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Sessions: your own, plus your friends'
drop policy if exists "sessions read" on sessions;
create policy "sessions read" on sessions for select to authenticated
  using (user_id = auth.uid() or are_friends(auth.uid(), user_id));
drop policy if exists "sessions insert own" on sessions;
create policy "sessions insert own" on sessions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "sessions delete own" on sessions;
create policy "sessions delete own" on sessions for delete to authenticated using (user_id = auth.uid());

-- Status: your own, your friends', and whoever is in your room; only you
-- write yours, and the room in it has to be one you've joined
drop policy if exists "status read" on status;
create policy "status read" on status for select to authenticated
  using (user_id = auth.uid() or are_friends(auth.uid(), user_id) or shares_room(auth.uid(), user_id));
drop policy if exists "status write" on status;
create policy "status write" on status for insert to authenticated
  with check (user_id = auth.uid() and (room_id is null or is_member(room_id, auth.uid())));
drop policy if exists "status update" on status;
create policy "status update" on status for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (room_id is null or is_member(room_id, auth.uid())));

-- Rooms: members see them and run the music; anyone signed in can start one.
-- Joining goes through join_room, which takes the room's code.
drop policy if exists "rooms read" on rooms;
create policy "rooms read" on rooms for select to authenticated
  using (owner = auth.uid() or is_member(id, auth.uid()));
drop policy if exists "rooms create" on rooms;
create policy "rooms create" on rooms for insert to authenticated with check (owner = auth.uid());
drop policy if exists "rooms update" on rooms;
create policy "rooms update" on rooms for update to authenticated
  using (is_member(id, auth.uid())) with check (is_member(id, auth.uid()));
drop policy if exists "room members read" on room_members;
create policy "room members read" on room_members for select to authenticated
  using (is_member(room_id, auth.uid()));
drop policy if exists "room members leave" on room_members;
create policy "room members leave" on room_members for delete to authenticated
  using (user_id = auth.uid());

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

-- Joins the room with this code (or the one just made) and returns it
create or replace function join_room(code text) returns rooms
language plpgsql security definer set search_path = public as $$
declare
  room rooms;
begin
  select * into room from rooms r where r.code = lower(trim(join_room.code));
  if room.id is null then raise exception 'No room has that code'; end if;
  insert into room_members (room_id, user_id) values (room.id, auth.uid()) on conflict do nothing;
  return room;
end;
$$;

-- You and your friends, with study time today, this week (from Monday), all
-- time, and the current streak, all reckoned in the caller's time zone
create or replace function leaderboard(tz text) returns table (
  id uuid, username text, display_name text, avatar_url text,
  today_ms bigint, week_ms bigint, all_ms bigint, streak int
)
language sql stable security definer set search_path = public as $$
  with people as (
    select p.* from profiles p
    where p.id = auth.uid() or are_friends(auth.uid(), p.id)
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
grant execute on function leaderboard(text) to authenticated;
grant execute on function join_room(text) to authenticated;

-- Status and room changes are pushed to friends' and roommates' pages as they
-- happen
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'status') then
    alter publication supabase_realtime add table status;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rooms') then
    alter publication supabase_realtime add table rooms;
  end if;
end;
$$;
