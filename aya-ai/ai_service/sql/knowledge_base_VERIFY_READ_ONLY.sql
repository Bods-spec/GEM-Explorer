-- =====================================================================
-- GEM Explorer AI: verify the knowledge-base migration        READ ONLY
-- Every statement below is a SELECT. It changes nothing, so it is safe to run any time,
-- before or after the data is loaded.
--
-- HOW TO USE (Supabase SQL editor shows only the LAST result of a script, so run each
-- numbered block on its own):
--   Block 1 = the summary. Every row should show ok = true.
--   Blocks 2 to 7 = details; open one only if a row in block 1 says false.
-- =====================================================================


-- ---------------------------------------------------------------------
-- BLOCK 1: summary. Expected: every row ok = true
-- (rows marked "info" have no pass/fail: they just tell you the state)
-- ---------------------------------------------------------------------
with
tbl as (
  select c.oid, c.relname, c.relrowsecurity, c.relowner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('museum_sources', 'museum_entities', 'museum_chunks')
),
fn as (
  select p.oid, p.proname, p.prosecdef, p.proowner, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('search_museum_knowledge', 'museum_normalize_ar')
),
api_roles as (select unnest(array['anon', 'authenticated']) as role),
privs as (select unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv),
-- who holds ANY privilege on the three tables (PUBLIC shows up as grantee 0)
table_grantees as (
  select t.relname, x.grantee, x.privilege_type
  from tbl t, lateral aclexplode(coalesce((select relacl from pg_class where oid = t.oid), '{}')) x
),
fn_grantees as (
  select f.proname, x.grantee, x.privilege_type
  from fn f, lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) x
)
select * from (
  select 1 as n, 'the 3 tables exist' as check_name,
         (select count(*) from tbl) = 3 as ok,
         (select count(*) from tbl)::text || ' of 3 found' as detail
  union all
  select 2, 'Row Level Security is ON for all 3 tables',
         (select count(*) from tbl where relrowsecurity) = 3,
         (select string_agg(relname || '=' || relrowsecurity::text, ', ' order by relname) from tbl)
  union all
  select 3, 'there are NO policies (so the browser roles see nothing)',
         (select count(*) from pg_policies where schemaname = 'public' and tablename like 'museum\_%') = 0,
         (select count(*) from pg_policies where schemaname = 'public' and tablename like 'museum\_%')::text || ' policies'
  union all
  select 4, 'anon and authenticated hold NO privilege on any of the 3 tables',
         not exists (select 1 from tbl t, api_roles r, privs p where has_table_privilege(r.role, t.oid, p.priv)),
         coalesce((select string_agg(t.relname || ':' || r.role || ':' || p.priv, ', ')
                   from tbl t, api_roles r, privs p where has_table_privilege(r.role, t.oid, p.priv)), 'none')
  union all
  select 5, 'PUBLIC (everyone) holds no privilege on the tables',
         not exists (select 1 from table_grantees where grantee = 0),
         coalesce((select string_agg(relname || ':' || privilege_type, ', ') from table_grantees where grantee = 0), 'none')
  union all
  select 6, 'only the owner and service_role appear in the tables'' privilege lists',
         not exists (
           select 1 from table_grantees g join tbl t on t.relname = g.relname
           where g.grantee <> 0 and pg_get_userbyid(g.grantee) not in ('service_role', pg_get_userbyid(t.relowner))),
         coalesce((select string_agg(distinct pg_get_userbyid(grantee), ', ') from table_grantees where grantee <> 0), 'none')
  union all
  select 7, 'service_role can select, insert, update and delete on all 3 tables',
         not exists (select 1 from tbl t, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                     where not has_table_privilege('service_role', t.oid, p)),
         'service_role is the backend role'
  union all
  select 8, 'no column-level grants exist on the 3 tables',
         not exists (select 1 from pg_attribute a join tbl t on t.oid = a.attrelid where a.attacl is not null),
         'column grants would bypass the table rules'
  union all
  select 9, 'anon and authenticated cannot bypass Row Level Security',
         not exists (select 1 from pg_roles where rolname in ('anon', 'authenticated') and rolbypassrls),
         'service_role bypasses it by design'
  union all
  select 10, 'both functions exist (search_museum_knowledge, museum_normalize_ar)',
         (select count(*) from fn) = 2,
         (select string_agg(proname, ', ') from fn)
  union all
  select 11, 'anon and authenticated cannot EXECUTE either function',
         not exists (select 1 from fn f, api_roles r where has_function_privilege(r.role, f.oid, 'EXECUTE')),
         coalesce((select string_agg(f.proname || ':' || r.role, ', ')
                   from fn f, api_roles r where has_function_privilege(r.role, f.oid, 'EXECUTE')), 'none')
  union all
  select 12, 'PUBLIC (everyone) cannot EXECUTE either function',
         not exists (select 1 from fn_grantees where grantee = 0),
         coalesce((select string_agg(proname, ', ') from fn_grantees where grantee = 0), 'none')
  union all
  select 13, 'service_role can EXECUTE both functions',
         not exists (select 1 from fn f where not has_function_privilege('service_role', f.oid, 'EXECUTE')),
         'needed by the backend and by the keyword index'
  union all
  select 14, 'functions run with the CALLER''s rights (not security definer)',
         not exists (select 1 from fn where prosecdef),
         'security definer would run as the owner'
  union all
  select 15, 'the 3 tables are NOT in the realtime publication',
         not exists (select 1 from pg_publication_tables where schemaname = 'public' and tablename like 'museum\_%'),
         'realtime would broadcast rows to subscribers'
  union all
  select 16, 'pgvector is installed and supports HNSW (0.5.0 or newer)',
         coalesce((select string_to_array(extversion, '.')::int[] >= array[0, 5, 0] from pg_extension where extname = 'vector'), false),
         coalesce((select 'version ' || extversion || ' in schema ' || n.nspname
                   from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'), 'not installed')
  union all
  select 17, 'museum_chunks.embedding is vector(1536) (text-embedding-3-small)',
         coalesce((select format_type(a.atttypid, a.atttypmod) like '%vector(1536)'
                   from pg_attribute a where a.attrelid = 'public.museum_chunks'::regclass and a.attname = 'embedding'), false),
         coalesce((select format_type(a.atttypid, a.atttypmod)
                   from pg_attribute a where a.attrelid = 'public.museum_chunks'::regclass and a.attname = 'embedding'), 'missing')
  union all
  select 18, 'HNSW index with cosine distance exists on the embedding',
         exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'museum_chunks'
                 and indexdef ilike '%using hnsw%' and indexdef ilike '%vector_cosine_ops%'),
         coalesce((select indexname from pg_indexes where schemaname = 'public' and tablename = 'museum_chunks' and indexdef ilike '%using hnsw%'), 'missing')
  union all
  select 19, 'GIN index exists on the keyword column (fts)',
         exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'museum_chunks'
                 and indexdef ilike '%using gin%' and indexdef ilike '%(fts)%'),
         coalesce((select indexname from pg_indexes where schemaname = 'public' and tablename = 'museum_chunks' and indexdef ilike '%using gin%'), 'missing')
  union all
  select 20, 'every museum_entities.source_keys value exists in museum_sources',
         not exists (select 1 from public.museum_entities e, unnest(e.source_keys) k
                     where not exists (select 1 from public.museum_sources s where s.source_key = k)),
         coalesce((select string_agg(distinct e.entity_key || ' -> ' || k, ', ')
                   from public.museum_entities e, unnest(e.source_keys) k
                   where not exists (select 1 from public.museum_sources s where s.source_key = k)), 'no dangling keys')
  union all
  select 21, 'every visit time is labelled a team estimate',
         not exists (select 1 from public.museum_entities
                     where suggested_minutes is not null and minutes_basis is distinct from 'team_estimate'),
         (select count(*)::text from public.museum_entities where suggested_minutes is not null) || ' entities have a time'
  union all
  select 22, 'all stored embeddings use one model',
         (select count(distinct embedding_model) from public.museum_chunks) <= 1,
         coalesce((select string_agg(distinct embedding_model, ', ') from public.museum_chunks), 'no rows yet')
  union all
  select 23, 'info: notes / notes still without an embedding',
         null::boolean,
         (select count(*)::text || ' notes, ' || count(*) filter (where embedding is null)::text || ' without embedding' from public.museum_chunks)
  union all
  select 24, 'info: rows per table (sources / entities / notes)',
         null::boolean,
         (select count(*) from public.museum_sources)::text || ' / ' || (select count(*) from public.museum_entities)::text
           || ' / ' || (select count(*) from public.museum_chunks)::text
) t
order by n;


