ALTER TABLE `cafe_settings`
  ADD COLUMN `receipt_paper_size` VARCHAR(4) NOT NULL DEFAULT '58mm',
  ADD CONSTRAINT `cafe_settings_receipt_paper_size_check` CHECK (BINARY `receipt_paper_size` IN ('58mm', '80mm'));

ALTER TABLE `orders`
  ADD COLUMN `receipt_paper_size` VARCHAR(4) NULL,
  ADD COLUMN `receipt_url` VARCHAR(500) NULL,
  ADD CONSTRAINT `orders_receipt_paper_size_check` CHECK (`receipt_paper_size` IS NULL OR BINARY `receipt_paper_size` IN ('58mm', '80mm'));
