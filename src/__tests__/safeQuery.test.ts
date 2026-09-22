import { expect, it } from 'vitest';
import { canForceSend, reviewQuery, suggestSafeQuery } from '../ai/safeQuery';

it('只含公开信息的查询不命中任何规则，可以直接审批', () => {
  const review = reviewQuery({ material: '驱动板', category: '显示器', question: '近 1-3 月公开市场价格趋势' });
  expect(review.ok).toBe(true);
  expect(review.items).toEqual([]);
  expect(canForceSend(review)).toBe(false);
});

it('金额与成本数字属于硬命中：不可强制发送，只能改名', () => {
  const review = reviewQuery({ material: '驱动板', category: '显示器', question: '单价 ¥128.5 是否偏高' });
  expect(review.hardCount).toBeGreaterThan(0);
  expect(review.items.some(item => item.rule === '金额（¥/￥）')).toBe(true);
  expect(canForceSend(review)).toBe(false);
  expect(review.verdict).toContain('不可外发');
});

it('供应商公司名与项目短码属于硬命中', () => {
  const company = reviewQuery({ material: '深圳市蓝天科技有限公司 驱动板', category: '', question: '' });
  expect(company.items.some(item => item.rule === '公司/厂家名称' && item.level === 'hard')).toBe(true);
  const code = reviewQuery({ material: 'M270 驱动板', category: '', question: '' });
  expect(code.items.some(item => item.rule.includes('项目/产品短码'))).toBe(true);
});

it('器件型号与规格属于软命中：可看清命中内容后强制批准', () => {
  const review = reviewQuery({ material: 'Scaler IC SC8562', category: '显示器', question: '近 1-3 月公开市场价格趋势' });
  expect(review.hardCount).toBe(0);
  expect(review.softCount).toBeGreaterThan(0);
  expect(canForceSend(review)).toBe(true);
  expect(review.verdict).toContain('可发送但需确认');
});

it('公开标准词（USB3 / BT5）不会被误判为项目短码', () => {
  const review = reviewQuery({ material: 'USB3 连接器', category: '互连', question: '公开报价趋势' });
  expect(review.items.some(item => item.rule.includes('项目/产品短码'))).toBe(false);
});

it('模型原生搜索模式不再拦型号与规格，但仍然拦金额与项目信息', () => {
  const model = reviewQuery({ material: 'SC8562', category: '公开型号', question: '公开规格与替代料' }, { allowModel: true });
  expect(model.ok).toBe(true);
  const money = reviewQuery({ material: 'SC8562', category: '公开型号', question: '成本 ¥12 对比' }, { allowModel: true });
  expect(money.hardCount).toBeGreaterThan(0);
});

it('脱敏替代名去掉型号与金额，保留可检索的通用名', () => {
  const suggestion = suggestSafeQuery({ material: 'Scaler IC SC8562', category: '显示器', question: '近期价格' });
  expect(suggestion.material).toBe('Scaler IC');
  expect(suggestion.changes.join('；')).toContain('型号/规格');
  expect(reviewQuery(suggestion).hardCount).toBe(0);
});

it('物料名只剩公司名时退回品类通用词', () => {
  const suggestion = suggestSafeQuery({ material: '深圳市蓝天科技有限公司', category: '鼠标', question: '' });
  expect(suggestion.material).toBe('鼠标');
  expect(suggestion.changes.join('；')).toContain('通用词');
});

it('查询问题含本地数字时换成公开口径', () => {
  const suggestion = suggestSafeQuery({ material: '驱动板', category: '显示器', question: '我们采购价 ¥128 合理吗' });
  expect(suggestion.question).toBe('近 1-3 月公开市场价格趋势');
  expect(suggestion.changes.join('；')).toContain('公开口径');
});

it('脱敏后的方案本身必须通过评审（方案可用性自检）', () => {
  const suggestion = suggestSafeQuery({ material: 'M270 驱动板 ¥88.5', category: '显示器', question: '成本 88.5 元是否偏高' });
  const review = reviewQuery(suggestion);
  expect(review.hardCount).toBe(0);
  expect(suggestion.material).not.toContain('¥');
  expect(suggestion.material).not.toMatch(/M270/);
});
