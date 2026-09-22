import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Spin } from 'antd';
import { EnvironmentOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import chinaProvinceGeoJson from '../data/china_province_full.geojson?raw';
import type { SupplierLocation } from './supplierLocation';

type Coordinate = [number, number];

type GeoGeometry =
  | { type: 'Polygon'; coordinates: Coordinate[][] }
  | { type: 'MultiPolygon'; coordinates: Coordinate[][][] };

type GeoFeature = {
  properties?: { name?: string; fullname?: string; center?: Coordinate; centroid?: Coordinate; code?: string | number; adcode?: string | number; level?: number | string };
  geometry: GeoGeometry;
};

type GeoJson = { features: GeoFeature[] };

export type SupplierMapPoint = {
  id: string;
  supplierName: string;
  siteId?: number;
  siteName?: string;
  address?: string;
  partCount: number;
  location: SupplierLocation | null;
};

interface ChinaSupplierMapProps {
  suppliers: SupplierMapPoint[];
  countLabel?: string;
  selectedSupplier?: string;
  onSelect: (supplierName: string, siteId?: number) => void;
  onEditLocation?: (supplierName: string, siteId?: number) => void;
}

const WIDTH = 760;
const HEIGHT = 430;
const CITY_SCALE = 3.5;

// Albers 等积圆锥投影：比经纬度矩形投影更适合中国东西跨度大的区域地图。
const DEG = Math.PI / 180;
const PHI_1 = 25 * DEG;
const PHI_2 = 47 * DEG;
const LAMBDA_0 = 105 * DEG;
const N = (Math.sin(PHI_1) + Math.sin(PHI_2)) / 2;
const C = Math.cos(PHI_1) ** 2 + 2 * N * Math.sin(PHI_1);
const RHO_0 = Math.sqrt(C) / N;

function projectedPoint([longitude, latitude]: Coordinate): Coordinate {
  const phi = Math.max(-89, Math.min(89, latitude)) * DEG;
  const rho = Math.sqrt(Math.max(0, C - 2 * N * Math.sin(phi))) / N;
  const theta = N * (longitude * DEG - LAMBDA_0);
  return [rho * Math.sin(theta), RHO_0 - rho * Math.cos(theta)];
}

function featurePoints(feature: GeoFeature): Coordinate[] {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.flatMap(polygon => polygon.flatMap(ring => ring));
}

function createFrame(features: GeoFeature[]) {
  const points = features.flatMap(feature => featurePoints(feature).map(projectedPoint));
  if (!points.length) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padding = 24;
  const scale = Math.min((WIDTH - padding * 2) / (maxX - minX), (HEIGHT - padding * 2) / (maxY - minY));
  return {
    project(point: Coordinate): Coordinate {
      const [x, y] = projectedPoint(point);
      return [WIDTH / 2 + (x - (minX + maxX) / 2) * scale, HEIGHT / 2 - (y - (minY + maxY) / 2) * scale];
    },
  };
}

function geometryPath(geometry: GeoGeometry, project: (value: Coordinate) => Coordinate) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap(polygon => polygon.map(ring => {
    let last: Coordinate | undefined;
    const points: string[] = [];
    ring.forEach((point, index) => {
      const xy = project(point);
      // Subpixel simplification: at maximum 8x zoom the error stays under 1.2 SVG pixels.
      if (!last || index === ring.length - 1 || Math.hypot(xy[0]-last[0],xy[1]-last[1]) >= .15) {
        points.push(`${xy[0].toFixed(2)},${xy[1].toFixed(2)}`); last = xy;
      }
    });
    return `M ${points.join(' L ')} Z`;
  })).join(' ');
}

