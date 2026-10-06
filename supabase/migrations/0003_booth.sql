-- Стенд: общее состояние ящика с тремя секциями для всех телефонов.
--
-- Посетители сканируют QR своими телефонами и без входа, поэтому отметка
-- «базилик полит» и счётчик срезок не могут жить в localStorage — у каждого
-- телефона он свой, и базилик поливали бы десятки раз за день.
--
-- Доступ без входа дан ТОЛЬКО через четыре функции, не к таблицам. Таблицы
-- закрыты RLS без единой политики и без грантов: anon не читает и не пишет их
-- напрямую. Функции делают ровно одну вещь каждая и не принимают ничего, чем
-- можно навредить, кроме пина сброса.
--
-- Запускать повторно можно сколько угодно раз.

create table if not exists public.booth_stand (
  id          text primary key default 'main' check (id = 'main'),
  watered_at  timestamptz,
  picks       int  not null default 0 check (picks >= 0),
  pick_day    date,
  updated_at  timestamptz not null default now()
);
insert into public.booth_stand (id) values ('main') on conflict (id) do nothing;

-- Пин сброса для персонала. Задаётся отдельной строкой в SQL Editor и в
-- репозиторий не попадает (репозиторий публичный).
create table if not exists public.booth_secret (
  id   text primary key default 'main' check (id = 'main'),
  pin  text not null check (length(pin) >= 4)
);

alter table public.booth_stand  enable row level security;
alter table public.booth_secret enable row level security;
revoke all on public.booth_stand, public.booth_secret from anon, authenticated;

-- Что стенд знает сейчас.
create or replace function public.booth_get()
returns table (watered_at timestamptz, picks int, pick_day date)
language sql stable security definer set search_path = public as $$
  select s.watered_at, s.picks, s.pick_day from public.booth_stand s where s.id = 'main'
$$;

-- Полив. Второй полив в течение 12 часов не записывается: два посетителя,
-- нажавшие «Done» почти одновременно, не сдвигают время, а последующие видят,
-- что базилик уже полит. Возвращает время полива, которое теперь в базе.
create or replace function public.booth_water()
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  update public.booth_stand s
     set watered_at = now(), updated_at = now()
   where s.id = 'main'
     and (s.watered_at is null or s.watered_at < now() - interval '12 hours');
  select s.watered_at into t from public.booth_stand s where s.id = 'main';
  return t;
end $$;

-- Срезка. День передаёт телефон — «сегодня» у стенда по местному времени, а
-- не по UTC сервера. Новый день начинает счёт заново.
create or replace function public.booth_pick(day date)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if day is null or day < current_date - 1 or day > current_date + 1 then
    raise exception 'booth_pick: day out of range';
  end if;
  update public.booth_stand s
     set picks = case when s.pick_day = day then s.picks + 1 else 1 end,
         pick_day = day, updated_at = now()
   where s.id = 'main'
  returning s.picks into n;
  return n;
end $$;

-- Сброс для персонала: после замены горшков или в начале дня. Неверный пин —
-- false и ничего не меняется.
create or replace function public.booth_reset(pin text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.booth_secret b where b.id = 'main' and b.pin = booth_reset.pin) then
    return false;
  end if;
  update public.booth_stand s
     set watered_at = null, picks = 0, pick_day = null, updated_at = now()
   where s.id = 'main';
  return true;
end $$;

revoke all on function public.booth_get(), public.booth_water(),
  public.booth_pick(date), public.booth_reset(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.booth_get(), public.booth_water(),
      public.booth_pick(date), public.booth_reset(text) to anon, authenticated;
  end if;
end $$;
