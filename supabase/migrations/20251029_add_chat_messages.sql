-- supabase\migrations\20251029_add_chat_messages.sql

-- Создание таблицы для истории чата
create table if not exists public.chat_messages (
    id serial primary key,
    profile_id integer not null references public.profiles (id) on delete cascade,
    role text not null check (role in ('user', 'assistant')),
    content text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists chat_messages_profile_id_idx on public.chat_messages (profile_id);
create index if not exists chat_messages_created_at_idx on public.chat_messages (created_at);
