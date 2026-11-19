ALTER TABLE `orders` ADD COLUMN `payment_hold_reason` VARCHAR(100) NULL;
ALTER TABLE `payments`
    ADD COLUMN `request_id` CHAR(36) NULL,
    ADD COLUMN `order_total_amount` DECIMAL(12,2) NULL,
    ADD COLUMN `rounding_adjustment` DECIMAL(12,2) NULL,
    ADD COLUMN `dispatch_claimed_at` DATETIME(3) NULL,
    ADD COLUMN `dispatch_finished_at` DATETIME(3) NULL,
    ADD COLUMN `reconciliation_reason` VARCHAR(100) NULL,
    ADD COLUMN `latest_provider_observation` JSON NULL,
    ADD COLUMN `settlement_observation` JSON NULL;
CREATE UNIQUE INDEX `payments_order_id_request_id_key` ON `payments` (`order_id`, `request_id`);
