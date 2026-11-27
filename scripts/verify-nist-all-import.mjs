import './legacy-disabled.mjs'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'

loadEnv({ path: '.env', quiet: true })

const minId = 24347
const maxId = 25019
const db = await mysql.createConnection({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  charset: 'utf8mb4'
})

const query = async (sql, params = []) => (await db.query(sql, params))[0]

try {
  const result = {
    totals: (await query(
      'SELECT COUNT(*) AS activeCompounds FROM compounds WHERE COALESCE(is_delete, 0) = 0'
    ))[0],
    methods: (await query(
      'SELECT COUNT(*) AS totalMethods, ' +
      "SUM(mass_spectrum_base64 IS NOT NULL AND mass_spectrum_base64 <> '') AS storedSpectra " +
      'FROM ms_methods'
    ))[0],
    scopeCompounds: (await query(
      'SELECT COUNT(*) AS compounds, ' +
      "SUM(formula_diagram_base64 IS NOT NULL AND formula_diagram_base64 <> '') AS structures, " +
      "SUM(cas IS NULL OR TRIM(cas) = '') AS missingCas " +
      'FROM compounds WHERE id BETWEEN ? AND ? AND COALESCE(is_delete, 0) = 0',
      [minId, maxId]
    ))[0],
    scopeMethods: (await query(
      "SELECT COUNT(*) AS methods, SUM(ms_mode = 'MS8000') AS ms8000, " +
      "SUM(scan_mode = 'MS2') AS ms2, " +
      "SUM(mass_spectrum_base64 IS NOT NULL AND mass_spectrum_base64 <> '') AS spectra, " +
      'SUM(ce IS NULL) AS missingCe FROM ms_methods WHERE compounds_id BETWEEN ? AND ?',
      [minId, maxId]
    ))[0],
    unclassified: (await query(
      'SELECT COUNT(*) AS unclassified FROM compounds c ' +
      'LEFT JOIN compound_class cc ON cc.compound_id = c.id ' +
      'WHERE c.id BETWEEN ? AND ? AND cc.compound_id IS NULL',
      [minId, maxId]
    ))[0],
    duplicateMethodGroups: (await query(
      'SELECT COUNT(*) AS duplicateGroups FROM (' +
      'SELECT compounds_id, ms_mode, q1, q3, polarity, COUNT(*) AS methodCount ' +
      'FROM ms_methods WHERE compounds_id BETWEEN ? AND ? ' +
      'GROUP BY compounds_id, ms_mode, q1, q3, polarity HAVING COUNT(*) > 1) d',
      [minId, maxId]
    ))[0]
  }

  const rows = await query(
    'SELECT id, compounds_id, mass_spectrum_base64 FROM ms_methods ' +
    'WHERE compounds_id BETWEEN ? AND ?',
    [minId, maxId]
  )
  const payloads = { decoded: 0, invalid: 0, qqqMs2: 0, imported: 0,
    representative: 0, peakless: 0 }
  for (const row of rows) {
    try {
      const payload = JSON.parse(Buffer.from(row.mass_spectrum_base64, 'base64').toString('utf8'))
      payloads.decoded += 1
      if (payload.acquisition?.instrumentType === 'QqQ' &&
          payload.acquisition?.spectrumType === 'MS2') payloads.qqqMs2 += 1
      if (payload.match?.type === 'imported') payloads.imported += 1
      if (payload.match?.type === 'representative' || payload.representative === true ||
          payload.spectrumLabel) payloads.representative += 1
      if (!Array.isArray(payload.peaks) || payload.peaks.length === 0) payloads.peakless += 1
    } catch {
      payloads.invalid += 1
    }
  }
  result.payloads = payloads
  console.log(JSON.stringify(result, null, 2))
} finally {
  await db.end()
}
