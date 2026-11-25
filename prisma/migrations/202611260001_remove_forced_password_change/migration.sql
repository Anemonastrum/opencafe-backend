-- Remove forced password rotation; existing password hashes and users remain unchanged.
ALTER TABLE `users` DROP COLUMN `must_change_password`;
