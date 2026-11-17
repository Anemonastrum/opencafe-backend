-- Public bootstrap credential; keep installation private until password changed.
ALTER TABLE `users` ADD COLUMN `must_change_password` BOOLEAN NOT NULL DEFAULT false;

-- Existing admins are never changed. Reserved username conflict fails rather than promotes.
INSERT INTO `users` (`name`,`username`,`password_hash`,`role`,`is_active`,`must_change_password`,`updated_at`)
SELECT 'Administrator','admin','scrypt$16384$8$1$a2aae93a29a474f31f30e08d4f2899e7$fd3d356adc70af908df6b19d78dfb262cd869ad9956c8af1bc1c36797f962af3ecdb9493ed18312f9b047ddf3f815d84274815f75e7049dbbb677684f2e46307','ADMIN',true,true,CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `role`='ADMIN');
