-- AI-DBA test database setup
-- Creates a table and seeds data, then a blocking scenario can be triggered
-- from two concurrent sessions.

CREATE TABLE IF NOT EXISTS blocking_test (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100),
  value INT
);

INSERT INTO blocking_test (name, value) VALUES
  ('alpha', 1),
  ('beta', 2),
  ('gamma', 3);

-- ========================================
-- HOW TO CREATE A BLOCKING CHAIN MANUALLY
-- ========================================
--
-- Session 1 (start a transaction, hold a lock):
--   START TRANSACTION;
--   UPDATE blocking_test SET value = 999 WHERE id = 1;
--   -- Do NOT commit or rollback yet
--
-- Session 2 (try to update the same row — this will block):
--   UPDATE blocking_test SET value = 888 WHERE id = 1;
--   -- This session is now blocked by Session 1
--
-- Now run the blocking-chains tool from ai-dba.
-- It should show Session 2 blocked by Session 1.
--
-- Session 1 (cleanup):
--   ROLLBACK;
--