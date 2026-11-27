/* eslint-disable @typescript-eslint/no-explicit-any */
// src/main/ipc/compounds.ts
import { ipcMain } from 'electron'
import { prisma } from '../database'

export function registerClassIPC(): void {
  // 获取化合物自定义分类列表
  ipcMain.handle('class:customList', async () => {
    const where: any = {
      is_custom: true
    }
    const [list] = await Promise.all([
      prisma.classes.findMany({
        where,
        orderBy: { id: 'desc' }
      })
    ])

    return list
  })
  ipcMain.handle('compound:class:ids', async (_, classId: number) => {
    const list = await prisma.compound_class.findMany({
      where: {
        class_id: classId
      },
      select: { compound_id: true },
      orderBy: { compound_id: 'asc' }
    })
    const compoundIds = list.map((item) => item.compound_id)
    return compoundIds
  })
  /**
   * 修改自定义库及包含化合物
   */
  ipcMain.handle(
    'compound:class:update',
    async (
      _,
      params: { classId: number | undefined; className: string; compoundIds: number[] }
    ) => {
      if (!params.className.trim()) throw new Error('库名称不能为空')
      return prisma.$transaction(async (tx) => {
        if (params.classId !== undefined) {
          // 更新 classes 表中的 class_name
          await tx.classes.update({
            where: { id: params.classId },
            data: { class_name: params.className }
          })
          // 删除 compound_class 表中所有当前 classId 的关联数据
          await tx.compound_class.deleteMany({
            where: { class_id: params.classId }
          })
          // 添加新的 compoundIds 关联数据（批量插入）
          if (params.compoundIds.length > 0) {
            await tx.compound_class.createMany({
              data: params.compoundIds.map((compoundId) => ({
                compound_id: compoundId,
                class_id: params.classId!,
                create_time: new Date(),
                update_time: new Date()
              })),
              skipDuplicates: true // 跳过重复插入（可选，防止主键冲突）
            })
          }
        } else {
          // classId 为 undefined 时，创建新 class
          const newClass = await tx.classes.create({
            data: {
              class_name: params.className,
              is_custom: true, // is_custom 为 true（对应你的 1，Prisma Boolean 映射为 1/0）
              create_time: new Date(),
              update_time: new Date()
            }
          })
          params.classId = newClass.id
          // 为新 class 添加 compoundIds 关联数据（批量插入）
          if (params.compoundIds.length > 0) {
            await tx.compound_class.createMany({
              data: params.compoundIds.map((compoundId) => ({
                compound_id: compoundId,
                class_id: newClass.id, // 使用新创建的 classId
                create_time: new Date(),
                update_time: new Date()
              })),
              skipDuplicates: true
            })
          }
        }
        return { id: params.classId, class_name: params.className, is_custom: true }
      })
    }
  )
  // 获取化合物分类列表
  ipcMain.handle('class:list', async () => {
    const where: any = {
      is_custom: false
    }
    const [list] = await Promise.all([
      prisma.classes.findMany({
        where,
        orderBy: { id: 'desc' },
        select: {
          id: true,
          class_name: true,
          is_custom: true,
          create_time: true,
          update_time: true,
          // 统计该分类下的化合物数量（只统计未删除的）
          _count: {
            select: {
              classLinks: {
                where: {
                  compound: {
                    is_delete: false,
                    is_in_trash: false // 只算未删除的化合物
                  }
                }
              }
            }
          }
        }
      })
    ])
    return list
  })
  // 获取化合物所属分类列表
  ipcMain.handle('compound:class-names', async (_, compoundId: number) => {
    const classes = await prisma.classes.findMany({
      where: {
        classLinks: {
          some: {
            compound_id: compoundId,
            compound: { is_delete: false }
          }
        }
      },
      select: { id: true, class_name: true, is_custom: true },
      orderBy: { id: 'asc' }
    })

    return classes
  })
}
