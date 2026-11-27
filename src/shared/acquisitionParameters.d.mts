export const acquisitionFields: Record<string, string>
export const parameterDefaultUnits: Readonly<Record<string, string>>
export const quantityParameterKeys: string[]
export function object(value: any): Record<string, any>
export function isTransitionMethod(method: Record<string, any>): boolean
export function methodQualityIssue(method: Record<string, any>, validate?: boolean): string
export function parameterQuantity(value: any, defaultUnit: string): any
export function normalizeAcquisition(method?: Record<string, any>): Record<string, any>
export function acquisitionView(method?: Record<string, any>): Record<string, any>
export function quantityText(value: any): string
export function acquisitionRowsForMethod(method: Record<string, any>): { label: string; value: string }[]
export function lcFlowRate(method?: Record<string, any>): any
