-- Oracle XE test-container grants for the integration suites.
--
-- The sprint9 suite reads v$ views (server-variables / server-status /
-- listProcesses / kill-process) and kills real sessions; the stock gvenzl
-- image user has none of these privileges. Grants are runtime-only and die
-- with the container, so re-apply after a `docker compose down -v`:
--
--   docker exec -i ai-dba-oracle-test \
--     sqlplus -s 'sys/testpassword@localhost:1521/XEPDB1 as sysdba' < test/oracle-grants.sql
--
WHENEVER SQLERROR CONTINUE
GRANT SELECT ANY DICTIONARY TO testuser;
GRANT EXECUTE ON SYS.DBMS_LOCK TO testuser;
GRANT ALTER SYSTEM TO testuser;