-- ---------------------------------------------------------------------
-- BLOCK 2: every privilege held on the 3 tables (grantee 0 = PUBLIC).
-- Expected: only the owner and service_role. Nothing for anon, authenticated or PUBLIC.
-- ---------------------------------------------------------------------
select c.relname as table_name,
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
       string_agg(x.privilege_type, ', ' order by x.privilege_type) as privileges
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
where n.nspname = 'public' and c.relname in ('museum_sources', 'museum_entities', 'museum_chunks')
group by 1, 2
order by 1, 2;


-- ---------------------------------------------------------------------
-- BLOCK 3: the same for the two functions.
-- Expected: only the owner and service_role may EXECUTE.
-- ---------------------------------------------------------------------
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
       x.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
where n.nspname = 'public' and p.proname in ('search_museum_knowledge', 'museum_normalize_ar')
order by 1, 3;


-- ---------------------------------------------------------------------
-- BLOCK 4: what each browser-facing role could do, spelled out.
-- Expected: every column false for anon and authenticated; service_role true on the first 4.
-- ---------------------------------------------------------------------
select r.role, t.relname as table_name,
       has_table_privilege(r.role, t.oid, 'SELECT') as can_select,
       has_table_privilege(r.role, t.oid, 'INSERT') as can_insert,
       has_table_privilege(r.role, t.oid, 'UPDATE') as can_update,
       has_table_privilege(r.role, t.oid, 'DELETE') as can_delete,
       has_table_privilege(r.role, t.oid, 'TRUNCATE') as can_truncate
