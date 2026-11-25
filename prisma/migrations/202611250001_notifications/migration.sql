-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `recipient_user_id` INTEGER NOT NULL,
    `type` ENUM('PAYMENT_SUCCESS', 'DAILY_SALES_REPORT', 'DAILY_SALES_REPORT_UNAVAILABLE') NOT NULL,
    `event_key` VARCHAR(100) NOT NULL,
    `data` JSON NOT NULL,
    `report_id` INTEGER NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_recipient_user_id_id_idx`(`recipient_user_id`, `id`),
    INDEX `notifications_recipient_user_id_read_at_id_idx`(`recipient_user_id`, `read_at`, `id`),
    UNIQUE INDEX `notifications_recipient_user_id_event_key_key`(`recipient_user_id`, `event_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_notification_reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `business_date` DATE NOT NULL,
    `generated_at` DATETIME(3) NOT NULL,
    `status` ENUM('READY', 'UNAVAILABLE') NOT NULL,
    `data` JSON NOT NULL,

    UNIQUE INDEX `daily_notification_reports_business_date_key`(`business_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_recipient_user_id_fkey` FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_report_id_fkey` FOREIGN KEY (`report_id`) REFERENCES `daily_notification_reports`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
