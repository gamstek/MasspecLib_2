const TABLES = new Set([
  'compounds',
  'taxonomy_categories',
  'compound_taxonomy',
  'classes',
  'compound_class',
  'ms_methods',
  'lc_methods',
  'lc_methods_items',
  'app_metadata',
  'spectral_libraries',
  'import_batches',
  'source_records',
  'spectra',
  'spectrum_method_links',
  'detection_profiles',
  'entity_sources'
])

// Parse quotes and comments before inspecting executable statements. This accepts the generated
// initialization subset, not arbitrary dumps, server configuration, or cross-schema statements.
export function splitInitializationSql(input: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote = ''
  let comment = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i],
      next = input[i + 1]
    if (comment === 'line') {
      if (char === '\n') {
        comment = ''
        current += '\n'
      }
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = ''
        i++
        current += ' '
      }
      continue
    }
    if (quote) {
      current += char
      if (char === '\\' && quote !== '`') {
        current += input[++i] ?? ''
        continue
      }
      if (char === quote) {
        if (next === quote) {
          current += input[++i]
          continue
        }
        quote = ''
      }
      continue
    }
    if (char === '-' && next === '-' && /\s/.test(input[i + 2] ?? '')) {
      comment = 'line'
      i++
      continue
    }
    if (char === '#') {
      comment = 'line'
      continue
    }
    if (char === '/' && next === '*') {
      if (input[i + 2] === '!' || input[i + 2] === '+') throw new Error('不支持可执行注释')
      comment = 'block'
      i++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote || comment === 'block') throw new Error('SQL 引号或注释未闭合')
  if (current.trim()) statements.push(current.trim())
  return statements
}

export function validateInitializationSql(input: string): string[] {
  const statements = splitInitializationSql(input)
  if (!statements.length) throw new Error('SQL 文件为空')
  let inserts = 0
  for (const statement of statements) {
    // Replace literals, but retain quoted identifiers for qualified-reference validation.
    const structural = statement
      .replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"/g, "''")
      .replace(/\bON\s+(?:DELETE|UPDATE)\s+(?:RESTRICT|CASCADE|SET\s+NULL|NO\s+ACTION)\b/gi, '')
    const match = structural.match(
      /^(?:CREATE\s+TABLE\s+|INSERT\s+INTO\s+|ALTER\s+TABLE\s+)(`\w+`|\w+)(?=\s|\()/i
    )
    if (!match || !TABLES.has(match[1].replaceAll('`', '')))
      throw new Error('初始化只接受新版生成的建表、关联和数据语句')
    if (/`[^`]+`\s*\.|\b[A-Za-z_]\w*\s*\.\s*(?:`|[A-Za-z_])/.test(structural))
      throw new Error('不允许跨数据库引用')
    if (
      /\b(?:SELECT|LOAD|OUTFILE|INFILE|TRIGGER|PROCEDURE|FUNCTION|DEFINER|GRANT|DROP|DELETE|UPDATE|REPLACE|USE|CALL|SLEEP|BENCHMARK)\b/i.test(
        structural
      )
    ) {
      throw new Error('初始化 SQL 含不支持的操作')
    }
    if (
      /^ALTER/i.test(structural) &&
      !/^ALTER\s+TABLE\s+`?\w+`?\s+ADD\s+CONSTRAINT\s+`?\w+`?\s+FOREIGN\s+KEY/i.test(structural)
    ) {
      throw new Error('只支持新增外键的 ALTER TABLE')
    }
    for (const reference of structural.matchAll(/REFERENCES\s+`?(\w+)`?/gi)) {
      if (!TABLES.has(reference[1])) throw new Error('外键指向未知表')
    }
    if (/^INSERT/i.test(structural)) inserts++
  }
  if (!inserts) throw new Error('初始化 SQL 缺少版本和基础数据')
  return statements
}
