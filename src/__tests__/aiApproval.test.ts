import { describe, expect, it } from 'vitest';
import { approvalPayloadHash } from '../db/ai';

describe('云端授权 payload 哈希', () => {
  it('保持与 Rust 网关的规范键序一致', async () => {
    await expect(approvalPayloadHash({
      material: '铜',
      category: '原材料',
      question: '云端服务连接测试，不包含任何本地数据',
    })).resolves.toBe('0fd3a1a40bf10483cce1513062df00f7db7f53742628959ae94c2a87442df401');
  });
});
