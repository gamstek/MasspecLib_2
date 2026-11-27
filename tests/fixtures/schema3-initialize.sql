-- CreateTable
CREATE TABLE `compounds` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` JSON NULL,
    `formula` VARCHAR(255) NULL,
    `cas` VARCHAR(255) NULL,
    `is_favorite` BOOLEAN NULL,
    `is_in_trash` BOOLEAN NULL,
    `is_delete` BOOLEAN NULL,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,
    `molecular_mass` DOUBLE NULL,
    `monoisotopic_mass` DOUBLE NULL,
    `formula_diagram_base64` LONGTEXT NULL,
    `main_name` VARCHAR(255) NULL,
    `name_zh` VARCHAR(255) NULL,
    `name_en` VARCHAR(255) NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `identifiers` JSON NULL,
    `properties` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `classes` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `class_name` VARCHAR(255) NOT NULL,
    `is_custom` BOOLEAN NOT NULL DEFAULT false,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compound_class` (
    `compound_id` INTEGER NOT NULL,
    `class_id` INTEGER UNSIGNED NOT NULL,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,

    PRIMARY KEY (`compound_id`, `class_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ms_methods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `compounds_id` INTEGER NULL,
    `ms_mode` VARCHAR(255) NULL,
    `q1` FLOAT NULL,
    `q3` FLOAT NULL,
    `ce` FLOAT NULL,
    `dp` FLOAT NULL,
    `cxp` FLOAT NULL,
    `polarity` TINYINT NULL,
    `ion_source` VARCHAR(255) NULL,
    `scan_mode` VARCHAR(255) NULL,
    `cad_value` DOUBLE NULL,
    `cad_type` VARCHAR(255) NULL,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,
    `mass_spectrum_base64` LONGTEXT NULL,
    `transition_role` VARCHAR(32) NULL,
    `adduct` VARCHAR(255) NULL,
    `ce_unit` VARCHAR(64) NULL,
    `energy_type` VARCHAR(64) NULL,
    `conditions` JSON NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,

    INDEX `ms_methods_compounds_id_idx`(`compounds_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lc_methods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `compounds_id` INTEGER NOT NULL,
    `lc_mode` VARCHAR(255) NULL,
    `chromatographic_column_mode` VARCHAR(255) NULL,
    `retention_time` DOUBLE NULL,
    `phase_A` TEXT NULL,
    `phase_B` TEXT NULL,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,
    `column_type` VARCHAR(255) NULL,
    `column_length_mm` DECIMAL(10, 3) NULL,
    `column_inner_diameter_mm` DECIMAL(10, 3) NULL,
    `column_particle_size_um` DECIMAL(10, 3) NULL,
    `column_temperature_c` DECIMAL(10, 3) NULL,
    `elution_mode` VARCHAR(32) NULL,
    `program_text` TEXT NULL,
    `retention_time_unit` VARCHAR(64) NULL,
    `conditions` JSON NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,

    INDEX `lc_methods_compounds_id_idx`(`compounds_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lc_methods_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lc_methods_id` INTEGER NULL,
    `time` DOUBLE NULL,
    `percentage_A` VARCHAR(255) NULL,
    `percentage_B` VARCHAR(255) NULL,
    `flow_rate` FLOAT NULL,
    `create_time` DATETIME(0) NOT NULL,
    `update_time` DATETIME(0) NOT NULL,
    `step_order` INTEGER NULL,
    `time_unit` VARCHAR(64) NULL,
    `flow_rate_unit` VARCHAR(64) NULL,
    `components` JSON NULL,

    INDEX `lc_methods_items_lc_methods_id_idx`(`lc_methods_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_metadata` (
    `id` INTEGER NOT NULL,
    `product` VARCHAR(64) NOT NULL,
    `schema_version` INTEGER NOT NULL,
    `instance_id` VARCHAR(64) NOT NULL,
    `state` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `spectral_libraries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `namespace` VARCHAR(191) NOT NULL,
    `source_type` VARCHAR(32) NOT NULL DEFAULT 'unknown',
    `name` VARCHAR(255) NOT NULL,
    `version` VARCHAR(255) NULL,
    `provider` VARCHAR(255) NULL,
    `location` TEXT NULL,
    `license` TEXT NULL,

    UNIQUE INDEX `spectral_libraries_namespace_key`(`namespace`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_batches` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `package_id` VARCHAR(191) NOT NULL,
    `content_hash` VARCHAR(64) NOT NULL,
    `mapping_version` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `cursor` INTEGER NOT NULL DEFAULT 0,
    `report` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `import_batches_package_id_content_hash_key`(`package_id`, `content_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `source_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `library_id` INTEGER NOT NULL,
    `source_key` VARCHAR(191) NOT NULL,
    `content_hash` VARCHAR(64) NOT NULL,
    `raw` JSON NOT NULL,
    `decision` VARCHAR(32) NOT NULL,
    `batch_id` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `source_records_batch_id_idx`(`batch_id`),
    UNIQUE INDEX `source_records_library_id_source_key_content_hash_key`(`library_id`, `source_key`, `content_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `spectra` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `compound_id` INTEGER NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `peaks` JSON NULL,
    `image_base64` LONGTEXT NULL,
    `image_mime` VARCHAR(64) NULL,
    `spectrum_type` VARCHAR(64) NULL,
    `polarity` TINYINT NULL,
    `adduct` VARCHAR(255) NULL,
    `precursor_mz` DECIMAL(20, 10) NULL,
    `collision_energy` JSON NULL,
    `conditions` JSON NULL,
    `nature` VARCHAR(32) NULL,
    `raw` JSON NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `spectra_compound_id_idx`(`compound_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `spectrum_method_links` (
    `spectrum_id` INTEGER NOT NULL,
    `method_id` INTEGER NOT NULL,

    INDEX `spectrum_method_links_method_id_idx`(`method_id`),
    PRIMARY KEY (`spectrum_id`, `method_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `detection_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `compound_id` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `matrix` VARCHAR(255) NULL,
    `verification_status` VARCHAR(64) NULL,
    `data` JSON NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `detection_profiles_compound_id_idx`(`compound_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `entity_sources` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source_record_id` INTEGER NOT NULL,
    `entity_type` VARCHAR(64) NOT NULL,
    `entity_id` INTEGER NOT NULL,
    `revision_at_import` INTEGER NOT NULL DEFAULT 1,

    INDEX `entity_sources_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    UNIQUE INDEX `entity_sources_source_record_id_entity_type_entity_id_key`(`source_record_id`, `entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `compound_class` ADD CONSTRAINT `compound_class_compound_id_fkey` FOREIGN KEY (`compound_id`) REFERENCES `compounds`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `compound_class` ADD CONSTRAINT `compound_class_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ms_methods` ADD CONSTRAINT `ms_methods_compounds_id_fkey` FOREIGN KEY (`compounds_id`) REFERENCES `compounds`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lc_methods` ADD CONSTRAINT `lc_methods_compounds_id_fkey` FOREIGN KEY (`compounds_id`) REFERENCES `compounds`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lc_methods_items` ADD CONSTRAINT `lc_methods_items_lc_methods_id_fkey` FOREIGN KEY (`lc_methods_id`) REFERENCES `lc_methods`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `source_records` ADD CONSTRAINT `source_records_library_id_fkey` FOREIGN KEY (`library_id`) REFERENCES `spectral_libraries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `source_records` ADD CONSTRAINT `source_records_batch_id_fkey` FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `spectra` ADD CONSTRAINT `spectra_compound_id_fkey` FOREIGN KEY (`compound_id`) REFERENCES `compounds`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `spectrum_method_links` ADD CONSTRAINT `spectrum_method_links_spectrum_id_fkey` FOREIGN KEY (`spectrum_id`) REFERENCES `spectra`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `spectrum_method_links` ADD CONSTRAINT `spectrum_method_links_method_id_fkey` FOREIGN KEY (`method_id`) REFERENCES `ms_methods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `detection_profiles` ADD CONSTRAINT `detection_profiles_compound_id_fkey` FOREIGN KEY (`compound_id`) REFERENCES `compounds`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `entity_sources` ADD CONSTRAINT `entity_sources_source_record_id_fkey` FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


INSERT INTO app_metadata (id, product, schema_version, instance_id, state) VALUES (1, 'MasspecLib2', 3, '51f7a730-2b3e-4849-91cb-a05c4806768d', 'pending');
