// Quality Harness V2 — 桌面 E2E 共享动作（兼容入口）
//
// V1 时期这里是一个 492 行的单文件。V2 按「单文件不超过 300 行」的要求拆分为：
//
//   actions/login.mjs       登录流程与就绪判断
//   actions/aiPanel.mjs     AI 协作窗展开 / 状态采集 / composer 输入
//   actions/navigation.mjs  一级导航点击与内容就绪等待
//   actions/bom.mjs         项目选中与 BOM 页签渲染验证
//   actions/settings.mjs    设置页打开与凭据泄漏形状检查
//   actions/storage.mjs     测试侧 localStorage 读写
//
// 本文件保留为**再导出入口**：既有导入路径继续可用，不需要为了拆分改调用方。
// 新代码建议直接从 ./actions/<域>.mjs 导入。

export { TEST_USERNAME, login, waitForLoginReady } from './actions/login.mjs';
export { clearComposer, collectAiPanelState, expandAiPanel, typeInComposer } from './actions/aiPanel.mjs';
export { NAV_ENTRIES, navigateTo } from './actions/navigation.mjs';
export { countFixtureBomRows, openFixtureProjectBom } from './actions/bom.mjs';
export { inspectSettingsForCredentialLeaks } from './actions/settings.mjs';
export { readLocalStorage, writeLocalStorage } from './actions/storage.mjs';

// CDP 小工具：历史调用方从 actions.mjs 取用，继续保留
export { click, sleep, typeInto } from './cdpClient.mjs';