from unnest(array['anon', 'authenticated', 'service_role']) as r(role)
cross join (
  select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('museum_sources', 'museum_entities', 'museum_chunks')
) t
order by r.role, t.relname;


-- ---------------------------------------------------------------------
-- BLOCK 5: defaults that would apply to FUTURE objects in schema public (information only).
-- Supabase normally grants new public tables to anon/authenticated by default; this migration
-- revokes that for its own objects. Other future tables are not affected by this migration.
-- ---------------------------------------------------------------------
select pg_get_userbyid(d.defaclrole) as created_by,
       case d.defaclobjtype when 'r' then 'tables' when 'f' then 'functions' when 'S' then 'sequences' else d.defaclobjtype::text end as object_type,
       d.defaclacl::text as default_privileges
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
where n.nspname = 'public' or d.defaclnamespace = 0
order by 1, 2;


-- ---------------------------------------------------------------------
-- BLOCK 6: dangling source_keys, in detail. Expected: no rows.
-- ---------------------------------------------------------------------
select e.entity_key, k as missing_source_key
from public.museum_entities e
cross join lateral unnest(e.source_keys) as k
where not exists (select 1 from public.museum_sources s where s.source_key = k)
order by 1, 2;


-- ---------------------------------------------------------------------
-- BLOCK 7: rows that look wrong (information). Expected: no rows.
--   * a note whose embedding is missing or was made by a different model than the others
--   * an entity with a time that is not labelled as a team estimate
-- ---------------------------------------------------------------------
select 'note without embedding' as problem, chunk_key as item from public.museum_chunks where embedding is null
union all
select 'note with a different embedding model', chunk_key
  from public.museum_chunks
  where embedding_model is distinct from (select embedding_model from public.museum_chunks
                                          group by embedding_model order by count(*) desc limit 1)
union all
select 'time not labelled as team estimate', entity_key
  from public.museum_entities where suggested_minutes is not null and minutes_basis is distinct from 'team_estimate'
order by 1, 2;
