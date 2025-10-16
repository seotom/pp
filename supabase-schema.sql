-- supabase-schema.sql

-- Supabase schema for Phase 2

-- profiles table: one row per authenticated user
create table if not exists profiles (
  id bigint generated always as identity primary key,
  user_id text unique not null,
  family_data jsonb,
  budget numeric,
  goals text,
  created_at timestamp with time zone default now()
);

-- family members linked to profile
create table if not exists family_members 
(
  id bigint generated always as identity primary key,
  profile_id bigint not null references profiles(id) on delete cascade,
  age int,
  weight numeric,
  activity text,
  preferences jsonb,
  created_at timestamp with time zone default now()
);

-- Migrate to granular columns for family member attributes
alter table family_members
  add column if not exists name text;

alter table family_members
  add column if not exists likes jsonb default '[]'::jsonb;

alter table family_members
  add column if not exists dislikes jsonb default '[]'::jsonb;

alter table family_members
  add column if not exists allergies jsonb default '[]'::jsonb;

-- Backfill defaults for existing rows
update family_members set likes = coalesce(likes, '[]'::jsonb) where likes is null;
update family_members set dislikes = coalesce(dislikes, '[]'::jsonb) where dislikes is null;
update family_members set allergies = coalesce(allergies, '[]'::jsonb) where allergies is null;

-- Remove legacy preferences column (no data migration requested)
alter table family_members drop column if exists preferences;

-- Optional: policy placeholders (configure in Supabase UI as needed)
-- You may enable RLS and add policies to allow users to access only their rows.

-- New intelligent facts storage: diet_facts
-- Stores canonicalized items with confidence and evidence counts, per profile/member
create table if not exists diet_facts (
  id bigint generated always as identity primary key,
  profile_id bigint not null references profiles(id) on delete cascade,
  member_id bigint null references family_members(id) on delete set null,
  subject_scope text not null check (subject_scope in ('household','member')),
  category text not null check (category in ('like','dislike','allergy')),
  item text not null,
  canonical text not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  evidence_count int not null default 1,
  status text not null default 'unconfirmed' check (status in ('unconfirmed','confirmed')),
  first_seen timestamp with time zone default now(),
  last_seen timestamp with time zone default now()
);

-- Indexes and uniqueness: prevent duplicates per scope
create index if not exists diet_facts_profile_idx on diet_facts(profile_id);
create index if not exists diet_facts_member_idx on diet_facts(member_id);
create unique index if not exists diet_facts_unique_member on diet_facts(
  profile_id, member_id, subject_scope, category, canonical
);
-- Household rows use member_id NULL; since NULLs don't enforce uniqueness,
-- add an expression-based unique index to ensure uniqueness for household scope.
create unique index if not exists diet_facts_unique_household on diet_facts(
  profile_id, category, canonical
) where member_id is null and subject_scope = 'household';