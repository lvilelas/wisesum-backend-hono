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


create table if not exists public.se_tax_simulations (
  id bigserial primary key,
  clerk_user_id text not null,

  tax_year int not null default 2025,
  filing_status text not null, -- 'single' | 'mfj' | 'mfs' | 'hoh'

  net_profit numeric not null,
  w2_wages numeric not null default 0,

  report_snapshot jsonb,
  report_version int default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists se_tax_simulations_user_created_at_idx
  on public.se_tax_simulations (clerk_user_id, created_at desc);

create index if not exists se_tax_simulations_user_year_idx
  on public.se_tax_simulations (clerk_user_id, tax_year);



alter table public.se_tax_simulations
  add column total numeric,
  add column se_tax numeric,
  add column net_earnings numeric;

create index if not exists se_tax_simulations_user_total_idx
  on public.se_tax_simulations (clerk_user_id, total);  


  create table if not exists public.quarterly_simulations (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null,
  created_at timestamptz not null default now(),

  -- opcional: para debug / analytics
  tax_year int not null default 2026,
  state text,
  filing_status text,

  -- inputs (guarda só o básico do free; ou tudo se quiser)
  input jsonb not null,

  -- resultado resumido pra você consultar rápido sem recalcular
  result jsonb
);

-- índices para a query do daily limit
create index if not exists quarterly_simulations_user_created_at_idx
  on public.quarterly_simulations (clerk_user_id, created_at desc);

create index if not exists quarterly_simulations_created_at_idx
  on public.quarterly_simulations (created_at desc);
