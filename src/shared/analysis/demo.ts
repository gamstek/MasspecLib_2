import type { DetectionPackage, DetectionRow, Trace } from './types.ts'
export function detectionDemo(): DetectionPackage {
  const gaussian = (left = 0.25, right = left, split = false): Trace => ({
    timeUnit: 'min',
    points: Array.from({ length: 501 }, (_, i) => {
      const time = i / 50,
        width = time < 5 ? left : right
      const intensity = split
        ? 100000 * Math.exp(-0.5 * ((time - 4.7) / 0.14) ** 2) +
          80000 * Math.exp(-0.5 * ((time - 5.3) / 0.14) ** 2)
        : 100000 * Math.exp(-0.5 * ((time - 5) / width) ** 2)
      return { time, intensity: Number(intensity.toFixed(5)) }
    })
  })
  const labels = [
    '正常',
    '前延',
    '拖尾',
    '疑似分叉',
    '数值超限',
    '离子比异常',
    '多项异常',
    '缺少曲线',
    '缺少限量',
    '缺少参考比',
    '低于定量限',
    '疑似饱和',
    '采样不足',
    '离子比不适用',
    '积分边界截断'
  ]
  const results: DetectionRow[] = labels.map((label, i) => ({
    id: 'DEMO-' + String(i + 1).padStart(2, '0'),
    sample: `演示样品${i + 1}·${label}`,
    compound: '模拟目标物（非真实物质）',
    matrix: '模拟基质',
    expectedRt: 5,
    rtWindow: 3.5,
    trace: gaussian(),
    measurement: { value: 0.005, unit: 'mg/kg', modifier: 'value' },
    limit: {
      value: 0.01,
      unit: 'mg/kg',
      source: '模拟限量，仅供软件演示，非真实标准',
      matrix: '模拟基质'
    },
    ratio: {
      quantifierArea: 100000,
      qualifierArea: 50000,
      reference: 0.5,
      tolerancePct: 30,
      referenceSource: '模拟同批标准，仅供软件演示'
    }
  }))
  results[1].trace = gaussian(0.8, 0.25)
  results[2].trace = gaussian(0.25, 0.8)
  results[3].trace = gaussian(0.25, 0.25, true)
  results[4].measurement!.value = 0.03
  results[5].ratio!.qualifierArea = 80000
  results[6].trace = gaussian(0.25, 0.8)
  results[6].measurement!.value = 0.04
  results[6].ratio!.qualifierArea = 80000
  delete results[7].trace
  delete results[8].limit
  delete results[9].ratio!.reference
  results[10].measurement = { unit: 'mg/kg', modifier: 'ltLOQ', loq: 0.02 }
  results[11].peakRules = { saturationIntensity: 99999 }
  results[12].trace = {
    timeUnit: 'min',
    points: [
      { time: 0, intensity: 0 },
      { time: 4, intensity: 1 },
      { time: 5, intensity: 100 },
      { time: 10, intensity: 0 }
    ]
  }
  results[13].ratio = { required: false }
  results[14].integration = { start: 4.8, end: 5.2 }
  return {
    formatVersion: 1,
    batchName: '检测结果功能演示（15条模拟数据）',
    methodName: '模拟审核方法，不用于实验判定',
    ruleVersion: 'demo-1',
    demo: true,
    peakRules: {
      tailingMin: 0.8,
      tailingMax: 1.6,
      minPoints: 7,
      splitMinRelativeHeight: 0.25,
      splitMaxValleyFraction: 0.75,
      splitMinDistanceMin: 0.15
    },
    results
  }
}
