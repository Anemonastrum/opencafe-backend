-- Preserve first due date independently from successful report generation.
CREATE TABLE `notification_schedule_state` (
    `id` INTEGER NOT NULL,
    `first_business_date` DATE NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
