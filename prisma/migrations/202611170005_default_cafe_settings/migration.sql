-- Initialize singleton settings without changing an existing cafe.
INSERT INTO `cafe_settings` (`id`, `name`, `address`, `logo_url`, `tax_enabled`, `tax_name`, `tax_rate`, `tax_inclusive`, `updated_at`)
SELECT 1, 'OpenCafe', 'OpenCafe Street', NULL, false, 'PBJT', 10.00, false, CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `cafe_settings` WHERE `id` = 1);
