-- Standardise every stored timestamp on UTC.
--
-- Until now the app wrote the UTC wall-clock time of each instant WITHOUT a timezone and PostgreSQL
-- read it in the SERVER's timezone. On a server set to (say) Asia/Kolkata that stored every
-- timestamptz 5h30 early: the app read the same wall-clock back, so it looked right, but raw SQL,
-- exports and reporting tools saw shifted times. The app's connection now pins the session
-- timezone to UTC (src/config/database.ts), which makes storage correct — and this migration
-- corrects the rows written under the old behaviour.
--
-- A row stored as S under a server timezone Z represents the instant  (S AT TIME ZONE Z) AT TIME ZONE 'UTC'.
-- When the server timezone already IS UTC nothing was ever shifted, so nothing is touched.

DO $$
DECLARE
  server_tz text := current_setting('TimeZone');
  col record;
BEGIN
  IF upper(server_tz) IN ('UTC', 'ETC/UTC', 'GMT', 'ETC/GMT', 'Z') THEN
    RAISE NOTICE 'Server timezone is % — stored timestamps are already UTC; nothing to convert.', server_tz;
    RETURN;
  END IF;

  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.data_type = 'timestamp with time zone'
      AND c.table_name <> '_prisma_migrations' -- Prisma's own bookkeeping, not ours
  LOOP
    EXECUTE format(
      'UPDATE %I SET %I = (%I AT TIME ZONE %L) AT TIME ZONE ''UTC'' WHERE %I IS NOT NULL',
      col.table_name, col.column_name, col.column_name, server_tz, col.column_name
    );
    RAISE NOTICE 'Converted %.% from server timezone % to UTC', col.table_name, col.column_name, server_tz;
  END LOOP;
END
$$;
