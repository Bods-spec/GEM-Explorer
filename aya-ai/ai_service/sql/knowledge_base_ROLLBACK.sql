-- Removes everything knowledge_base.sql created. Booking tables are untouched.
-- Deletes the knowledge-base rows too (they can be re-ingested from knowledge/*.json).
-- The pgvector extension is left installed on purpose (harmless, and other things may use it).
begin;
drop function if exists public.search_museum_knowledge(text, extensions.vector, text, integer, boolean);
drop table if exists public.museum_chunks;
drop table if exists public.museum_entities;
drop table if exists public.museum_sources;
drop function if exists public.museum_normalize_ar(text);
commit;
