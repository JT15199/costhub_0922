import { CHINA_CITY_LOCATIONS, CHINA_PROVINCE_CENTERS } from '../data/chinaLocationIndex';

export type SupplierLocation = {
  province?: string;
  city: string;
  longitude: number;
  latitude: number;
  precision: 'exact' | 'region';
};

const normalizeName = (value: unknown) => String(value || '')
  .trim()
  .replace(/(特别行政区|自治区|自治州|地区|盟|省|市|区|县)$/u, '');

const CITY_CENTERS = new Map<string, [number, number]>();
for (const record of CHINA_CITY_LOCATIONS) {
  const province = normalizeName(record.province);
  const city = normalizeName(record.city);
  if (province && city && !CITY_CENTERS.has(`${province}|${city}`)) {
    CITY_CENTERS.set(`${province}|${city}`, [record.longitude, record.latitude]);
  }
}

function findProvince(text: string): string {
  if (!text) return '';
  return Object.keys(CHINA_PROVINCE_CENTERS).find(province => province && text.includes(province)) || '';
}

function findCity(text: string, province: string): string {
  if (!text) return '';
  for (const record of CHINA_CITY_LOCATIONS) {
    const city = normalizeName(record.city);
    if (!city || !text.includes(city)) continue;
    if (!province || normalizeName(record.province) === province) return city;
  }
  return '';
}

function findAnyCityCenter(city: string): { province: string; center: [number, number] } | null {
  for (const record of CHINA_CITY_LOCATIONS) {
    if (normalizeName(record.city) === city) {
      return { province: normalizeName(record.province), center: [record.longitude, record.latitude] };
    }
  }
  return null;
}

export function supplierLocationFromProfile(profile: any): SupplierLocation | null {
  const longitude = Number(profile?.longitude);
  const latitude = Number(profile?.latitude);
  if (Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= 73 && longitude <= 136 && latitude >= 3 && latitude <= 54) {
    return { province: profile?.province || '', city: profile?.city || '已定位', longitude, latitude, precision: 'exact' };
  }

  const rawText = `${profile?.province || ''} ${profile?.city || ''} ${profile?.address || ''} ${profile?.remark || ''}`;
  const compact = rawText.replace(/\s+/g, '');
  let province = normalizeName(profile?.province) || findProvince(compact);
  let city = normalizeName(profile?.city) || findCity(compact, province);

  if (province && city) {
    const center = CITY_CENTERS.get(`${province}|${city}`);
    if (center) return { province, city: profile?.city || city, longitude: center[0], latitude: center[1], precision: 'region' };
  }
  if (!province && city) {
    const found = findAnyCityCenter(city);
    if (found) {
      province = found.province;
      return { province, city: profile?.city || city, longitude: found.center[0], latitude: found.center[1], precision: 'region' };
    }
  }
  if (!city && province) {
    const center = CHINA_PROVINCE_CENTERS[province];
    if (center) return { province, city: profile?.city || `${province}区域`, longitude: center[0], latitude: center[1], precision: 'region' };
  }

  const region = rawText.match(/华东|华南|华北|西南/gi)?.[0];
  const centers: Record<string, SupplierLocation> = {
    华东: { city: '华东区域中心', longitude: 121.4737, latitude: 31.2304, precision: 'region' },
    华南: { city: '华南区域中心', longitude: 113.2644, latitude: 23.1291, precision: 'region' },
    华北: { city: '华北区域中心', longitude: 116.4074, latitude: 39.9042, precision: 'region' },
    西南: { city: '西南区域中心', longitude: 104.0665, latitude: 30.5728, precision: 'region' },
  };
  return region ? { ...centers[region], province: '' } : null;
}
