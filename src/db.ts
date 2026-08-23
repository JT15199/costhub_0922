// ===== CostHub 数据访问层（v2.3.19 可维护性重构）=====
// 已按业务域拆分到 src/db/ 目录，本文件仅为聚合导出，页面 import 路径不变
// 重新生成：node _tools/split-db.mjs <项目根>
export * from './db/core';
export * from './db/auth';
export * from './db/parts';
export * from './db/suppliers';
export * from './db/projects';
export * from './db/competitors';
export * from './db/compare';
export * from './db/trend';
export * from './db/settings';
export * from './db/worklog';
export * from './db/dashboard';
export * from './db/think';
export * from './db/goals';
export * from './db/memory';
export * from './db/voice';
