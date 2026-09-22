// CostHub ECharts 按需注册（v2.3.19 性能优化）
// 只注册实际用到的图表类型与组件，显著减小打包体积
// 新增图表类型时：先在下面注册，否则渲染空白且不报错
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, RadarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';

echarts.use([
  // 图表
  BarChart, LineChart, PieChart, RadarChart,
  // 组件
  GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkLineComponent,
  // 渲染器
  CanvasRenderer, SVGRenderer,
]);

export default echarts;
