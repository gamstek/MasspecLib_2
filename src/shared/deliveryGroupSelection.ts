type Member = { libraryId?: string; compoundId: string | number }
type Library = { id: string; title: string }
type Criteria = { libraryId: string; keyword?: string; classIds?: number[]; categoryKey?: string }
type Selection = Criteria & {
  displayName: string
  onlySelected: boolean
  compoundIds: number[]
  estimatedCount?: number
  revision?: string
}
type Query = (input: Criteria & { page?: number; countOnly?: boolean; onlySelected?: boolean; compoundIds?: number[] }) =>
  Promise<{ total: number; revision?: string; rows: { id: string | number }[] }>

const selectionLimit = 20000

export async function addDeliveryGroup(
  members: Member[], libraries: Library[], current: Selection[], query: Query
): Promise<Selection[]> {
  if (!members.length) throw new Error('该自建分组没有记录')
  const titles = new Map(libraries.map(library => [library.id, library.title]))
  const grouped = new Map<string, Set<number>>()
  for (const { libraryId, compoundId } of members) {
    const id = Number(compoundId)
    if (!libraryId || !titles.has(libraryId) || !Number.isSafeInteger(id) || id < 1)
      throw new Error('分组包含本地数据或当前无法交付的记录，请检查分组中的数据库')
    let group = grouped.get(libraryId)
    if (!group) grouped.set(libraryId, group = new Set())
    group.add(id)
  }

  const selections = [...current]
  if (new Set([...current.map(item => item.libraryId), ...grouped.keys()]).size > 100)
    throw new Error('交付范围最多包含 100 个数据库')
  for (const [libraryId, group] of grouped) {
    const title = titles.get(libraryId)!
    const assertSize = (size: number): void => {
      if (size > selectionLimit) throw new Error(`「${title}」的交付范围超过 20,000 条，请缩小分组或筛选范围`)
    }
    assertSize(group.size)
    const index = selections.findIndex(item => item.libraryId === libraryId)
    const saved = selections[index]
    const base = await query({ libraryId, countOnly: true, onlySelected: true, compoundIds: [...group] })
    if (base.total !== group.size)
      throw new Error(`「${title}」有 ${group.size - base.total} 条分组记录不可用，请检查分组后重试`)

    const checkRevision = (revision?: string): void => {
      if (revision !== base.revision || (saved?.revision && saved.revision !== revision))
        throw new Error(`「${title}」内容已更新，请重新核对该库的交付范围`)
    }
    checkRevision(base.revision)
    if (saved) {
      const criteria = { libraryId, keyword: saved.keyword, classIds: saved.classIds, categoryKey: saved.categoryKey }
      if (saved.onlySelected) {
        saved.compoundIds.forEach(id => group.add(id))
      } else {
        if (!saved.keyword && !saved.classIds?.length && !saved.categoryKey) continue
        const overlap = await query({ ...criteria, countOnly:true, onlySelected:true, compoundIds:[...group] })
        checkRevision(overlap.revision)
        if (overlap.total === group.size) continue
        const first = await query({ ...criteria, page: 1 })
        checkRevision(first.revision)
        assertSize(first.total + group.size - overlap.total)
        const criteriaIds = new Set(first.rows.map(row => Number(row.id)))
        for (let page = 2; page <= Math.ceil(first.total / 50); page++) {
          const next = await query({ ...criteria, page })
          checkRevision(next.revision)
          if (next.total !== first.total) throw new Error(`「${title}」内容已更新，请重试`)
          next.rows.forEach(row => criteriaIds.add(Number(row.id)))
        }
        if (criteriaIds.size !== first.total) throw new Error(`「${title}」内容已更新，请重试`)
        criteriaIds.forEach(id => group.add(id))
      }
      assertSize(group.size)
      const merged = await query({ libraryId, countOnly:true, onlySelected:true, compoundIds:[...group] })
      checkRevision(merged.revision)
      if (merged.total !== group.size) throw new Error(`「${title}」有记录已失效，请重新核对交付范围`)
    }

    let displayName = saved?.displayName || title
    for (let suffix = 2; selections.some(item => item.libraryId !== libraryId && item.displayName === displayName); suffix++) {
      const ending = `（${suffix}）`
      displayName = title.slice(0, 120 - ending.length) + ending
    }
    const selection = {
      libraryId, displayName, revision: base.revision, keyword: '', classIds: [], categoryKey: '',
      onlySelected: true, compoundIds: [...group].sort((a, b) => a - b), estimatedCount: group.size
    }
    if (index >= 0) selections[index] = selection
    else selections.push(selection)
  }
  return selections
}
