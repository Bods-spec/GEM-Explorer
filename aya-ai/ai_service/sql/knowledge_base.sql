-- =====================================================================
-- GEM Explorer AI: museum knowledge base (RAG)            FOR REVIEW ONLY
-- Nothing in this file has been run against your Supabase project.
--
-- Adds 3 new tables, 2 functions (search + an Arabic spelling normaliser) and 1 extension (pgvector).
-- It does NOT touch: bookings, booking_drafts, the booking / cancellation /
-- modification tables, any booking function, or authentication.
--
-- Safe to run twice (everything is "if not exists" / "create or replace").
-- To undo it completely, run knowledge_base_ROLLBACK.sql.
-- To check the result afterwards (read-only), run knowledge_base_VERIFY_READ_ONLY.sql.
--
-- Revision 2: keyword query built from clean lexemes (no text surgery on a tsquery),
-- extra source_keys format checks, "team estimate" comments on the planner columns.
-- =====================================================================

begin;

-- pgvector. Supabase keeps extensions in the "extensions" schema.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------
-- 1) Where a fact came from
-- ---------------------------------------------------------------------
create table if not exists public.museum_sources (
  id           uuid primary key default gen_random_uuid(),
  source_key   text not null unique
                 check (source_key ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title        text not null,
  url          text not null unique check (url ~ '^https://'),
  publisher    text not null,
  source_type  text not null
                 check (source_type in ('official', 'institutional', 'team_note')),
  license      text,
  retrieved_on date not null,
  notes        text,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) The things a visitor can ask about or be sent to (areas and artefacts)
--    The Visit Planner reads ONLY this table to choose stops.
-- ---------------------------------------------------------------------
create table if not exists public.museum_entities (
  id                  uuid primary key default gen_random_uuid(),
  entity_key          text not null unique
                        check (entity_key ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  kind                text not null check (kind in ('area', 'artifact')),
  parent_key          text references public.museum_entities (entity_key) on delete set null,
  name_en             text not null,
  name_ar             text,
  summary_en          text,
  summary_ar          text,
  period              text,
  ruler               text,
  -- Planner inputs. NULL means "do not put this in a plan".
  suggested_minutes   integer check (suggested_minutes between 5 and 240),
  minutes_basis       text check (minutes_basis in ('team_estimate')),
  visit_order         integer,       -- order used in the museum's own group-tour description
  interest_tags       text[] not null default '{}',
  verification_status text not null
                        check (verification_status in
                          ('verified', 'corroborated', 'single_source', 'conflicting')),
  -- Every key must exist in museum_sources. A CHECK cannot look at another table, so the
  -- ingestion script verifies that (against the database) before it writes; the format is
  -- enforced here, and knowledge_base_VERIFY_READ_ONLY.sql lists any dangling key.
  source_keys         text[] not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint source_keys_not_empty
    check (cardinality(source_keys) >= 1),
  constraint source_keys_no_nulls
    check (array_position(source_keys, null) is null),
  -- The array's text form is {a,b}. Anything odd (a comma, space, quote, empty string, NULL or
  -- upper case inside a key) makes PostgreSQL quote it or print NULL, which fails this pattern.
  constraint source_keys_format
    check (source_keys::text ~ '^\{[a-z0-9][a-z0-9-]*(,[a-z0-9][a-z0-9-]*)*\}$'),
  constraint minutes_need_basis
    check (suggested_minutes is null or minutes_basis is not null)
);

-- ---------------------------------------------------------------------
-- 2b) Arabic spelling normaliser, used by BOTH the keyword index and the keyword query,
--     so the two can never disagree. It only rewrites spelling variants people mix freely:
--       أ إ آ ٱ -> ا      ى -> ي      ة -> ه      Arabic-Indic digits -> 0-9
--     and deletes the tatweel (ـ) and the vowel marks. (The built-in Arabic stemmer removes
--     "ال" and common endings but does not unify ة/ه, so "المسلة" and "المسله" would not match.)
-- ---------------------------------------------------------------------
create or replace function public.museum_normalize_ar(t text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select pg_catalog.translate(
    t,
    'أإآٱىة' || '٠١٢٣٤٥٦٧٨٩' || 'ـًٌٍَُِّْٰ',
    'اااايه'  || '0123456789'
  );
$$;

-- ---------------------------------------------------------------------
-- 3) Short team-written factual notes (the searchable text)
-- ---------------------------------------------------------------------
create table if not exists public.museum_chunks (
  id                  uuid primary key default gen_random_uuid(),
  chunk_key           text not null unique
                        check (chunk_key ~ '^[a-z0-9][a-z0-9-]{1,100}$'),
  source_id           uuid not null references public.museum_sources (id) on delete restrict,
  entity_key          text references public.museum_entities (entity_key) on delete cascade,
  language            text not null check (language in ('en', 'ar')),
  content             text not null check (char_length(content) between 20 and 1500),
  verification_status text not null
                        check (verification_status in
                          ('verified', 'corroborated', 'single_source', 'conflicting')),
  time_sensitive      boolean not null default false,
  content_hash        text not null,           -- sha256 of content: re-embed only when it changes
  -- Keyword index. Arabic notes: normalised spelling + the built-in 'arabic' configuration;
  -- everything else: the 'english' configuration.
  fts                 tsvector generated always as (
                        case when language = 'ar'
                             then to_tsvector('arabic'::regconfig, public.museum_normalize_ar(content))
                             else to_tsvector('english'::regconfig, content) end
                      ) stored,
  embedding           extensions.vector(1536), -- text-embedding-3-small; NULL until ingested
  embedding_model     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists museum_chunks_fts_idx
  on public.museum_chunks using gin (fts);
create index if not exists museum_chunks_embedding_idx
  on public.museum_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists museum_chunks_entity_idx
  on public.museum_chunks (entity_key);
create index if not exists museum_entities_parent_idx
  on public.museum_entities (parent_key);

comment on column public.museum_entities.suggested_minutes is
  'TEAM ESTIMATE of a typical visit length, in minutes. NOT an official museum timing. Planner input only; NULL = do not plan.';
comment on column public.museum_entities.minutes_basis is
  'Where suggested_minutes comes from. Only team_estimate is allowed. The assistant must present it as "about N minutes (our estimate)".';
comment on column public.museum_entities.visit_order is
  'Order of the areas in the museum''s own group-tour description. Not a walking route and not a distance.';
comment on column public.museum_entities.source_keys is
  'museum_sources.source_key values this row is based on. Checked by the ingestion script, not by the database.';
comment on column public.museum_chunks.embedding is
  'text-embedding-3-small (1536 dimensions, default size). Cosine distance. NULL until ingested.';

-- ---------------------------------------------------------------------
-- 4) Hybrid search: keyword rank + meaning rank, merged with
--    Reciprocal Rank Fusion (k = 60).
--
--    * keyword side: only chunks in the question's language, any matching word (OR of clean lexemes)
--    * meaning side: all languages (so an Arabic question can find an English note)
--    * it returns the evidence and the raw signals (keyword_rank, similarity);
--      the backend decides whether that is "enough" and otherwise says
--      "I don't have that information". Conflicting facts are hidden unless asked for.
-- ---------------------------------------------------------------------
create or replace function public.search_museum_knowledge(
  query_text          text,
  query_embedding     extensions.vector default null,
  query_language      text default 'en',
  match_count         integer default 6,
  include_conflicting boolean default false
)
returns table (
  chunk_key           text,
  entity_key          text,
  language            text,
  content             text,
  verification_status text,
  time_sensitive      boolean,
  source_title        text,
  source_url          text,
  source_type         text,
  keyword_rank        integer,
  similarity          double precision,
  score               double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with params as (
    select
      least(greatest(coalesce(match_count, 6), 1), 20)                   as n,
      case when query_language = 'ar' then 'arabic'::regconfig
           else 'english'::regconfig end                                  as cfg,
      case when query_language = 'ar' then 'ar' else 'en' end             as lang
  ),
  stop as (
    -- Arabic function and question words (the built-in Arabic configuration ships almost no
    -- stop-words, so "من" or "في" would match nearly every note). The list is run through the
    -- same configuration as the question, so it is compared in its stemmed form.
    select w.lexeme
    from unnest(to_tsvector('arabic'::regconfig, public.museum_normalize_ar(
      'من في على إلى الى عن مع هذا هذه هذان ذلك تلك هو هي هم هن نحن انا أنا أنت ما ماذا لماذا متى أين اين كيف هل كم أي اي '
      'الذي التي الذين أن ان إن إنه انه كان كانت يكون تكون لا لم لن قد ثم أو او بل لكن حتى إذا اذا عند بين كل بعض غير '
      'فقط أيضا ايضا بعد قبل خلال حول منذ لدى فيه فيها منه منها عنه عنها به بها له لها لهم يوجد توجد هناك يمكن'
    ))) as w
  ),
  words as (
    -- Tokenise the question with the SAME text-search configuration (and Arabic spelling
    -- normaliser) that built the index, so stemming and stop-words match the stored notes.
    -- The result is a list of clean, already-normalised words. Nothing is parsed from user
    -- syntax, so quotes, minus signs, "OR", ampersands or brackets typed by a visitor cannot
    -- change the query.
    select w.lexeme, w.positions[1] as pos
    from params p,
         lateral unnest(
           to_tsvector(
             p.cfg,
             case when p.lang = 'ar'
                  then public.museum_normalize_ar(left(coalesce(query_text, ''), 500))
                  else left(coalesce(query_text, ''), 500) end
           )
         ) as w
    where w.lexeme !~ '[\s''"\\&|!<>():*]'                     -- defensive: no syntax characters inside a quoted word
      and not (p.lang = 'ar' and w.lexeme in (select lexeme from stop))
    order by w.positions[1], w.lexeme
    limit 16                                                    -- bound the work for very long questions
  ),
  q as (
    -- Natural questions: ANY matching word counts (OR). No words left (for example only stop-words)
    -- gives NULL, which matches nothing; the meaning side still works. rank flag 1 divides by note
    -- length so long notes do not win just by being long.
    select (select string_agg(chr(39) || lexeme || chr(39), ' | ' order by pos, lexeme) from words)::tsquery as tsq
  ),
  keyword as (
    -- Notes that contain MORE DISTINCT words of the question come first; ties are broken by
    -- ts_rank_cd (flag 1 divides by note length so long notes do not win just by being long).
    select c.id,
           row_number() over (order by m.matched desc, ts_rank_cd(c.fts, q.tsq, 1) desc, c.chunk_key)::integer as rnk
    from public.museum_chunks c
    cross join q
    cross join params p
    cross join lateral (
      select count(*)::integer as matched
      from words w
      where c.fts @@ (chr(39) || w.lexeme || chr(39))::tsquery
    ) m
    where c.language = p.lang
      and c.fts @@ q.tsq
      and (include_conflicting or c.verification_status <> 'conflicting')
    order by m.matched desc, ts_rank_cd(c.fts, q.tsq, 1) desc, c.chunk_key
    limit 40
  ),
  semantic as (
    select t.id, t.sim,
           row_number() over (order by t.sim desc, t.chunk_key)::integer as rnk
    from (
      select c.id, c.chunk_key,
             1 - (c.embedding <=> query_embedding) as sim
      from public.museum_chunks c
      where query_embedding is not null
        and c.embedding is not null
        and (include_conflicting or c.verification_status <> 'conflicting')
      order by c.embedding <=> query_embedding
      limit 40
    ) t
  ),
  fused as (
    select coalesce(k.id, s.id) as id,
           k.rnk                as keyword_rank,
           s.sim                as similarity,
           coalesce(1.0 / (60 + k.rnk), 0) + coalesce(1.0 / (60 + s.rnk), 0) as score
    from keyword k
    full join semantic s on s.id = k.id
  )
  select c.chunk_key, c.entity_key, c.language, c.content,
         c.verification_status, c.time_sensitive,
         s.title, s.url, s.source_type,
         f.keyword_rank, f.similarity::double precision, f.score::double precision
  from fused f
  join public.museum_chunks  c on c.id = f.id
  join public.museum_sources s on s.id = c.source_id
  order by f.score desc, c.chunk_key
  limit (select n from params);
$$;

-- ---------------------------------------------------------------------
-- 5) Locked down: only the backend (service role) can read or write.
--    Row Level Security is ON and there are NO policies, so the browser's
--    anon / authenticated roles can see nothing, even by accident.
-- ---------------------------------------------------------------------
alter table public.museum_sources  enable row level security;
alter table public.museum_entities enable row level security;
alter table public.museum_chunks   enable row level security;

revoke all on public.museum_sources, public.museum_entities, public.museum_chunks
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.museum_sources, public.museum_entities, public.museum_chunks
  to service_role;

revoke all on function public.museum_normalize_ar(text) from public, anon, authenticated;
grant execute on function public.museum_normalize_ar(text) to service_role;

revoke all on function public.search_museum_knowledge(text, extensions.vector, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.search_museum_knowledge(text, extensions.vector, text, integer, boolean)
  to service_role;

commit;

-- ---------------------------------------------------------------------
-- The full read-only check is knowledge_base_VERIFY_READ_ONLY.sql. The three quick ones:
-- 3 tables with rowsecurity = true, 0 policies, anon_can_read = false.
--
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename like 'museum\_%' order by 1;
--
--   select count(*) as policies from pg_policies
--   where schemaname = 'public' and tablename like 'museum\_%';
--
--   select has_table_privilege('anon', 'public.museum_chunks', 'select') as anon_can_read;  -- false
-- ---------------------------------------------------------------------
