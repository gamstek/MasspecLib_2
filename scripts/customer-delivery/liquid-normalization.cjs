const { mobilePhaseDisplay, liquidProgramDisplay, columnDimensionValue, columnFilmThickness } = require('../../src/shared/scientificDisplay.ts')
function normalizeLiquid(method) {
  const result = { ...method }
  const phases = mobilePhaseDisplay(method)
  if (phases.phase_A) result.phase_A = phases.phase_A
  if (phases.phase_B) result.phase_B = phases.phase_B
  for (const key of ['column_type', 'column_length_mm', 'column_inner_diameter_mm', 'column_particle_size_um']) {
    const value = columnDimensionValue(method, key)
    if (value != null && value !== '') result[key] = value
  }
  const parsed = liquidProgramDisplay(method.program_text)
  if (!method.gradient?.length && parsed.steps.length) result.gradient = parsed.steps.map((step, step_order) => ({ ...step, step_order }))
  if (!method.elution_mode && parsed.elution) result.elution_mode = parsed.elution
  if (columnFilmThickness(method) != null) result.column_film_thickness_um = columnFilmThickness(method)
  return result
}
module.exports = { normalizeLiquid }
