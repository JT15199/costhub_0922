import { describe, expect, it } from 'vitest';
import { supplierLocationFromProfile } from '../components/supplierLocation';

describe('supplierLocationFromProfile', () => {
  it('maps explicit coordinates as exact', () => {
    expect(supplierLocationFromProfile({ province: '广东省', city: '深圳市', longitude: 114.05, latitude: 22.55 })).toMatchObject({
      longitude: 114.05, latitude: 22.55, precision: 'exact', city: '深圳市',
    });
  });

  it('resolves province and city fields to a map region', () => {
    const location = supplierLocationFromProfile({ province: '广东省', city: '深圳市' });
    expect(location).toMatchObject({ province: '广东', city: '深圳市', precision: 'region' });
    expect(location!.longitude).toBeGreaterThan(73);
    expect(location!.longitude).toBeLessThan(136);
    expect(location!.latitude).toBeGreaterThan(3);
    expect(location!.latitude).toBeLessThan(54);
  });

  it('infers province and city from a free-form address', () => {
    const location = supplierLocationFromProfile({ address: '广东省深圳市南山区科技园' });
    expect(location).toMatchObject({ province: '广东', precision: 'region' });
    expect(location!.longitude).toBeGreaterThan(73);
  });

  it('falls back to province center when city is missing', () => {
    const location = supplierLocationFromProfile({ province: '浙江省' });
    expect(location).toMatchObject({ province: '浙江', precision: 'region' });
    expect(location!.longitude).toBeGreaterThan(115);
  });
});
