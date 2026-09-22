import { describe, expect, it } from 'vitest';
import { summarizePartSupplierCoverage } from '../pages/SupplierManagement';

describe('供应商有效来源口径', () => {
  it('用同一器件全集区分无来源、单一来源和多来源', () => {
    const result = summarizePartSupplierCoverage(
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      [
        { part_id: 1, supplier_name: 'A', price: 10, share_ratio: 1, is_active: 1, remark: '' },
        { part_id: 2, supplier_name: 'A', price: 10, share_ratio: 0.6, is_active: 1, remark: '' },
        { part_id: 2, supplier_name: 'B', price: 11, share_ratio: 0.4, is_active: 1, remark: '' },
        { part_id: 3, supplier_name: '停用', price: 10, share_ratio: 1, is_active: 0, remark: '' },
        { part_id: 4, supplier_name: '', price: 10, share_ratio: 1, is_active: 1, remark: '' },
      ],
    );
    expect(result).toMatchObject({ relationCount: 3, coveredPartCount: 2, noSourcePartCount: 2, singleSourcePartCount: 1, multiSourcePartCount: 1 });
  });
});