function prepareFeatures(features: GeoFeature[], project: (value: Coordinate) => Coordinate) {
  return features.map(feature => {
    const bounds = featurePoints(feature).reduce((box, point) => { const [x,y]=project(point); return [Math.min(box[0],x),Math.min(box[1],y),Math.max(box[2],x),Math.max(box[3],y)]; }, [Infinity,Infinity,-Infinity,-Infinity]);
    return { feature, name:featureName(feature), bounds, center:project(featureCenter(feature)), path:geometryPath(feature.geometry,project) };
  });
}

function featureName(feature: GeoFeature) {
  return feature.properties?.fullname || feature.properties?.name || '未命名区域';
}

function featureCenter(feature: GeoFeature): Coordinate {
  const center = feature.properties?.center || feature.properties?.centroid;
  if (center && Number.isFinite(center[0]) && Number.isFinite(center[1])) return center;
  return featurePoints(feature)[0] || [105, 35];
}

type SupplierMarkerCluster = {
  id: string;
  items: SupplierMapPoint[];
  x: number;
  y: number;
  totalPartCount: number;
};

function mapScreenPoint(point: Coordinate, project: (value: Coordinate) => Coordinate, scale: number, pan: Coordinate) {
  const [x, y] = project(point);
  return [WIDTH / 2 + pan[0] + scale * (x - WIDTH / 2), HEIGHT / 2 + pan[1] + scale * (y - HEIGHT / 2)] as Coordinate;
}

function clusterSupplierMarkers(
  suppliers: SupplierMapPoint[],
  project: (value: Coordinate) => Coordinate,
  scale: number,
  pan: Coordinate,
): SupplierMarkerCluster[] {
  const clusters: SupplierMarkerCluster[] = [];
  const threshold = 42;
  suppliers.filter(item => item.location).forEach(item => {
    const [x, y] = mapScreenPoint([item.location!.longitude, item.location!.latitude], project, scale, pan);
    const cluster = clusters.find(candidate => Math.hypot(candidate.x - x, candidate.y - y) <= threshold);
    if (!cluster) {
      clusters.push({ id: item.id, items: [item], x, y, totalPartCount: item.partCount });
      return;
    }
    const count = cluster.items.length;
    cluster.items.push(item);
    cluster.x = (cluster.x * count + x) / (count + 1);
    cluster.y = (cluster.y * count + y) / (count + 1);
    cluster.totalPartCount += item.partCount;
  });
  return clusters.map(cluster => ({ ...cluster, id: cluster.items.map(item => item.id).sort().join('|') }));
}

function shortenSupplierName(name: string) {
  return name.length > 12 ? `${name.slice(0, 12)}…` : name;
}

