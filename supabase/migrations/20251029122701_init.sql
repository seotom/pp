-- supabase\migrations\20251029122701_init.sql

-- Create table profiles
create table if not exists public.profiles (
    id serial primary key,
    user_id text not null unique,
    budget integer,
    goals text,
    family_data jsonb,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists profiles_user_id_idx on public.profiles (user_id);

-- Create table family_members
create table if not exists public.family_members (
    id serial primary key,
    profile_id integer not null references public.profiles (id) on delete cascade,
    name text not null,
    age integer,
    weight integer,
    likes text[],
    dislikes text[],
    allergies text[],
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists family_members_profile_id_idx on public.family_members (profile_id);

-- Trigger to maintain updated_at
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row
execute function public.update_updated_at_column();

drop trigger if exists family_members_updated_at on public.family_members;
create trigger family_members_updated_at
before update on public.family_members
for each row
execute function public.update_updated_at_column();
