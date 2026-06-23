import { seedTestData } from './seedTestData';

// 运行测试数据生成
seedTestData().then(() => {
  console.log('数据生成完成！');
}).catch(err => {
  console.error('数据生成失败:', err);
});