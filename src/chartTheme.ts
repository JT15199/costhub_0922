// CostHub 统一图表主题
// 所有 ECharts 图表共享的样式配置，支持 macOS 玻璃等主题
// 用法：在 option 里覆盖需要的字段，未覆盖的自动继承这里

// 基础图表色板（蓝紫系，配合 macOS 玻璃主题）
export const CHART_COLORS = ['#0A84FF', '#5E5CE6', '#BF5AF2', '#FF9F0A', '#34C759', '#FF375F', '#64D2FF', '#98989D'];

// 读取当前主题，动态适配
function isMacos(): boolean {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'macos';
}

// 统一的文本颜色（适配主题）
export function chartTextColor(): string {
  return isMacos() ? '#1D1D1F' : '#334155';
}

export function chartTextMuted(): string {
  return isMacos() ? '#6E6E73' : '#64748B';
}

export function chartSplitLine(): string {
  return isMacos() ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.06)';
}

// 基础 tooltip 样式（统一玻璃感）
export function chartTooltip(trigger: 'axis' | 'item' = 'axis') {
  return {
    trigger,
    backgroundColor: isMacos() ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.96)',
    borderColor: 'rgba(0,0,0,0.08)',
    borderWidth: 1,
    padding: [10, 14],
    textStyle: { fontSize: 12, color: chartTextColor() },
    extraCssText: isMacos()
      ? 'backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.12);'
      : 'border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.08);',
    // 轴指示器：虚线+渐变
    axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(10,132,255,0.06)' } },
  };
}

// 统一的直角坐标系样式（xAxis / yAxis 通用覆盖）
// 第二个参数可传入 axisLabel 覆盖项（如 rotate），会自动与默认 label 合并
export function chartAxisStyle(axisLabelFontSize = 11, axisLabelExtra: any = {}) {
  return {
    axisLabel: { fontSize: axisLabelFontSize, color: chartTextMuted(), ...axisLabelExtra },
    axisLine: { lineStyle: { color: chartSplitLine() } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: chartSplitLine(), type: 'dashed' as const } },
  };
}

// 生成柱状图的渐变色（顶深底浅，视觉更高级）
export function barGradient(color: string): any {
  // 底部淡化：hex 直接拼透明度后缀（#RRGGBB22）；rgba() 不能拼（会得到非法颜色 → 条形不渲染），改为 alpha 减半
  let bottom = color + '22';
  const m = color.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map(s => s.trim());
    const a = parseFloat(parts[3] ?? '1');
    bottom = `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${(isNaN(a) ? 1 : a) * 0.5})`;
  }
  return {
    type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color },
      { offset: 1, color: bottom },
    ],
  };
}

// 柱状图系列默认（统一圆角、渐变、动画）
export function chartBarSeries(extra: any = {}) {
  return {
    type: 'bar' as const,
    barWidth: '50%' as const,
    itemStyle: {
      borderRadius: [8, 8, 0, 0],
    },
    // 平滑动画
    animationDuration: 600,
    animationEasing: 'cubicOut' as const,
    animationDelay: (idx: number) => idx * 40,
    ...extra,
  };
}

// 折线/面积图默认（渐变面积 + 平滑动画）
export function chartLineSeries(extra: any = {}) {
  return {
    type: 'line' as const,
    smooth: true,
    symbol: 'circle' as const,
    symbolSize: 6,
    lineStyle: { width: 2.5 },
    // 面积渐变默认（调用方可覆盖）
    areaStyle: {
      color: {
        type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(10,132,255,0.28)' },
          { offset: 1, color: 'rgba(10,132,255,0)' },
        ],
      },
    },
    animationDuration: 800,
    animationEasing: 'cubicOut' as const,
    ...extra,
  };
}

// 目标参考线（markLine）—— 成本目标对比的视觉强化
export function goalMarkLine(value: number, label = '目标成本', color = '#FF9F0A') {
  return {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color, type: 'dashed' as const, width: 1.5 },
    label: {
      show: true, position: 'insideEndTop' as const, fontSize: 10, color,
      formatter: `${label}: ¥${value.toFixed(2)}`,
      backgroundColor: 'rgba(255,255,255,0.85)', padding: [2, 6], borderRadius: 4,
    },
    data: [{ yAxis: value }],
  };
}

// 饼图系列默认（玻璃圆环）
export function chartPieSeries(extra: any = {}) {
  return {
    type: 'pie' as const,
    radius: ['48%', '72%'] as [string, string],
    center: ['50%', '52%'] as [string, string],
    padAngle: 3,
    itemStyle: {
      borderRadius: 8,
      borderColor: isMacos() ? 'rgba(255,255,255,0.8)' : '#fff',
      borderWidth: 2,
    },
    label: { show: false },
    emphasis: {
      label: { show: true, fontSize: 13, fontWeight: 600, color: chartTextColor() },
      scaleSize: 6,
    },
    animationType: 'scale' as const,
    animationDuration: 700,
    ...extra,
  };
}

// 通用网格配置
export function chartGrid(extra: any = {}) {
  return { top: 30, right: 20, bottom: 40, left: 60, ...extra };
}


// 深色文字工具函数
export function formatMoney(v: number): string {
  return `¥${v.toFixed(2)}`;
}

// 检测组件是否在 macOS 主题下的 hook 帮助（如果需要在渲染时动态响应主题变化）
export { isMacos };
