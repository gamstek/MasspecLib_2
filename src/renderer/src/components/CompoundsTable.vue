<template>
  <el-dialog
    v-model="visible"
    :title="customLibName ? '编辑库' : '新增库'"
    width="80%"
    :append-to-body="true"
    :destroy-on-close="true"
    @close="close"
    @open="open"
  >
    <div class="compounds-table-page">
      <div class="title-wrap">
        <div class="left-wrap">
          <span class="title">全部化合物</span>
          <el-form-item label="库名称" class="lib-name">
            <el-input v-model="libName" placeholder="请输入库名" @change="changeLibName"></el-input>
          </el-form-item>
        </div>
        <div class="right-wrap">
          <el-input class="search-wrap" v-model="keys" placeholder="搜索" @change="getCompoundList">
            <template #append>
              <el-button :icon="Search" @search="getCompoundList" />
            </template>
          </el-input>
        </div>
      </div>
      <div class="list-table">
        <el-table
          ref="tableRef"
          class="list-view-table-wrap"
          :data="compoundList"
          width="100%"
          row-key="id"
          @select="changeSelection"
        >
          <el-table-column type="selection" width="55" fixed />
          <el-table-column prop="main_name" label="Name" align="center" fixed width="180px" />
          <el-table-column prop="cas" label="CAS" align="center" fixed width="100px" />
          <el-table-column prop="formula" label="Formula" align="center" fixed width="140px" />
          <el-table-column label="MRM1" align="center">
            <el-table-column prop="mrm1_q1" label="Q1" align="center" />
            <el-table-column prop="mrm1_q3" label="Q3" align="center" />
            <el-table-column prop="mrm1_dp" label="DP" align="center" />
            <el-table-column prop="mrm1_ce" label="CE" align="center" />
          </el-table-column>
          <el-table-column label="MRM2" align="center">
            <el-table-column prop="mrm2_q1" label="Q1" align="center" />
            <el-table-column prop="mrm2_q3" label="Q3" align="center" />
            <el-table-column prop="mrm2_dp" label="DP" align="center" />
            <el-table-column prop="mrm2_ce" label="CE" align="center" />
          </el-table-column>
        </el-table>
      </div>
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[30, 50, 100, 400]"
          size="default"
          layout="total, sizes, prev, pager, next, jumper"
          :total="total"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
      <div class="submit-wrap">
        <el-button type="success" @click="submit">保存</el-button>
        <el-button @click="cancle">取消</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { invokeIPC } from '../utils/ipcInvoke'

import { ref, computed, watch, nextTick } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { CompoundList } from '@renderer/type'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ClassList } from '@renderer/type'
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  customLibName: {
    type: String,
    default: ''
  },
  customLibId: {
    type: Number,
    default: undefined
  }
})
const tableRef = ref()
const emit = defineEmits(['update:modelValue', 'updateCustomClasses'])
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})
let compoundList = ref<CompoundList[]>([])
const page = ref(1)
const pageSize = ref(50)
const total = ref(0)
const keys = ref('')
const loading = ref(false)
const libName = ref('')
let defaultSelectedRowIds: number[] = []
const changeLibName = (name: string) => {
  libName.value = name
}
const handleSizeChange = (val: number) => {
  console.log(`${val} items per page`)
  getCompoundList()
}

const handleCurrentChange = (val: number) => {
  console.log(`current page: ${val}`)
  getCompoundList()
}

const getCompoundList = () => {
  loading.value = true
  window.electron.ipcRenderer
    .invoke('compound:list', {
      page: page.value,
      pageSize: pageSize.value,
      keyword: keys.value,
      classId: 0
    })
    .then((res: { list: CompoundList[]; page: number; pageSize: number; total: number }) => {
      console.log('compound:list===>', res)
      compoundList.value = res.list
      page.value = res.page
      pageSize.value = res.pageSize
      total.value = res.total
      nextTick(() => {
        res.list.forEach((row) => {
          if (defaultSelectedRowIds.includes(row.id)) {
            tableRef.value?.toggleRowSelection(row, true)
          }
        })
      })
    })
    .finally(() => {
      loading.value = false
    })
}

const getCompoundIdsByClass = () => {
  if (props.customLibId !== undefined) {
    window.electron.ipcRenderer
      .invoke('compound:class:ids', props.customLibId)
      .then((res: number[]) => {
        defaultSelectedRowIds = res
        if (tableRef.value && res.length) {
          tableRef.value.clearSelection()
          console.log('getCompoundIdsByClass===>', res)
          const timmer = setTimeout(() => {
            compoundList.value.forEach((row) => {
              if (defaultSelectedRowIds.includes(row.id)) {
                tableRef.value.toggleRowSelection(row, true)
              }
            })
            clearTimeout(timmer)
          }, 500)
        }
      })
  }
}

const cancle = () => {
  ElMessageBox.confirm('确认取消吗?', '警告', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    type: 'warning'
  })
    .then(() => {
      visible.value = false
    })
    .catch(() => {})
}

const submit = () => {
  if (libName.value) {
    const params = {
      classId: props.customLibId,
      className: libName.value,
      compoundIds: defaultSelectedRowIds
    }
    invokeIPC('compound:class:update', params).then((res: ClassList) => {
      ElMessage.success('操作成功！')
      visible.value = false
      emit('updateCustomClasses', res)
    })
  } else {
    ElMessage.error('请输入库名称')
  }
}

const changeSelection = (rows: CompoundList[]) => {
  const selectedRowIdsNotInCurrentPage = defaultSelectedRowIds.filter((id) => !compoundList.value.some((item) => item.id === id))
  defaultSelectedRowIds = selectedRowIdsNotInCurrentPage.concat(rows.map((item) => item.id))
}

watch(
  () => props.customLibName,
  () => {
    libName.value = props.customLibName
    getCompoundIdsByClass()
  },
  {
    immediate: true
  }
)

const open = () => {
  getCompoundList()
}
const close = () => {
  page.value = 1
  pageSize.value = 50
  total.value = 0
}
</script>
<style lang="less" scoped>
.compounds-table-page {
  background: #fff;
  height: 100%;
  position: relative;
  padding-bottom: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  .title-wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    border-bottom: 2px solid #333;
    .left-wrap {
      display: flex;
      align-items: center;
      .title {
        display: inline-block;
        width: 140px;
        margin-left: 8px;
        margin-right: 8px;
      }
      .lib-name {
        margin-bottom: 0;
      }
    }
    .right-wrap {
      margin-right: 8px;
    }
    .icon {
      font-size: 24px;
      margin-right: 8px;
      cursor: pointer;
    }
  }
  .pagination-wrap {
    position: absolute;
    right: 0px;
    bottom: 40px;
    z-index: 1000;
    background: var(--el-bg-color);
    padding: 12px 16px;
    backdrop-filter: blur(10px);
  }
  .list-view-table-wrap {
    height: calc(50vh - 20px);
  }
  .empty-contain {
    width: 100%;
  }
  .submit-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 56px;
  }
}
</style>
