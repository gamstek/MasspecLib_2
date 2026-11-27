export interface ClassificationPlan { pending: boolean; nativeCategoryIds: number[]; ruleCategoryIds: number[]; overrideIds: string[]; includeIds: string[] }
export function categoryKey(c: {namespace: string; category_code: string}): string
export function recordKey(database: string, id: string | number): string
export function isProjectAxis(axis: string): boolean
export function descendants(catalog: any[], key: string): Set<string>
export function localCatalog(catalog: any[]): any[]
export function displayLibrary(library: any, peers: any[]): string
export function classificationPlan(state: any, library: any, allCategories: any[], selectedKey: string): ClassificationPlan
export function classificationWhere(plan: ClassificationPlan): {where: string; params: (string | number)[]}
export function categoryViewNode(key: string): string
export function classificationMembership(state: any, library: any, sourceKeys: string[], id: string): any[]
