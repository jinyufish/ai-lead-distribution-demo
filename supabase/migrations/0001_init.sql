-- Schema for the AE Lead Distribution demo.
--
-- Derived from the Edge Function's queries. Two tables:
--   aes                          the sales reps leads get assigned to
--   "AE Lead Distribution Record"  one row per lead, the system's whole state
--
-- The lead table name contains spaces because it predates this repo; the Edge
-- Function quotes it everywhere. Keeping the name means the function needs no
-- changes to run against this database.

create table if not exists aes (
  id     bigint generated always as identity primary key,
  name   text not null,
  email  text not null,
  active boolean not null default true
);

create table if not exists "AE Lead Distribution Record" (
  id                bigint generated always as identity primary key,
  raw_lead_msg      text,
  call_recording    text,

  -- AI workflow output
  ai_decision       text,           -- approve | manual_review | disapprove
  ai_explanation    text,
  interest_level    text,           -- high | medium | low

  -- Drafted outreach
  email_subject     text,
  email_body        text,
  cc                text default '',

  -- Assignment
  assigned_ae_id    bigint references aes(id),
  assigned_ae_name  text,
  assigned_ae_email text,

  -- Lifecycle
  status            text not null default 'pending_manual_review',
  submitted_by      text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  sent_at           timestamptz,
  email_error       text,
  created_at        timestamptz not null default now()
);

-- status is a small closed set; a check keeps typos out without needing an enum
-- (an enum would make future additions a migration rather than a one-line edit).
alter table "AE Lead Distribution Record"
  drop constraint if exists lead_status_check;
alter table "AE Lead Distribution Record"
  add constraint lead_status_check check (status in (
    'pending_manual_review',
    'ai_approved',
    'ai_disapproved',
    'human_approved',
    'human_disapproved',
    'email_sent'
  ));

-- The dashboard filters by date and the assignment query counts per AE per day.
create index if not exists lead_created_at_idx on "AE Lead Distribution Record" (created_at desc);
create index if not exists lead_ae_status_idx  on "AE Lead Distribution Record" (assigned_ae_id, status);
create index if not exists lead_submitted_idx  on "AE Lead Distribution Record" (submitted_by, created_at desc);

-- ── Row Level Security ───────────────────────────────────
-- The Edge Function talks to the database with the service role key, which
-- bypasses RLS. The browser only ever holds the anon key, so denying anon
-- everything means a public anon key grants no data access at all: every read
-- and write has to go through the Edge Function, where the logic lives.
alter table aes                            enable row level security;
alter table "AE Lead Distribution Record"  enable row level security;
-- No policies are created, so anon and authenticated get nothing.
