// Quality Harness V2 — CDP 客户端（兼容入口）
//
// V1 时期这里是一个 280+ 行的单文件实现。V2 按「单文件不超过 300 行」的要求拆分为：
//
//   cdp/client.mjs    连接 / RPC / 求值 / 等待 / runtime 错误汇总
//   cdp/events.mjs    runtime error 与告警的采集、归一化、allowlist 分类
//   cdp/browser.mjs   端口发现、受控输入、点击
//
// 本文件保留为**再导出入口**：既有脚本的历史导入路径（如
// `import { connect, sleep, typeInto } from './cdpClient.mjs'`）继续可用，
// 不需要为了拆分去改动调用方。新代码建议直接从 ./cdp/ 下的具体模块导入。

export {
  connect,
  sleep,
  summarizeRuntime,
} from './cdp/client.mjs';

export {
  ERROR_BINDING,
  countAllowlistedWarnings,
  createRuntimeCollector,
  splitErrors,
} from './cdp/events.mjs';

export {
  click,
  typeInto,
  waitForCdpPort,
} from './cdp/browser.mjs';