export default function ChinaSupplierMap({ suppliers, selectedSupplier, onSelect, onEditLocation, countLabel = '器件' }: ChinaSupplierMapProps) {
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [cityFeatures, setCityFeatures] = useState<GeoFeature[]>([]);
  const [mapError, setMapError] = useState(false);
  const [view, setView] = useState({scale:1,pan:[0,0] as Coordinate});
  const {scale,pan} = view;
  const camera = useRef(view);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const [selectedProvince, setSelectedProvince] = useState('');
  const [activeClusterId, setActiveClusterId] = useState('');
  const drag = useRef<{ x: number; y: number; pan: Coordinate } | null>(null);
  const wheelFrame = useRef<number | null>(null);

  const frame = useMemo(() => createFrame(features), [features]);

  useEffect(() => {
    try {
      const provinces = JSON.parse(chinaProvinceGeoJson) as GeoJson;

      setFeatures(provinces.features || []);

    } catch {
      setMapError(true);
    }
  }, []);

  useEffect(() => {
    if (scale < CITY_SCALE || cityFeatures.length) return;
    let cancelled = false;
    import('../data/china_city_full.geojson?raw').then(module => {
      if (!cancelled) setCityFeatures(((JSON.parse(module.default) as GeoJson).features || []).filter(feature => String(feature.properties?.level) !== '3'));
    }).catch(() => { if (!cancelled) setMapError(true); });
    return () => { cancelled = true; };
  }, [scale >= CITY_SCALE, cityFeatures.length]);
  const provinces = useMemo(() => frame ? prepareFeatures(features,frame.project) : [], [features,frame]);
  const cities = useMemo(() => frame ? prepareFeatures(cityFeatures,frame.project) : [], [cityFeatures,frame]);
  const screen = ([x,y]:Coordinate):Coordinate => [WIDTH/2+pan[0]+scale*(x-WIDTH/2),HEIGHT/2+pan[1]+scale*(y-HEIGHT/2)];
  const visibleCities = scale >= CITY_SCALE ? cities.filter(item => {
    const [left,top]=screen([item.bounds[0],item.bounds[1]]), [right,bottom]=screen([item.bounds[2],item.bounds[3]]);
    return right >= 0 && left <= WIDTH && bottom >= 0 && top <= HEIGHT;
  }) : [];
  const markers = suppliers.filter(item => item.location);
  const unlocatedCount = suppliers.length - markers.length;
  const mapTransform = `translate(${WIDTH / 2 + pan[0]} ${HEIGHT / 2 + pan[1]}) scale(${scale}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`;
  const clusters = frame ? clusterSupplierMarkers(suppliers, frame.project, scale, pan) : [];
  const activeCluster = clusters.find(cluster => cluster.id === activeClusterId);
  const scheduleView = (next: typeof view) => {
    camera.current = next;
    if (wheelFrame.current !== null) return;
    wheelFrame.current = requestAnimationFrame(() => { wheelFrame.current = null; setView(camera.current); });
  };
  const clientPoint = (x:number,y:number):Coordinate => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return [WIDTH/2,HEIGHT/2];
    const point = new DOMPoint(x,y).matrixTransform(matrix.inverse());
    return [point.x,point.y];
  };
  const zoom = (factor:number, anchor:Coordinate = [WIDTH/2,HEIGHT/2]) => {
    const current=camera.current;
    const nextScale=Math.max(.8,Math.min(8,current.scale*factor));
    const ratio=nextScale/current.scale;
    scheduleView({scale:nextScale,pan:[anchor[0]-WIDTH/2-ratio*(anchor[0]-WIDTH/2-current.pan[0]),anchor[1]-HEIGHT/2-ratio*(anchor[1]-HEIGHT/2-current.pan[1])]});
  };
  useEffect(() => {
    const viewport=viewportRef.current;
    const wheel=(event:WheelEvent) => {
      event.preventDefault();
      const delta=event.deltaY*(event.deltaMode===1 ? 16 : event.deltaMode===2 ? HEIGHT : 1);
      zoom(Math.exp(-Math.max(-160,Math.min(160,delta))*.002),clientPoint(event.clientX,event.clientY));
    };
    viewport?.addEventListener('wheel',wheel,{passive:false});
    return () => { viewport?.removeEventListener('wheel',wheel); if(wheelFrame.current!==null)cancelAnimationFrame(wheelFrame.current); };
  }, []);
  const reset = () => { scheduleView({scale:1,pan:[0,0]}); setSelectedProvince(''); setActiveClusterId(''); };
  const focusProvince = (feature:GeoFeature) => {
    if (moved.current) return;
    const item=provinces.find(item=>item.feature===feature);
    if (!item) return;
    const [minX,minY,maxX,maxY]=item.bounds;
    const nextScale=Math.max(1.8,Math.min(8,Math.min(WIDTH*.78/Math.max(1,maxX-minX),HEIGHT*.78/Math.max(1,maxY-minY))));
    scheduleView({scale:nextScale,pan:[nextScale*(WIDTH/2-(minX+maxX)/2),nextScale*(HEIGHT/2-(minY+maxY)/2)]});
    setSelectedProvince(item.name);
  };
  const occupied = clusters.map(c=>({x:c.x-18,y:c.y-16,w:130,h:40}));
  const labelFeatures = scale >= CITY_SCALE ? [...visibleCities, ...provinces.filter(item => /^(11|12|31|50|71|81|82)/.test(String(item.feature.properties?.adcode)))] : provinces;
  const labels = labelFeatures.flatMap(item => {
    const [x,y]=screen(item.center);
    const name=item.name.replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省$/g,'');
    const w=name.length*10+10,h=18;
    const box={x:x-w/2,y:y-h/2,w,h};
    if(box.x<3 || box.y<3 || box.x+w>WIDTH-3 || box.y+h>HEIGHT-3 || occupied.some(b=>box.x<b.x+b.w && box.x+w>b.x && box.y<b.y+b.h && box.y+h>b.y))return [];
    occupied.push(box);
    return [{name,x,y}];
  });

  return (
    <div className="supplier-map-card">
      <div className="supplier-map-card-head">
        <div>
          <div className="supplier-map-title"><EnvironmentOutlined /> 供应商地域分布</div>
          <div className="supplier-map-copy">点击圆点查看厂家地点；同区域厂家自动聚合；滚轮逐级查看省份与城市</div>
        </div>
        <div className="supplier-map-legend"><span><i className="supplier-map-dot" />供应商</span><span><i className="supplier-map-dot is-selected" />当前选中</span></div>
      </div>

      <div ref={viewportRef} className="supplier-map-viewport" data-map-level={scale >= CITY_SCALE ? 'city' : 'province'}>
        {mapError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="地图数据解析失败，请重新安装应用" /> : !frame ? <div className="supplier-map-loading"><Spin size="small" /> 加载中国省级边界…</div> : (
          <svg ref={svgRef} className="supplier-map-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="中国省级供应商分布图"
            onPointerDown={event => {
              if ((event.target as Element).closest('.supplier-map-marker')) return;
              setActiveClusterId('');
              if (event.button !== 0) return;
              moved.current=false;
              const [x,y]=clientPoint(event.clientX,event.clientY);
              drag.current = { x, y, pan:camera.current.pan };
            }}
            onPointerMove={event => {
              if (!drag.current) return;
              const [x,y]=clientPoint(event.clientX,event.clientY);
              const dx=x-drag.current.x,dy=y-drag.current.y;
              if (Math.hypot(dx,dy)>3) { moved.current=true; event.currentTarget.setPointerCapture(event.pointerId); }
              if (moved.current) scheduleView({scale:camera.current.scale,pan:[drag.current.pan[0]+dx,drag.current.pan[1]+dy]});
            }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
            <g transform={mapTransform}>
              {provinces.map(({feature,name,path}) => {
                const selected = name === selectedProvince;
                return <path key={name} className={`supplier-map-province${selected ? ' is-selected' : ''}`} d={path} tabIndex={0} role="button" aria-label={name}
                  onClick={() => focusProvince(feature)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); moved.current=false; focusProvince(feature); } }}><title>{name} · 放大查看城市</title></path>;
              })}
              {visibleCities.map(item => <path key={`city-${item.name}`} className="supplier-map-city" d={item.path} pointerEvents="none" />)}
            </g>
              {labels.map(label => <text key={label.name} className={scale >= CITY_SCALE ? 'supplier-map-city-label' : 'supplier-map-label'} textAnchor="middle" x={label.x} y={label.y}>{label.name}</text>)}
              {clusters.map(cluster => {
                const selected = cluster.items.some(item => item.supplierName === selectedSupplier);
                const grouped = cluster.items.length > 1;
                const radius = Math.max(8, Math.min(15, 7 + Math.sqrt(cluster.totalPartCount) * 1.1));
                const location = cluster.items[0].location!;
                const label = grouped ? `${cluster.items.length} 个厂家` : shortenSupplierName(cluster.items[0].siteName ? `${cluster.items[0].supplierName} · ${cluster.items[0].siteName}` : cluster.items[0].supplierName);
                const city = grouped ? `${location.city}${cluster.items.every(item => item.location?.city === location.city) ? '' : '等'} · 点击展开` : `${location.city}${location.precision === 'region' ? ' · 区域级' : ''}`;
                const [x, y] = [cluster.x,cluster.y];
                const activate = () => grouped ? setActiveClusterId(cluster.id) : onSelect(cluster.items[0].supplierName, cluster.items[0].siteId);
                return <g key={cluster.id} className={`supplier-map-marker${selected ? ' is-selected' : ''}${grouped ? ' is-cluster' : ''}`} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`} tabIndex={0} role="button" aria-label={grouped ? `${label}，${city}` : `${cluster.items[0].supplierName}，${location.city}，覆盖 ${cluster.items[0].partCount} 个${countLabel}`} onClick={activate} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }}>
                  <circle className="supplier-map-marker-halo" r={radius + 6} />
                  <circle className="supplier-map-marker-core" r={radius} />
                  {grouped && <text className="supplier-map-marker-count" textAnchor="middle" y="4">{cluster.items.length}</text>}
                  <text className="supplier-map-marker-name" x={radius + 6} y="4">{label}</text>
                  <text className="supplier-map-marker-city" x={radius + 6} y="18">{city}</text>
                  <title>{grouped ? `${cluster.items.length} 家供应商 · ${cluster.totalPartCount} 个${countLabel}` : `${cluster.items[0].supplierName} · ${location.city} · ${cluster.items[0].partCount} 个${countLabel}`}</title>
                </g>;
              })}
          </svg>
        )}
        {activeCluster && (
          <div className="supplier-map-cluster-panel" style={{ left: `${Math.max(2, Math.min(70, (activeCluster.x / WIDTH) * 100 + 2))}%`, top: `${Math.max(3, Math.min(62, (activeCluster.y / HEIGHT) * 100 + 3))}%` }}>
            <div className="supplier-map-cluster-title">同区域 {activeCluster.items.length} 家供应商</div>
            <div className="supplier-map-cluster-copy">选择一家查看供应商信息</div>
            <div className="supplier-map-cluster-list">
              {activeCluster.items.map(item => <button type="button" key={item.id} onClick={() => { setActiveClusterId(''); onSelect(item.supplierName, item.siteId); }}><span>{item.supplierName} · {item.siteName || '厂家'}</span><small>{item.location?.city} · {item.partCount} 个{countLabel}</small></button>)}
            </div>
          </div>
        )}
        <div className="supplier-map-controls" aria-label="地图缩放控制">
          <button type="button" aria-label="放大地图" onClick={() => zoom(1.2)}><ZoomInOutlined /></button>
          <button type="button" aria-label="缩小地图" onClick={() => zoom(0.84)}><ZoomOutOutlined /></button>
          <button type="button" aria-label="重置地图视图" onClick={reset}><ReloadOutlined /></button>
        </div>
      </div>

      <div className="supplier-map-footer">
        <span>{scale >= CITY_SCALE ? '城市视图' : '省份视图'} · 已加载 {features.length || '—'} 个省级区域 · 含西藏、台湾、港澳 · 支持滚轮缩放与拖拽查看省内</span>
        {unlocatedCount > 0 && <span className="supplier-map-unlocated">{unlocatedCount} 个厂家地点待补充地址</span>}
      </div>
      {unlocatedCount > 0 && onEditLocation && (
        <div className="supplier-map-unlocated-list">
          <span>未定位供应商：</span>
          {suppliers.filter(item => !item.location).map(item => <Button key={item.id} type="link" size="small" onClick={() => onEditLocation?.(item.supplierName, item.siteId)}>{item.supplierName} · {item.siteName || '厂家'} · 维护地址</Button>)}
        </div>
      )}
      <div className="supplier-map-source">边界数据：省级 GeoJSON（MIT）· 优先读取厂家地址与经纬度；旧供应商档案仍兼容</div>
    </div>
  );
}
