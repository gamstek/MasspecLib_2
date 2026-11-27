export interface ClassList {
  class_name: string
  id: number
  is_custom: boolean
  _count?: {
    classLinks: number
  }
}

export interface CompoundList {
  revision: number
  cas: string
  formula: string
  formula_diagram_base64: string
  id: number
  is_delete: boolean
  is_favorite: boolean
  is_in_trash: boolean
  molecular_mass: number
  monoisotopic_mass: number
  name: { area: string; name: string }[]
  main_name: string
  mrm1_q1: number
  mrm1_q3: number
  mrm1_dp: number
  mrm1_ce: number
  mrm2_q1: number
  mrm2_q3: number
  mrm2_dp: number
  mrm2_ce: number
  isSelected: boolean
}

export interface LcMethodsList {
  temp_id?: number
  chromatographic_column_mode: string
  compounds_id: number
  id?: number
  lc_mode: string
  phase_A: string
  phase_B: string
  retention_time: number | undefined
  retention_time_unit?: string | null
  conditions?: unknown
  methodsLinks: {
    flow_rate: number | undefined
    id?: number
    percentage_A: string
    percentage_B: string
    time: number | undefined
  }[]
}

export interface MsMethodsList {
  ms_mode: string
  methods: {
    cad_type: string
    cad_value: number | undefined
    compounds_id: number
    dp: number | undefined
    cxp: number | undefined
    id?: number
    ion_source: string
    mass_spectrum_base64: string
    ms_mode: string
    polarity: 0 | 1 | undefined
    q1: number | undefined
    q3: number | undefined
    ce: number | undefined
    transition_role?: string | null
    adduct?: string | null
    ce_unit?: string | null
    energy_type?: string | null
    conditions?: unknown
    scan_mode: string
  }[]
}

export interface SpectrumPoint {
  mz: number // m/z 值
  intensity: number // 强度（cps）
  label?: string // 可选：自定义峰标签
}

export type SpectrumData = SpectrumPoint[]

export type SpectrumImportStatus = 'ready' | 'warning' | 'error'
export type SpectrumImportEntityAction = 'match' | 'create'

export interface SpectrumImportRow {
  rowNo?: number
  spectrumId: string
  compoundId: number | string | null
  cas: string
  compoundName: string
  methodId: number | string | null
  msMode: string
  q1: number | string | null
  q3: number | string | null
  polarity: 0 | 1 | string | null
  collisionEnergy: number | string | null
  precursorType: string
  precursorMz: number | string | null
  spectrumType: string
  instrumentType: string
  instrumentName: string
  ionization: string
  sourceName: string
  notes: string
  peaksText: string
  overwriteExisting: boolean
  compoundAction?: SpectrumImportEntityAction
  methodAction?: SpectrumImportEntityAction
  compoundMatchKey?: string
  methodMatchKey?: string
  status?: SpectrumImportStatus
  messages?: string[]
  peakCount?: number
  hasExistingSpectrum?: boolean
  massSpectrumBase64?: string
}

export interface SpectrumImportSummary {
  total: number
  ready: number
  errors: number
  warnings: number
  compounds: number
  methods: number
  newCompounds: number
  newMethods: number
}
