import type { RowDataPacket } from 'mysql2/promise'
import { connection, pool, query } from './registry'
import { validateDatabaseTarget } from '../../shared/databaseTarget'
export async function upgradeDatabase(id: string): Promise<void> {
  const entry = connection(id)
  if (entry.adapter !== 'native' || !entry.writable)
    throw new Error('仅允许升级可写的 MasspecLib2 新库')
  validateDatabaseTarget(entry.database)
  const db = await (await pool(entry)).getConnection()
  let locked = false
  try {
    const [lock] = await db.query<RowDataPacket[]>(
      "SELECT GET_LOCK('MasspecLib2-schema-upgrade', 5) AS acquired"
    )
    if (Number(lock[0].acquired) !== 1) throw new Error('另一个升级正在执行')
    locked = true
    const [metadata] = await db.query<RowDataPacket[]>('SELECT * FROM app_metadata WHERE id=1')
    const item = metadata[0]
    if (
      !item ||
      item.product !== 'MasspecLib2' ||
      item.state !== 'ready' ||
      ![2, 3, 4].includes(Number(item.schema_version))
    )
      throw new Error('目标不是受支持且已初始化的 MasspecLib2 新库')
    const additions: Record<string, Record<string, string>> = {
      compounds: { name_zh: 'VARCHAR(255) NULL', name_en: 'VARCHAR(255) NULL' },
      spectral_libraries: { source_type: "VARCHAR(32) NOT NULL DEFAULT 'unknown'" },
      ms_methods: { transition_role: 'VARCHAR(32) NULL' },
      lc_methods: {
        column_type: 'VARCHAR(255) NULL',
        column_length_mm: 'DECIMAL(10,3) NULL',
        column_inner_diameter_mm: 'DECIMAL(10,3) NULL',
        column_particle_size_um: 'DECIMAL(10,3) NULL',
        column_temperature_c: 'DECIMAL(10,3) NULL',
        elution_mode: 'VARCHAR(32) NULL',
        program_text: 'TEXT NULL'
      }
    }
    for (const [table, columns] of Object.entries(additions)) {
      const [rows] = await db.query<RowDataPacket[]>(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
        [entry.database, table]
      )
      const existing = new Set(rows.map((x) => x.COLUMN_NAME))
      for (const [column, ddl] of Object.entries(columns))
        if (!existing.has(column))
          await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`)
    }
    await db.query('ALTER TABLE lc_methods MODIFY phase_A TEXT NULL, MODIFY phase_B TEXT NULL')
    await db.query(`CREATE TABLE IF NOT EXISTS taxonomy_categories (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, namespace VARCHAR(64) NOT NULL,
      category_code VARCHAR(100) NOT NULL, category_name VARCHAR(255) NOT NULL,
      axis VARCHAR(64) NOT NULL, parent_code VARCHAR(100) NULL, description TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      UNIQUE KEY taxonomy_categories_namespace_category_code_key(namespace,category_code),
      KEY taxonomy_categories_namespace_parent_code_idx(namespace,parent_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.query(`CREATE TABLE IF NOT EXISTS compound_taxonomy (
      compound_id INT NOT NULL, category_id INT NOT NULL, evidence JSON NULL,
      PRIMARY KEY(compound_id,category_id), KEY compound_taxonomy_category_id_compound_id_idx(category_id,compound_id),
      FOREIGN KEY(compound_id) REFERENCES compounds(id), FOREIGN KEY(category_id) REFERENCES taxonomy_categories(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.query('UPDATE app_metadata SET schema_version=4 WHERE id=1')
  } finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('MasspecLib2-schema-upgrade')")
    db.release()
  }
  // No guessed language, column type or source classification backfill.
  await query(entry, 'SELECT schema_version FROM app_metadata WHERE id=1')
}
