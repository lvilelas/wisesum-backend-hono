-- =========================
-- USERS
-- =========================
create table if not exists public.users (
  id bigserial primary key,
  clerk_user_id text not null unique,
  created_at timestamptz not null default now()
);

-- =========================
-- ENTITLEMENTS (Stripe / planos)
-- =========================
create table if not exists public.entitlements (
  id bigserial primary key,
  clerk_user_id text not null unique,
  stripe_customer_id text unique,
  plan text not null,
  premium_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =========================
-- SIMULATIONS (cálculos)
-- =========================
create table if not exists public.simulations (
  id bigserial primary key,
  clerk_user_id text not null,
  w2_salary numeric not null,
  income_1099 numeric not null,
  expenses numeric,
  state text not null,
  result_winner text,
  result_difference numeric,
  created_at timestamptz not null default now(),

  constraint fk_simulations_user
    foreign key (clerk_user_id)
    references public.users (clerk_user_id)
    on delete cascade
);

-- =========================
-- INDEXES
-- =========================
create index if not exists idx_simulations_user_date
  on public.simulations (clerk_user_id, created_at);

-- =========================
-- RLS (DESATIVADO PARA MVP)
-- =========================
alter table public.users disable row level security;
alter table public.entitlements disable row level security;
alter table public.simulations disable row level security;

alter table public.simulations
  add column if not exists report_snapshot jsonb;

alter table public.simulations
  add column if not exists report_version int not null default 1;

alter table public.simulations
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_simulations_report_snapshot
  on public.simulations using gin (report_snapshot);