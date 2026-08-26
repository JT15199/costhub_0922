import { describe, it, expect } from 'vitest';
import { detectSheetType } from './sheetType';

describe('detectSheetType', () => {
  it('识别 BOM 表（型号+数量+单价）', () => {
    expect(detectSheetType(['器件名称', '型号', '数量', '单价'], []).type).toBe('bom');
  });
  it('识别原声表（评价/评论列）', () => {
    expect(detectSheetType(['用户名', '评价', '时间'], []).type).toBe('voice');
  });
  it('识别供应商报价表', () => {
    expect(detectSheetType(['器件', '供应商', '价格'], []).type).toBe('supplier');
  });
  it('识别竞品表', () => {
    expect(detectSheetType(['品牌', '型号', '售价'], []).type).toBe('competitor');
  });
  it('未知表头归通用', () => {
    expect(detectSheetType(['a', 'b', 'c'], []).type).toBe('other');
  });
});
