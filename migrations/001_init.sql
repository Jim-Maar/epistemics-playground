-- The API server's tables. The server connects as the postgres role, which bypasses row level
-- security. Row level security is on with no policies, so the public anon key can read nothing.

create table browsers (
  id text primary key,
  name text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_sync_at timestamptz
);

create table sessions (
  token_hash text primary key,
  browser_id text not null references browsers (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- Every browser's copy of its threads, folders, views, messages, samples, judges and scores.
create table entities (
  browser_id text not null references browsers (id) on delete cascade,
  kind text not null,
  id text not null,
  thread_id text,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null,
  primary key (browser_id, kind, id)
);
create index entities_thread on entities (browser_id, thread_id);

create table runs (
  id text primary key,
  browser_id text not null,
  kind text not null,
  backend text not null,
  status text not null,
  text text not null default '',
  thinking text not null default '',
  model text not null default '',
  judgement jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table shares (
  id text primary key,
  browser_id text not null references browsers (id) on delete cascade,
  thread_id text not null,
  created_at timestamptz not null default now(),
  revoked boolean not null default false
);

create table runners (
  browser_id text primary key references browsers (id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);

alter table browsers enable row level security;
alter table sessions enable row level security;
alter table entities enable row level security;
alter table runs enable row level security;
alter table shares enable row level security;
alter table runners enable row level security;
