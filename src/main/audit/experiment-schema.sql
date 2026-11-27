-- 可选实验扩展结构1。先选择已初始化的MasspecLib2结构4来源数据库。
-- 不覆盖已有表；若已有同名业务表，请使用字段映射，不执行此脚本。
CREATE TABLE IF NOT EXISTS experiment_results (
 id VARCHAR(191) PRIMARY KEY,
 compound_id INT NOT NULL,
 source_library_id INT NULL,
 batch_name VARCHAR(255) NOT NULL,
 method_name VARCHAR(255) NOT NULL,
 rule_version VARCHAR(255) NOT NULL,
 record_type VARCHAR(32) NOT NULL DEFAULT 'sample',
 status VARCHAR(32) NOT NULL DEFAULT 'draft',
 data JSON NOT NULL,
 updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 INDEX(compound_id), INDEX(updated_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS chromatogram_traces (
 id VARCHAR(191) PRIMARY KEY,
 compound_id INT NOT NULL,
 experiment_result_id VARCHAR(191) NULL,
 source_library_id INT NULL,
 method_name VARCHAR(255) NULL,
 rule_version VARCHAR(255) NULL,
 channel_role VARCHAR(64) NOT NULL DEFAULT 'quantifier',
 time_unit VARCHAR(16) NULL,
 points JSON NULL,
 image_base64 LONGTEXT NULL,
 data JSON NULL,
 status VARCHAR(32) NOT NULL DEFAULT 'draft',
 updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 INDEX(compound_id), INDEX(experiment_result_id), INDEX(updated_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS experiment_rules (
 id VARCHAR(191) PRIMARY KEY,
 method_name VARCHAR(255) NOT NULL,
 matrix VARCHAR(255) NULL,
 rule_version VARCHAR(255) NOT NULL,
 active BOOLEAN NOT NULL DEFAULT 1,
 data JSON NOT NULL,
 updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 INDEX(method_name,active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
