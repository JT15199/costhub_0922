import SupplierResourcePool, { SupplierNameInput } from '../components/SupplierResourcePool';
import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { EmojiIcon } from '../iconMap';
import { Alert, Card, Button, Input, Select, Tag, Space, Modal, Form, message, Tabs, Row, Col, Statistic, Table, Popconfirm, Empty, InputNumber, Radio, Upload, Spin, Checkbox } from 'antd';
import { ShopOutlined, AppstoreOutlined, UnorderedListOutlined, EditOutlined, DeleteOutlined, HistoryOutlined, HomeOutlined, BuildOutlined, ToolOutlined, BarChartOutlined, SearchOutlined, CameraOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react/esm/core';
import echarts from '../echartsSetup';
import { getAllPartSuppliers, getParts, addPartSupplier, updatePartSupplier, deletePartSupplier, getSupplierPriceHistory, getProjects, getProjectSuppliers, getProjectSupplierPriceHistory, getSupplierProfiles, saveSupplierProfile, getSupplierSites, saveSupplierSite, deleteSupplierSite, getSupplierCategoryMap, getSupplierCategories } from '../db';
import { getCategoryColor } from '../constants';
import { CHART_COLORS, barGradient, chartAxisStyle, chartGrid, chartSplitLine, chartTextColor, chartTextMuted, chartTooltip } from '../chartTheme';
import DataTable from '../components/DataTable';
import SupplierProjectPanel from '../components/SupplierProjectPanel';
import { supplierLocationFromProfile } from '../components/supplierLocation';
import type { PartSupplier, ProjectSupplier } from '../types';

const ChinaSupplierMap = lazy(() => import('../components/ChinaSupplierMap'));

interface SupplierMapItem {
  supplierName: string;
  partCount: number;
  mainCategories: string[]; // 该供应商涉及的大类列表
  parts: Array<{
    partId: number;
    partName: string;
    partModel: string;
    mainCategory: string;
    subCategory: string;
    price: number;
    shareRatio: number;
    supplierId: number;
    supplierName: string;
  }>;
}

/** 供应商覆盖口径：同一份可见器件全集，只统计启用且有名称的有效关系。 */
export function summarizePartSupplierCoverage(parts: any[], relations: PartSupplier[]) {
  const partIds = new Set((parts || []).map(part => Number(part.id)).filter(Number.isFinite));
  const valid = (relations || []).filter(row => partIds.has(Number(row.part_id)) && row.is_active !== 0 && String(row.supplier_name || '').trim());
  const counts = new Map<number, number>();
  valid.forEach(row => counts.set(Number(row.part_id), (counts.get(Number(row.part_id)) || 0) + 1));
  const noSourcePartCount = (parts || []).filter(part => !counts.has(Number(part.id))).length;
  const singleSourcePartCount = (parts || []).filter(part => counts.get(Number(part.id)) === 1).length;
  return { valid, relationCount: valid.length, coveredPartCount: counts.size, noSourcePartCount, singleSourcePartCount, multiSourcePartCount: Math.max(0, counts.size - singleSourcePartCount) };
}

export default function SupplierManagement() {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [supplierType, setSupplierType] = useState<'part' | 'project'>('part'); // 器件供应商 or 整机供应商

  // 筛选条件
  const [mainCatFilter, setMainCatFilter] = useState('');
  const [subCatFilter, setSubCatFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [searchText, setSearchText] = useState('');

  // 器件供应商数据
  const [supplierMap, setSupplierMap] = useState<SupplierMapItem[]>([]);
  // 供应商档案（含Logo）
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [supplierSites, setSupplierSites] = useState<Record<string, any[]>>({});
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [profileTarget, setProfileTarget] = useState<string | null>(null);
  const [profileSiteId, setProfileSiteId] = useState<number | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [allSuppliers, setAllSuppliers] = useState<PartSupplier[]>([]);
  const [allParts, setAllParts] = useState<any[]>([]);
  const [mainCategories, setMainCategories] = useState<string[]>([]);
  const [subCategories, setSubCategories] = useState<string[]>([]);
  // 子类 → 大类 映射（用于筛选联动：选了大类后子类只显示该大类下的）
  const [subCatToMain, setSubCatToMain] = useState<Record<string, string>>({});
  // 按大类过滤后的子类选项
  const filteredSubCats = useMemo(() => {
    if (!mainCatFilter) return subCategories;
    return subCategories.filter(c => subCatToMain[c] === mainCatFilter);
  }, [mainCatFilter, subCategories, subCatToMain]);

  // 整机供应商数据
  const [projectSuppliers, setProjectSuppliers] = useState<ProjectSupplier[]>([]);
  const [allProjects, setAllProjects] = useState<any[]>([]);

  // 详情弹窗
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierMapItem | null>(null);

  // 关系编辑
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingRelation, setEditingRelation] = useState<PartSupplier | null>(null);
  const [form] = Form.useForm();
  const [profileForm] = Form.useForm();

  // 价格历史
  const [priceHistoryOpen, setPriceHistoryOpen] = useState(false);
  const [priceHistory, setPriceHistory] = useState<any[]>([]);

  // 供应商对比选择
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  // 供应商品类（用户可自定义，2026-09-21）：品类字典 + 供应商↔品类映射 + 地图品类筛选 + 项目情况弹窗
  const [categoryMap, setCategoryMap] = useState<Record<string, string[]>>({});
  const [categoryDict, setCategoryDict] = useState<string[]>([]);
  const [mapCategoryFilter, setMapCategoryFilter] = useState('');
  const [overviewSupplier, setOverviewSupplier] = useState('');

  useEffect(() => {
    loadData();
  }, [supplierType]);

  // AI 数据工程联动：切回页面或资源池档案发生变化时自动刷新。
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.page === 'supplierManagement') { loadData(); } };
    const onSuppliersChanged = () => { void loadData(); };
    window.addEventListener('app-page-active', h);
    window.addEventListener('costhub-suppliers-changed', onSuppliersChanged);
    return () => {
      window.removeEventListener('app-page-active', h);
      window.removeEventListener('costhub-suppliers-changed', onSuppliersChanged);
    };
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
        // 加载供应商档案（Logo等）
        try {
          const profs = await getSupplierProfiles();
          const pmap: Record<string, any> = {};
          profs.forEach((p: any) => { pmap[p.supplier_name] = p; });
          setProfiles(pmap);
          const sites = await getSupplierSites();
          const smap: Record<string, any[]> = {};
          sites.forEach((site: any) => { (smap[site.supplier_name] ||= []).push(site); });
          setSupplierSites(smap);
          setCategoryMap(await getSupplierCategoryMap());
          setCategoryDict(await getSupplierCategories());
        } catch (e) { console.error('加载供应商档案失败:', e); }
      if (supplierType === 'part') {
        // 加载器件供应商数据
                const suppliers = await getAllPartSuppliers();
        
        const parts = await getParts('', '', '');
        
        setAllSuppliers(suppliers);
        setAllParts(parts);

        // 提取大类和子类（子类记录所属大类，用于筛选联动）
        const mainCats = Array.from(new Set(parts.map((p: any) => p.main_category).filter(Boolean)));
        const subCatMap: Record<string, string> = {}; // 子类 → 大类
        parts.forEach((p: any) => {
          if (p.sub_category && p.main_category) {
            if (!subCatMap[p.sub_category]) subCatMap[p.sub_category] = p.main_category;
          }
        });
        setSubCatToMain(subCatMap);
        const subCats = Array.from(new Set(parts.map((p: any) => p.sub_category).filter(Boolean)));
        setMainCategories(mainCats);
        setSubCategories(subCats);

        // 构建供应商地图
        buildSupplierMap(suppliers, parts);
      } else {
        // 加载整机供应商数据
                const projects = await getProjects();
                setAllProjects(projects);

        // 获取所有整机供应商
        const allProjectSuppliers: ProjectSupplier[] = [];
        for (const project of projects) {
          const suppliers = await getProjectSuppliers(project.id!);
          allProjectSuppliers.push(...suppliers);
        }
                setProjectSuppliers(allProjectSuppliers);
      }
    } catch (e) {
      console.error('Error loading supplier data:', e);
      message.error(`加载数据失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const buildSupplierMap = (suppliers: PartSupplier[], parts: any[]) => {
    const map: Record<string, SupplierMapItem> = {};

    suppliers.forEach(s => {
      const supplierName = String(s.supplier_name || '').trim();
      if (s.is_active === 0 || !supplierName) return;
      const part = parts.find(p => p.id === s.part_id);
      if (!part) return;

      if (!map[supplierName]) {
        map[supplierName] = {
          supplierName,
          partCount: 0,
          mainCategories: [],
          parts: []
        };
      }

      map[supplierName].partCount++;

      // 记录涉及的大类（去重）
      if (!map[supplierName].mainCategories.includes(part.main_category)) {
        map[supplierName].mainCategories.push(part.main_category);
      }

      map[supplierName].parts.push({
        partId: part.id,
        partName: part.name,
        partModel: part.model || '',
        mainCategory: part.main_category,
        subCategory: part.sub_category || '',
        price: s.price || 0,
        shareRatio: s.share_ratio || 0,
        supplierId: s.id!,
        supplierName
      });
    });

    setSupplierMap(Object.values(map));
  };

  // 筛选后的数据
  const filteredSupplierMap = supplierMap.map(supplier => {
    const filteredParts = supplier.parts.filter(part => {
      if (mainCatFilter && part.mainCategory !== mainCatFilter) return false;
      if (subCatFilter && part.subCategory !== subCatFilter) return false;
      if (searchText && !part.partName.toLowerCase().includes(searchText.toLowerCase())) return false;
      return true;
    });

    return { ...supplier, parts: filteredParts, partCount: filteredParts.length };
  }).filter(supplier => {
    if (supplierFilter && supplier.supplierName !== supplierFilter) return false;
    if (supplier.partCount === 0) return false;
    return true;
  });

  // 供应商品类筛选：与"器件大类"筛选相互独立，只看供应商资料里标注的品类。
  const categoryMatchedSupplierMap = filteredSupplierMap.filter(supplier => !mapCategoryFilter || (categoryMap[supplier.supplierName] || []).includes(mapCategoryFilter));

  // 查看供应商详情
  const showSupplierDetail = (supplier: SupplierMapItem) => {
    setOverviewSupplier('');
    setSelectedSupplier(supplier);
    setDetailModalOpen(true);
  };

  /** 地图/资源池点击供应商：直接看它的供应项目情况（器件与整机两种视图共用）。 */
  const showSupplierOverview = (supplierName: string) => {
    const supplier = supplierType === 'part' ? filteredSupplierMap.find(item => item.supplierName === supplierName) : undefined;
    if (supplier) { showSupplierDetail(supplier); return; }
    setSelectedSupplier(null);
    setOverviewSupplier(supplierName);
    setDetailModalOpen(true);
  };

  const openProfileModal = (supplierName: string, siteId?: number) => {
    const profile = profiles[supplierName] || {};
    const sites = supplierSites[supplierName] || [];
    const site = sites.find(item => Number(item.id) === Number(siteId)) || sites.find(item => Number(item.is_primary) === 1) || sites[0];
    setProfileTarget(supplierName);
    setProfileSiteId(site?.id || null);
    profileForm.setFieldsValue({
      site_name: site?.site_name || '总部 / 主厂',
      address: site?.address || profile.address || '',
      province: site?.province || profile.province || '',
      city: site?.city || profile.city || '',
      longitude: site?.longitude || profile.longitude || undefined,
      latitude: site?.latitude || profile.latitude || undefined,
      contact: site?.contact || profile.contact || '',
      phone: site?.phone || profile.phone || '',
      is_primary: site ? Number(site.is_primary) === 1 : true,
    });
    setProfileModalOpen(true);
  };

  const addSupplierSiteForm = () => {
    if (!profileTarget) return;
    setProfileSiteId(null);
    profileForm.resetFields();
    profileForm.setFieldsValue({ site_name: '新厂家', is_primary: false });
  };

  const saveProfileLocation = async () => {
    if (!profileTarget) return;
    try {
      const values = await profileForm.validateFields();
      await saveSupplierSite({ supplier_name: profileTarget, id: profileSiteId || undefined, ...values });
      message.success(profileSiteId ? '厂家地址已更新' : '厂家地址已新增');
      setProfileModalOpen(false);
      await loadData();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.message || '保存供应商位置失败');
    }
  };

  // 打开编辑弹窗
  const openEditModal = (relation?: PartSupplier) => {
    if (relation) {
      setEditingRelation(relation);
      form.setFieldsValue({
        part_id: relation.part_id,
        supplier_name: relation.supplier_name,
        price: relation.price,
        share_ratio: relation.share_ratio,
        is_active: relation.is_active
      });
    } else {
      setEditingRelation(null);
      form.resetFields();
    }
    setEditModalOpen(true);
  };

  // 保存供应商关系
  const saveRelation = async () => {
    try {
      const values = await form.validateFields();

      if (editingRelation) {
        // 更新
        await updatePartSupplier({ ...values, id: editingRelation.id });
        message.success('已更新');
      } else {
        // 新增
        await addPartSupplier(values);
        message.success('已添加');
      }

      setEditModalOpen(false);
      loadData();
    } catch (e: any) {
      console.error(e);
      message.error(e.message || '保存失败');
    }
  };

  // 删除供应商关系
  const deleteRelation = async (id: number) => {
    try {
      await deletePartSupplier(id);
      message.success('已删除');
      loadData();
    } catch (e) {
      console.error(e);
      message.error('删除失败');
    }
  };

  // 查看价格历史
  const showPriceHistory = async (partId: number, supplierName: string) => {
    try {
      const history = await getSupplierPriceHistory(partId, supplierName);
      setPriceHistory(history);
      setPriceHistoryOpen(true);
    } catch (e) {
      console.error(e);
      message.error('加载价格历史失败');
    }
  };

  // 查看整机供应商（ODM）报价历史
  const showProjectPriceHistory = async (supplierId: number) => {
    try {
      const history = await getProjectSupplierPriceHistory(supplierId);
      setPriceHistory(history);
      setPriceHistoryOpen(true);
    } catch (e) {
      console.error(e);
      message.error('加载报价历史失败');
    }
  };

  // 详细列表表格数据
  const detailListData = allSuppliers
    .map(s => {
      const part = allParts.find(p => p.id === s.part_id);
      if (!part) return null;

      if (mainCatFilter && part.main_category !== mainCatFilter) return null;
      if (subCatFilter && part.sub_category !== subCatFilter) return null;
      if (supplierFilter && s.supplier_name !== supplierFilter) return null;
      if (searchText && !part.name.toLowerCase().includes(searchText.toLowerCase())) return null;

      return {
        id: s.id,
        partId: part.id,
        mainCategory: part.main_category,
        subCategory: part.sub_category || '-',
        partName: part.name,
        partModel: part.model || '-',
        supplierName: s.supplier_name,
        price: s.price,
        shareRatio: s.share_ratio,
        isActive: s.is_active,
        supplierId: s.id
      };
    })
    .filter(Boolean);

  // 整机供应商列表数据
  const projectSupplierListData = projectSuppliers
    .map(s => {
      const project = allProjects.find(p => p.id === s.project_id);
      if (!project) return null;

      if (supplierFilter && s.supplier_name !== supplierFilter) return null;
      if (searchText && !project.name.toLowerCase().includes(searchText.toLowerCase())) return null;

      return {
        id: s.id,
        projectCode: project.code,
        projectName: project.name,
        supplierName: s.supplier_name,
        quotedPrice: s.quoted_price,
        shareRatio: s.share_ratio,
        isActive: s.is_active,
        supplierId: s.id
      };
    })
    .filter(Boolean);

  const visibleParts = allParts.filter((part: any) => {
    if (mainCatFilter && part.main_category !== mainCatFilter) return false;
    if (subCatFilter && part.sub_category !== subCatFilter) return false;
    if (searchText && !String(part.name || '').toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  const mapSuppliers = supplierType === 'part' ? categoryMatchedSupplierMap : [...new Set(projectSupplierListData.map(row => row!.supplierName))].filter(supplierName => !mapCategoryFilter || (categoryMap[supplierName] || []).includes(mapCategoryFilter)).map(supplierName => ({
    supplierName,
    partCount: new Set(projectSuppliers.filter(row => row.supplier_name === supplierName).map(row => row.project_id)).size,
  }));
  const supplierMapPoints = useMemo(() => {
    const base = mapSuppliers.map(supplier => ({
      supplierName: supplier.supplierName,
      partCount: supplier.partCount,
      location: supplierLocationFromProfile(profiles[supplier.supplierName]),
    })).flatMap((point: any) => {
      const sites = supplierSites[point.supplierName] || [];
      if (sites.length === 0) return [{ ...point, id: `profile-${point.supplierName}`, siteName: '主厂 / 档案地址', address: profiles[point.supplierName]?.address || '' }];
      return sites.map(site => ({
        ...point,
        id: `site-${site.id}`,
        siteId: Number(site.id),
        siteName: site.site_name || '未命名厂家',
        address: site.address || '',
        location: supplierLocationFromProfile(site),
      }));
    });
    const seen = new Set(base.map((point: any) => point.supplierName));
    const poolOnly = Object.values(profiles)
      .filter((profile: any) => profile?.supplier_name && !seen.has(profile.supplier_name))
      .map((profile: any) => ({
        supplierName: profile.supplier_name,
        partCount: 0,
        location: supplierLocationFromProfile(profile),
        id: `profile-${profile.supplier_name}`,
        siteName: '资源池档案',
        address: profile.address || '',
      }));
    return [...base, ...poolOnly];
  }, [mapSuppliers, profiles, supplierSites]);

  const partOverview = useMemo(() => {
    const coverage = summarizePartSupplierCoverage(visibleParts, allSuppliers.filter(row => !supplierFilter || String(row.supplier_name || '').trim() === supplierFilter));
    const supplierRows = filteredSupplierMap
      .map(supplier => {
        const activeParts = supplier.parts.filter(part => {
          const relation = allSuppliers.find(s => s.id === part.supplierId);
          return relation?.is_active !== 0;
        });
        return {
          name: supplier.supplierName,
          partCount: activeParts.length,
          activePartCount: activeParts.length,
          weightedQuote: activeParts.reduce((sum, part) => {
            const relation = allSuppliers.find(s => s.id === part.supplierId);
            return sum + part.price * ((relation?.share_ratio ?? part.shareRatio) / 100);
          }, 0),
        };
      })
      .sort((a, b) => b.partCount - a.partCount || b.weightedQuote - a.weightedQuote);

    const visiblePartIds = new Set(visibleParts.map((part: any) => part.id));
    const relationByPart = new Map<number, PartSupplier[]>();
    coverage.valid.forEach(supplier => {
      const rows = relationByPart.get(supplier.part_id) || [];
      rows.push(supplier);
      relationByPart.set(supplier.part_id, rows);
    });
    const singleSourceParts = visibleParts
      .map((part: any) => ({ part, suppliers: relationByPart.get(part.id) || [] }))
      .filter(row => row.suppliers.length === 1)
      .sort((a, b) => (b.suppliers[0]?.price || 0) - (a.suppliers[0]?.price || 0));

    const categoryMap = new Map<string, number>();
    coverage.valid.forEach(supplier => {
      const part = allParts.find((item: any) => item.id === supplier.part_id);
      if (!part || !visiblePartIds.has(part.id)) return;
      categoryMap.set(part.main_category || '其他', (categoryMap.get(part.main_category || '其他') || 0) + 1);
    });
    const categoryRows = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);
    const weightedQuote = coverage.valid
      .reduce((sum, supplier) => sum + (supplier.price || 0) * ((supplier.share_ratio || 0) / 100), 0);

    return {
      supplierRows,
      categoryRows,
      singleSourceParts,
      relationCount: coverage.relationCount,
      activeRelationCount: coverage.relationCount,
      coveredPartCount: coverage.coveredPartCount,
      noSourcePartCount: coverage.noSourcePartCount,
      multiSourcePartCount: coverage.multiSourcePartCount,
      weightedQuote,
      singleSourceRate: visibleParts.length ? coverage.singleSourcePartCount / visibleParts.length : 0,
    };
  }, [allParts, allSuppliers, filteredSupplierMap, supplierFilter, visibleParts]);

  const projectOverview = useMemo(() => {
    const rows = (projectSupplierListData as Array<any>).filter(row => String(row.supplierName || '').trim());
    const supplierRows = Array.from(new Set(rows.map(row => row.supplierName))).map(name => {
      const supplies = rows.filter(row => row.supplierName === name);
      const activeSupplies = supplies.filter(row => row.isActive !== 0);
      return {
        name,
        projectCount: new Set(supplies.map(row => row.projectCode)).size,
        activeCount: activeSupplies.length,
        avgPrice: supplies.reduce((sum, row) => sum + (row.quotedPrice || 0), 0) / Math.max(supplies.length, 1),
      };
    }).sort((a, b) => b.projectCount - a.projectCount || a.avgPrice - b.avgPrice);
    const projectRows = allProjects
      .filter(project => !searchText || String(project.name || '').toLowerCase().includes(searchText.toLowerCase()))
      .map((project: any) => {
        const quotes = rows.filter(row => row.projectCode === project.code);
        const prices = quotes.map(row => Number(row.quotedPrice) || 0).filter(price => price > 0);
        return {
          code: project.code,
          name: project.name,
          quoteCount: quotes.length,
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxPrice: prices.length ? Math.max(...prices) : 0,
        };
      }).filter(row => row.quoteCount > 0);
    const activeQuotes = rows.filter(row => row.isActive !== 0).length;
    const quotedProjects = new Set(rows.map(row => row.projectCode)).size;
    const avgPrice = rows.length ? rows.reduce((sum, row) => sum + (row.quotedPrice || 0), 0) / rows.length : 0;
    return { supplierRows, projectRows, activeQuotes, quotedProjects, avgPrice };
  }, [allProjects, projectSupplierListData, searchText]);

  const partSupplierCoverageOption = useMemo(() => ({
    animationDuration: 450,
    grid: chartGrid({ top: 8, right: 26, bottom: 12, left: 92 }),
    tooltip: { ...chartTooltip('axis'), valueFormatter: (value: number) => `${value} 个器件` },
    xAxis: { type: 'value', minInterval: 1, ...chartAxisStyle(10), splitLine: { lineStyle: { color: chartSplitLine(), type: 'dashed' } } },
    yAxis: { type: 'category', inverse: true, data: partOverview.supplierRows.slice(0, 8).map(row => row.name), ...chartAxisStyle(11) },
    series: [{ type: 'bar', barWidth: 18, data: partOverview.supplierRows.slice(0, 8).map((row, index) => ({ value: row.partCount, itemStyle: { color: barGradient(CHART_COLORS[index % CHART_COLORS.length]), borderRadius: [0, 8, 8, 0] } })), label: { show: true, position: 'right', color: chartTextMuted(), fontSize: 11 } }],
  }), [partOverview.supplierRows]);

  const partCategoryOption = useMemo(() => ({
    animationDuration: 450,
    tooltip: { ...chartTooltip('item'), valueFormatter: (value: number) => `${value} 条报价关系` },
    legend: { type: 'scroll', bottom: 0, left: 8, right: 8, textStyle: { color: chartTextMuted(), fontSize: 11 } },
    series: [{ type: 'pie', radius: ['48%', '72%'], center: ['50%', '45%'], avoidLabelOverlap: true, itemStyle: { borderColor: 'rgba(255,255,255,0.85)', borderWidth: 3, borderRadius: 6 }, label: { show: true, formatter: (params: any) => `${params.name}\n${params.percent}%`, color: chartTextColor(), fontSize: 11 }, data: partOverview.categoryRows.map(([name, value], index) => ({ name, value, itemStyle: { color: CHART_COLORS[index % CHART_COLORS.length] } })) }],
  }), [partOverview.categoryRows]);

  const projectCoverageOption = useMemo(() => ({
    animationDuration: 450,
    grid: chartGrid({ top: 8, right: 26, bottom: 30, left: 92 }),
    tooltip: { ...chartTooltip('axis'), valueFormatter: (value: number) => `${value} 个项目` },
    xAxis: { type: 'value', minInterval: 1, ...chartAxisStyle(10), splitLine: { lineStyle: { color: chartSplitLine(), type: 'dashed' } } },
    yAxis: { type: 'category', inverse: true, data: projectOverview.supplierRows.slice(0, 8).map(row => row.name), ...chartAxisStyle(11) },
    series: [{ type: 'bar', barWidth: 18, data: projectOverview.supplierRows.slice(0, 8).map((row, index) => ({ value: row.projectCount, itemStyle: { color: barGradient(CHART_COLORS[index % CHART_COLORS.length]), borderRadius: [0, 8, 8, 0] } })), label: { show: true, position: 'right', color: chartTextMuted(), fontSize: 11 } }],
  }), [projectOverview.supplierRows]);

  const projectQuoteOption = useMemo(() => ({
    animationDuration: 450,
    grid: chartGrid({ top: 30, right: 20, bottom: 50, left: 68 }),
    tooltip: { ...chartTooltip('axis'), valueFormatter: (value: number) => `¥${Number(value).toFixed(2)}` },
    legend: { top: 0, right: 4, textStyle: { color: chartTextMuted(), fontSize: 11 } },
    xAxis: { type: 'category', data: projectOverview.projectRows.slice(0, 8).map(row => row.code), ...chartAxisStyle(10, { rotate: 24 }) },
    yAxis: { type: 'value', name: '整机报价', ...chartAxisStyle(10), axisLabel: { color: chartTextMuted(), fontSize: 10, formatter: (value: number) => `¥${Math.round(value)}` } },
    series: [
      { name: '最低报价', type: 'bar', barGap: '10%', barWidth: 18, data: projectOverview.projectRows.slice(0, 8).map(row => row.minPrice), itemStyle: { color: barGradient('#34C759'), borderRadius: [6, 6, 0, 0] } },
      { name: '最高报价', type: 'bar', barWidth: 18, data: projectOverview.projectRows.slice(0, 8).map(row => row.maxPrice), itemStyle: { color: barGradient('#0A84FF'), borderRadius: [6, 6, 0, 0] } },
    ],
  }), [projectOverview.projectRows]);

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}><HomeOutlined /> 供应商管理</h2><Button onClick={() => setActiveTab('resources')}>维护供应商资源池</Button>
        <Radio.Group value={supplierType} onChange={e => setSupplierType(e.target.value)} buttonStyle="solid">
          <Radio.Button value="part"><ToolOutlined /> 器件供应商</Radio.Button>
          <Radio.Button value="project"><BuildOutlined /> 整机供应商（ODM）</Radio.Button>
        </Radio.Group>
      </div>

      {/* ODM 说明条（整机供应商视图下显示） */}
      {supplierType === 'project' && (
        <Card size="small" style={{ marginBottom: 16, background: '#F0F9FF', borderColor: '#BAE6FD' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5, color: '#334155', lineHeight: 1.7 }}>
            <BuildOutlined style={{ color: '#0369A1', fontSize: 16, marginTop: 2 }} />
            <div>
              <b style={{ color: '#0C4A6E' }}>整机供应商（ODM）</b>：指承接整机生产制造的 ODM 工厂，可能提供<b>部分物料或全部物料</b>（含整机 BOM、结构件、组装等）。
              <div style={{ marginTop: 2 }}>
                添加方式：在<b>「项目管理」→ 项目详情 → 报价与定点 → 供应商定点</b>标签页中为该项目的 ODM 工厂录入报价与份额，此处自动汇总展示。
              </div>
            </div>
          </div>
        </Card>
      )}

      {supplierType === 'part' ? (
        <>
          {/* 器件供应商筛选区 */}
          <Card size="small" style={{ marginBottom: 20 }}>
            <Space wrap>
              <Select
                placeholder="大类"
                style={{ width: 120 }}
                allowClear
                value={mainCatFilter || undefined}
                onChange={v => {
                  setMainCatFilter(v || '');
                  // 切换大类时清空子类筛选，避免无效组合
                  if (v !== mainCatFilter) setSubCatFilter('');
                }}
              >
                {mainCategories.map(c => (
                  <Select.Option key={c} value={c}>{c}</Select.Option>
                ))}
              </Select>
              <Select
                placeholder="子类"
                style={{ width: 120 }}
                allowClear
                value={subCatFilter || undefined}
                onChange={v => setSubCatFilter(v || '')}
              >
                {filteredSubCats.map(c => (
                  <Select.Option key={c} value={c}>{c}</Select.Option>
                ))}
              </Select>
              <Select
                placeholder="供应商"
                style={{ width: 150 }}
                allowClear
                showSearch
                value={supplierFilter || undefined}
                onChange={v => setSupplierFilter(v || '')}
              >
                {Array.from(new Set(allSuppliers.map(s => s.supplier_name))).map(name => (
                  <Select.Option key={name} value={name}>{name}</Select.Option>
                ))}
              </Select>
              <Input
                placeholder="搜索器件名称"
                style={{ width: 200 }}
                allowClear
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
              />
            </Space>
          </Card>
        </>
      ) : (
        <>
          {/* 整机供应商筛选区 */}
          <Card size="small" style={{ marginBottom: 20 }}>
            <Space wrap>
              <Select
                placeholder="供应商"
                style={{ width: 150 }}
                allowClear
                showSearch
                value={supplierFilter || undefined}
                onChange={v => setSupplierFilter(v || '')}
              >
                {Array.from(new Set(projectSuppliers.map(s => s.supplier_name))).map(name => (
                  <Select.Option key={name} value={name}>{name}</Select.Option>
                ))}
              </Select>
              <Input
                placeholder="搜索项目名称"
                style={{ width: 200 }}
                allowClear
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
              />
              {supplierType === 'project' && (
                <span style={{ fontSize: 12, color: '#94A3B8' }}>
                  ODM 供应商在「项目管理」中添加后自动出现在这里
                </span>
              )}
            </Space>
          </Card>
        </>
      )}

      {/* 标签页 */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'resources', label: '供应商资源池', children: <SupplierResourcePool /> },
          {
            key: 'overview',
            label: <span><BarChartOutlined /> 供应商看板</span>,
            children: supplierType === 'part' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card size="small" style={{ background: 'linear-gradient(135deg, rgba(10,132,255,0.08), rgba(94,92,230,0.04))' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ color: '#1D4ED8', fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>SUPPLIER CONTROL ROOM</div>
                      <h3 style={{ margin: '4px 0 2px', fontSize: 22 }}>器件供应商决策看板</h3>
                      <div style={{ color: chartTextMuted(), fontSize: 13 }}>先看供货覆盖，再看单一来源风险与加权报价贡献。数据口径：当前供应商关系快照。</div>
                    </div>
                    <Button onClick={() => setActiveTab('list')}>查看明细</Button>
                  </div>
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                  {[
                    { title: '供应商数', value: partOverview.supplierRows.length, suffix: '家', color: '#1D4ED8' },
                    { title: '覆盖器件', value: partOverview.coveredPartCount, suffix: ` / ${visibleParts.length}`, color: '#5E5CE6' },
                    { title: '报价关系', value: partOverview.relationCount, suffix: '条', color: '#0891B2' },
                    { title: '单一来源率', value: `${(partOverview.singleSourceRate * 100).toFixed(1)}%`, suffix: '', color: partOverview.singleSourceRate > 0.5 ? '#D97706' : '#16A34A' },
                    { title: '多来源器件', value: partOverview.multiSourcePartCount, suffix: '个', color: '#0F766E' },
                    { title: '无有效来源', value: partOverview.noSourcePartCount, suffix: '个', color: partOverview.noSourcePartCount ? '#DC2626' : '#16A34A' },
                  ].map(item => (
                    <Card key={item.title} size="small" style={{ borderTop: `3px solid ${item.color}` }}>
                      <Statistic title={item.title} value={item.value} suffix={item.suffix} valueStyle={{ color: item.color, fontSize: 22, fontWeight: 700 }} />
                    </Card>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                  <Card size="small" title="供应商供货覆盖" extra={<span style={{ color: chartTextMuted(), fontSize: 12 }}>按器件关系数 Top 8</span>}>
                    {partOverview.supplierRows.length ? <ReactECharts echarts={echarts} option={partSupplierCoverageOption} style={{ height: 280 }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无供应商关系" />}
                  </Card>
                  <Card size="small" title="报价关系结构" extra={<span style={{ color: chartTextMuted(), fontSize: 12 }}>按器件大类</span>}>
                    {partOverview.categoryRows.length ? <ReactECharts echarts={echarts} option={partCategoryOption} style={{ height: 280 }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无报价关系" />}
                  </Card>
                </div>

                <Card size="small" title="优先处理：单一来源器件" extra={<span style={{ color: '#B45309', fontSize: 12 }}>建议补充第二供应商或核验报价</span>}>
                  {partOverview.singleSourceParts.length ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                      {partOverview.singleSourceParts.slice(0, 6).map(({ part, suppliers }) => (
                        <div key={part.id} style={{ border: '1px solid rgba(217,119,6,0.22)', borderRadius: 10, padding: '12px 14px', background: 'rgba(255,247,237,0.72)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{part.name}</span>
                            <Tag color="warning">单一来源</Tag>
                          </div>
                          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', color: chartTextMuted(), fontSize: 12 }}>
                            <span>{suppliers[0]?.supplier_name || '未命名供应商'}</span>
                            <strong style={{ color: '#B45309' }}>¥{Number(suppliers[0]?.price || 0).toFixed(2)}</strong>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下暂无单一来源器件" />}
                </Card>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card size="small" style={{ background: 'linear-gradient(135deg, rgba(3,105,161,0.08), rgba(10,132,255,0.04))' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ color: '#0369A1', fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>ODM SUPPLIER CONTROL ROOM</div>
                      <h3 style={{ margin: '4px 0 2px', fontSize: 22 }}>整机供应商决策看板</h3>
                      <div style={{ color: chartTextMuted(), fontSize: 13 }}>用项目覆盖和报价区间识别 ODM 选择空间。数据口径：当前项目整机报价快照。</div>
                    </div>
                    <Button onClick={() => setActiveTab('list')}>查看报价明细</Button>
                  </div>
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                  {[
                    { title: 'ODM供应商数', value: projectOverview.supplierRows.length, suffix: '家', color: '#0369A1' },
                    { title: '有报价项目', value: projectOverview.quotedProjects, suffix: ` / ${allProjects.length}`, color: '#5E5CE6' },
                    { title: '启用报价', value: projectOverview.activeQuotes, suffix: '条', color: '#16A34A' },
                    { title: '平均整机报价', value: `¥${projectOverview.avgPrice.toFixed(2)}`, suffix: '', color: '#0F766E' },
                  ].map(item => (
                    <Card key={item.title} size="small" style={{ borderTop: `3px solid ${item.color}` }}>
                      <Statistic title={item.title} value={item.value} suffix={item.suffix} valueStyle={{ color: item.color, fontSize: 22, fontWeight: 700 }} />
                    </Card>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                  <Card size="small" title="ODM 项目覆盖" extra={<span style={{ color: chartTextMuted(), fontSize: 12 }}>按承接项目数 Top 8</span>}>
                    {projectOverview.supplierRows.length ? <ReactECharts echarts={echarts} option={projectCoverageOption} style={{ height: 280 }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 ODM 报价" />}
                  </Card>
                  <Card size="small" title="项目报价区间" extra={<span style={{ color: chartTextMuted(), fontSize: 12 }}>最低 / 最高报价</span>}>
                    {projectOverview.projectRows.length ? <ReactECharts echarts={echarts} option={projectQuoteOption} style={{ height: 280 }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目报价" />}
                  </Card>
                </div>

                <Card size="small" title="需要补报价的项目" extra={<span style={{ color: '#B45309', fontSize: 12 }}>只有 1 家 ODM 报价，谈价空间有限</span>}>
                  {projectOverview.projectRows.filter(row => row.quoteCount === 1).length ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                      {projectOverview.projectRows.filter(row => row.quoteCount === 1).slice(0, 6).map(row => (
                        <div key={row.code} style={{ border: '1px solid rgba(217,119,6,0.22)', borderRadius: 10, padding: '12px 14px', background: 'rgba(255,247,237,0.72)' }}>
                          <div style={{ fontWeight: 600 }}>{row.code} · {row.name}</div>
                          <div style={{ marginTop: 6, color: '#B45309', fontSize: 12 }}>当前仅 1 家供应商报价，报价 ¥{row.minPrice.toFixed(2)}</div>
                        </div>
                      ))}
                    </div>
                  ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有单一 ODM 报价项目" />}
                </Card>
              </div>
            )
          },
          {
            key: 'map',
            label: <span><AppstoreOutlined /> 供应商地图</span>,
            children: supplierType === 'part' ? (
              <div>
                <Card size="small" style={{ marginBottom: 12, background: '#F8FAFC' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ color: '#475569', fontSize: 12 }}>一个供应商可维护多个厂家/基地；地图按厂家地址分别落点，供应商名称仍合并统计。点击圆点可查看该供应商的供应项目情况。</span>
                    <Space wrap>
                      {categoryMatchedSupplierMap.slice(0, 6).map(item => <Button key={item.supplierName} type="link" size="small" onClick={() => showSupplierOverview(item.supplierName)}>{item.supplierName} · 供应项目</Button>)}
                    </Space>
                  </div>
                </Card>
                <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '8px 12px' } }}>
                  <div className="sup-cat-filter">
                    <span className="sup-cat-filter-label">按供应品类看地图</span>
                    <Space wrap size={6}>
                      <Tag.CheckableTag checked={!mapCategoryFilter} onChange={() => setMapCategoryFilter('')}>全部</Tag.CheckableTag>
                      {categoryDict.map(category => <Tag.CheckableTag key={category} checked={mapCategoryFilter === category} onChange={checked => setMapCategoryFilter(checked ? category : '')}>{category}</Tag.CheckableTag>)}
                    </Space>
                    <span className="sup-cat-filter-hint">
                      {mapCategoryFilter
                        ? `当前只看「${mapCategoryFilter}」品类的 ${categoryMatchedSupplierMap.length} 家供应商`
                        : `共 ${Object.values(categoryMap).filter(list => list.length).length} 家已标注品类（在「供应商资源池 → 编辑档案」里选择，可自己新增品类）`}
                    </span>
                  </div>
                </Card>
                <Suspense fallback={<Card size="small"><Spin tip="正在加载供应商地图…" /></Card>}>
                  <ChinaSupplierMap
                    suppliers={supplierMapPoints}
                    selectedSupplier={selectedSupplier?.supplierName}
                    onSelect={name => showSupplierOverview(name)}
                    onEditLocation={openProfileModal}
                  />
                </Suspense>
                {categoryMatchedSupplierMap.length === 0 ? (
                  <Empty description={mapCategoryFilter ? `暂无「${mapCategoryFilter}」品类的供应商` : '暂无数据'} />
                ) : (
                  (() => {
                    // 按大类分组供应商
                    const groupedByCategory: Record<string, SupplierMapItem[]> = {};

                    categoryMatchedSupplierMap.forEach(supplier => {
                      // 找出该供应商主要供应的大类（器件数量最多的大类）
                      const categoryCounts: Record<string, number> = {};
                      supplier.parts.forEach(part => {
                        categoryCounts[part.mainCategory] = (categoryCounts[part.mainCategory] || 0) + 1;
                      });

                      const mainCategory = Object.entries(categoryCounts)
                        .sort((a, b) => b[1] - a[1])[0]?.[0] || '其他';

                      if (!groupedByCategory[mainCategory]) {
                        groupedByCategory[mainCategory] = [];
                      }
                      groupedByCategory[mainCategory].push(supplier);
                    });

                    return (
                      <div>
                        {Object.entries(groupedByCategory).map(([category, suppliers]) => {
                          const categoryColor = getCategoryColor(category);
                          const lightBg = categoryColor + '15'; // 添加透明度

                          return (
                            <div key={category} style={{ marginBottom: 24 }}>
                              <div style={{
                                marginBottom: 12,
                                padding: '8px 12px',
                                background: lightBg,
                                borderLeft: `4px solid ${categoryColor}`,
                                borderRadius: 4,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8
                              }}>
                                <Tag color={categoryColor} style={{ margin: 0 }}>{category}</Tag>
                                <span style={{ fontSize: 13, color: '#666' }}>
                                  {suppliers.length} 个供应商
                                </span>
                              </div>

                              <Row gutter={[16, 16]}>
                                {suppliers.map(supplier => (
                                  <Col key={supplier.supplierName} xs={24} sm={12} md={8} lg={6}>
                                    <Card
                                      hoverable
                                      size="small"
                                      style={{
                                        height: '100%',
                                        background: lightBg,
                                        borderColor: categoryColor + '40'
                                      }}
                                      onClick={() => showSupplierDetail(supplier)}
                                    >
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                        {/* 供应商Logo（有档案显示图片，无档案显示首字母） */}
                                        <div style={{
                                          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                                          background: '#fff', border: '1px solid #eee', overflow: 'hidden',
                                          fontSize: 14, fontWeight: 600, color: getCategoryColor(supplier.mainCategories[0] || '其他'),
                                        }}
                                          onClick={(e) => { e.stopPropagation(); setUploadTarget(supplier.supplierName); }}
                                        >
                                          {profiles[supplier.supplierName]?.logo
                                            ? <img src={profiles[supplier.supplierName].logo} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 3 }} />
                                            : <CameraOutlined style={{ fontSize: 16, color: '#bbb' }} />}
                                        </div>
                                        <div style={{ fontSize: 14, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          <ShopOutlined style={{ marginRight: 4 }} />{supplier.supplierName}
                                        </div>
                                      </div>
                                      <Statistic
                                        value={supplier.partCount}
                                        suffix="个器件"
                                        valueStyle={{ fontSize: 18 }}
                                      />
                                      <div style={{ marginTop: 10, fontSize: 11, color: '#888' }}>
                                        <div style={{ marginBottom: 4, color: '#0369A1' }}>
                                          厂家地点：{supplierSites[supplier.supplierName]?.length || (profiles[supplier.supplierName] ? 1 : 0)} 个 · <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); openProfileModal(supplier.supplierName); }} style={{ padding: 0, height: 'auto', fontSize: 11 }}>维护地址</Button>
                                        </div>
                                        {(categoryMap[supplier.supplierName] || []).length > 0 && (
                                          <div style={{ marginBottom: 4 }}>
                                            {(categoryMap[supplier.supplierName] || []).map(category => <Tag key={category} color="blue" style={{ marginInlineEnd: 4 }}>{category}</Tag>)}
                                          </div>
                                        )}
                                        {supplier.mainCategories.length > 1 && (
                                          <div style={{ marginBottom: 4 }}>
                                            涉及 {supplier.mainCategories.length} 个大类
                                          </div>
                                        )}
                                        点击查看供应项目
                                      </div>
                                    </Card>
                                  </Col>
                                ))}
                              </Row>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()
                )}
              </div>
            ) : (
              <div>
                <Suspense fallback={<Spin tip="正在加载供应商地图…" />}>
                  <ChinaSupplierMap suppliers={supplierMapPoints} countLabel="项目" onSelect={name => showSupplierOverview(name)} onEditLocation={openProfileModal} />
                </Suspense>
                {(() => {
                  // 整机供应商：按供应商分组
                  const groupedBySupplier: Record<string, Array<{ projectCode: string; projectName: string; quotedPrice: number; shareRatio: number; isActive: number; supplierId: number }>> = {};

                  projectSupplierListData.forEach((item: any) => {
                    if (!groupedBySupplier[item.supplierName]) {
                      groupedBySupplier[item.supplierName] = [];
                    }
                    groupedBySupplier[item.supplierName].push({
                      projectCode: item.projectCode,
                      projectName: item.projectName,
                      quotedPrice: item.quotedPrice,
                      shareRatio: item.shareRatio,
                      isActive: item.isActive,
                      supplierId: item.supplierId
                    });
                  });

                  return Object.keys(groupedBySupplier).length === 0 ? (
                    <Empty description="暂无整机供应商数据 — 请到「项目管理」的项目详情中添加工厂整机报价" />
                  ) : (
                    <Row gutter={[16, 16]}>
                      {Object.entries(groupedBySupplier).map(([supplierName, projects]) => {
                        const totalProjects = projects.length;
                        const avgPrice = projects.reduce((sum, p) => sum + p.quotedPrice, 0) / totalProjects;

                        return (
                          <Col key={supplierName} xs={24} sm={12} md={8} lg={6}>
                            <Card
                              hoverable
                              size="small"
                              style={{ height: '100%' }}
                            >
                              <Statistic
                                title={<div style={{ fontSize: 14, fontWeight: 600 }}><BuildOutlined /> {supplierName} <Tag color="blue" style={{ fontSize: 9, marginLeft: 4 }}>ODM</Tag></div>}
                                value={totalProjects}
                                suffix="个项目"
                                valueStyle={{ fontSize: 18 }}
                              />
                              <div style={{ marginTop: 10, fontSize: 12, color: '#666' }}>
                                平均整机报价：¥{avgPrice.toFixed(2)}
                              </div>
                              <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
                                承接项目：{projects.map(p => p.projectCode).join(', ')}
                                <Button type="link" size="small" onClick={() => openProfileModal(supplierName)}>厂家地址</Button>
                              </div>
                              <div style={{ marginTop: 8, fontSize: 11, color: '#0369A1' }}>
                                <BuildOutlined style={{ marginRight: 4 }} />ODM 提供部分或全部物料，报价/份额在项目详情中管理
                              </div>
                            </Card>
                          </Col>
                        );
                      })}
                    </Row>
                  );
                })()}
              </div>
            )
          },
          {
            key: 'list',
            label: <span><UnorderedListOutlined /> 详细列表</span>,
            children: supplierType === 'part' ? (
              <div className="supplier-detail-list">
                <DataTable tableId="sup_detail"
                  dataSource={detailListData}
                  rowKey="id"
                  size="small"
                  loading={loading}
                  pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
                  columns={[
                  { title: '大类', dataIndex: 'mainCategory', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                  { title: '子类', dataIndex: 'subCategory', width: 100 },
                  { title: '器件名称', dataIndex: 'partName', ellipsis: true },
                  { title: '型号', dataIndex: 'partModel', width: 120, ellipsis: true },
                  { title: '供应商', dataIndex: 'supplierName', width: 120 },
                  { title: '价格(¥)', dataIndex: 'price', width: 100, align: 'right', render: (v: number) => <span style={{ fontFamily: 'monospace' }}>¥{v.toFixed(2)}</span> },
                  { title: '份额', dataIndex: 'shareRatio', width: 80, render: (v: number) => `${v}%` },
                  { title: '状态', dataIndex: 'isActive', width: 80, render: (v: number) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
                  {
                    title: '操作',
                    width: 120,
                    render: (_: any, record: any) => (
                      <Space size="small">
                        <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showPriceHistory(record.partId, record.supplierName)} />
                        <Button type="link" size="small" icon={<EditOutlined />} onClick={() => {
                          const relation = allSuppliers.find(s => s.id === record.id);
                          if (relation) openEditModal(relation);
                        }} />
                        <Popconfirm title="删除？" onConfirm={() => deleteRelation(record.id)}>
                          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    )
                  }
                  ]}
                />
              </div>
            ) : (
              <div className="supplier-detail-list">
                <DataTable tableId="sup_odm_list"
                  dataSource={projectSupplierListData}
                  rowKey="id"
                  size="small"
                  loading={loading}
                  pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
                  columns={[
                  { title: '项目代号', dataIndex: 'projectCode', width: 120 },
                  { title: '项目名称', dataIndex: 'projectName', ellipsis: true },
                  { title: '供应商', dataIndex: 'supplierName', width: 150 },
                  { title: '整机报价(¥)', dataIndex: 'quotedPrice', width: 120, align: 'right', render: (v: number) => <span style={{ fontFamily: 'monospace' }}>¥{v.toFixed(2)}</span> },
                  { title: '份额', dataIndex: 'shareRatio', width: 80, render: (v: number) => `${v}%` },
                  { title: '状态', dataIndex: 'isActive', width: 80, render: (v: number) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
                  {
                    title: '操作',
                    width: 80,
                    render: (_: any, record: any) => (
                      <Space size="small">
                        <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showProjectPriceHistory(record.supplierId)} />
                      </Space>
                    )
                  }
                  ]}
                />
              </div>
            )
          },
          supplierType === 'part' ? {
            key: 'stats',
            label: <span><BarChartOutlined /> 数据统计</span>,
            children: (
              <div>
                <Row gutter={[16, 16]}>
                  {/* 供应商排行榜 */}
                  <Col xs={24} lg={12}>
                    <Card title="供应商排行榜（按供货数量）" size="small">
                      <DataTable tableId="sup_rank"
                        dataSource={Array.from(new Set(allSuppliers.map(s => s.supplier_name)))
                          .map(name => {
                            const supplies = allSuppliers.filter(s => s.supplier_name === name);
                            const totalAmount = supplies.reduce((sum, s) => sum + (s.price || 0) * (s.share_ratio || 0) / 100, 0);
                            return {
                              name,
                              count: supplies.length,
                              totalAmount,
                              avgPrice: totalAmount / supplies.length
                            };
                          })
                          .sort((a, b) => b.count - a.count)
                          .slice(0, 10)}
                        rowKey="name"
                        size="small"
                        pagination={false}
                        columns={[
                          { title: '排名', width: 60, render: (_: any, __: any, index: number) => index + 1 },
                          { title: '供应商', dataIndex: 'name', ellipsis: true },
                          { title: '供货数', dataIndex: 'count', width: 80, align: 'right' },
                          { title: '总金额', dataIndex: 'totalAmount', width: 120, align: 'right', render: (v: number) => `¥${v.toFixed(2)}` }
                        ]}
                      />
                    </Card>
                  </Col>

                  {/* 供应商集中度 */}
                  <Col xs={24} lg={12}>
                    <Card title="器件供应商集中度" size="small">
                      {(() => {
                        const partSupplierCount: Record<number, number> = {};
                        allParts.forEach(part => {
                          const count = allSuppliers.filter(s => s.part_id === part.id).length;
                          partSupplierCount[count] = (partSupplierCount[count] || 0) + 1;
                        });

                        const singleSupplier = partSupplierCount[1] || 0;
                        const dualSupplier = partSupplierCount[2] || 0;
                        const multiSupplier = Object.entries(partSupplierCount)
                          .filter(([count]) => parseInt(count) >= 3)
                          .reduce((sum, [, num]) => sum + num, 0);
                        const totalParts = allParts.length;
                        const singlePercent = totalParts > 0 ? (singleSupplier / totalParts * 100).toFixed(1) : 0;

                        return (
                          <div style={{ padding: '20px 0' }}>
                            <Row gutter={16}>
                              <Col span={8}>
                                <Statistic
                                  title="单一供应商"
                                  value={singleSupplier}
                                  suffix={`/ ${totalParts}`}
                                  valueStyle={{ color: parseFloat(singlePercent as string) > 50 ? '#f5222d' : undefined }}
                                />
                                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                                  {singlePercent}% {parseFloat(singlePercent as string) > 50 && <Tag color="red">风险</Tag>}
                                </div>
                              </Col>
                              <Col span={8}>
                                <Statistic title="双供应商" value={dualSupplier} suffix={`/ ${totalParts}`} />
                                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                                  {totalParts > 0 ? (dualSupplier / totalParts * 100).toFixed(1) : 0}%
                                </div>
                              </Col>
                              <Col span={8}>
                                <Statistic title="多供应商(≥3)" value={multiSupplier} suffix={`/ ${totalParts}`} valueStyle={{ color: '#52c41a' }} />
                                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                                  {totalParts > 0 ? (multiSupplier / totalParts * 100).toFixed(1) : 0}%
                                </div>
                              </Col>
                            </Row>
                          </div>
                        );
                      })()}
                    </Card>
                  </Col>

                  {/* 高价器件Top10 */}
                  <Col xs={24} lg={12}>
                    <Card title="高价器件 Top10（降本重点）" size="small">
                      <DataTable tableId="sup_top10"
                        dataSource={allSuppliers
                          .map(s => {
                            const part = allParts.find(p => p.id === s.part_id);
                            return part ? { ...s, partName: part.name, mainCategory: part.main_category } : null;
                          })
                          .filter(Boolean)
                          .sort((a: any, b: any) => b.price - a.price)
                          .slice(0, 10)}
                        rowKey="id"
                        size="small"
                        pagination={false}
                        columns={[
                          { title: '排名', width: 60, render: (_: any, __: any, index: number) => index + 1 },
                          { title: '器件名称', dataIndex: 'partName', ellipsis: true },
                          { title: '大类', dataIndex: 'mainCategory', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                          { title: '价格', dataIndex: 'price', width: 100, align: 'right', render: (v: number) => `¥${v.toFixed(2)}` }
                        ]}
                      />
                    </Card>
                  </Col>

                  {/* 大类供应商分布 */}
                  <Col xs={24} lg={12}>
                    <Card title="大类供应商分布" size="small">
                      <DataTable tableId="sup_bycat"
                        dataSource={mainCategories.map(cat => {
                          const catParts = allParts.filter((p: any) => p.main_category === cat);
                          const catSuppliers = new Set(
                            allSuppliers
                              .filter(s => catParts.some(p => p.id === s.part_id))
                              .map(s => s.supplier_name)
                          );
                          return {
                            category: cat,
                            partCount: catParts.length,
                            supplierCount: catSuppliers.size,
                            avgSuppliersPerPart: catParts.length > 0 ? (
                              allSuppliers.filter(s => catParts.some(p => p.id === s.part_id)).length / catParts.length
                            ).toFixed(1) : 0
                          };
                        }).sort((a, b) => b.partCount - a.partCount)}
                        rowKey="category"
                        size="small"
                        pagination={false}
                        columns={[
                          { title: '大类', dataIndex: 'category', render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                          { title: '器件数', dataIndex: 'partCount', width: 80, align: 'right' },
                          { title: '供应商数', dataIndex: 'supplierCount', width: 100, align: 'right' },
                          { title: '平均供应商/器件', dataIndex: 'avgSuppliersPerPart', width: 140, align: 'right' }
                        ]}
                      />
                    </Card>
                  </Col>
                </Row>
              </div>
            )
          } : (
            // 整机供应商（ODM）统计
            {
              key: 'stats',
              label: <span><BarChartOutlined /> ODM 统计</span>,
              children: (
                <div>
                  <Row gutter={[16, 16]}>
                    {/* 项目 ODM 覆盖 */}
                    <Col xs={24} lg={12}>
                      <Card title="各项目 ODM 供应商覆盖" size="small">
                        <DataTable tableId="sup_odm_byproj"
                          dataSource={allProjects.map(proj => {
                            const sups = projectSuppliers.filter(s => s.project_id === proj.id);
                            const active = sups.filter(s => s.is_active);
                            const weighted = active.reduce((sum, s) => sum + (s.quoted_price || 0) * (s.share_ratio || 0) / 100, 0);
                            return {
                              key: proj.id,
                              code: proj.code,
                              name: proj.name,
                              count: sups.length,
                              activeCount: active.length,
                              weighted,
                            };
                          })}
                          rowKey="key"
                          size="small"
                          pagination={false}
                          columns={[
                            { title: '项目代号', dataIndex: 'code', width: 110 },
                            { title: '项目名称', dataIndex: 'name', ellipsis: true },
                            { title: 'ODM 数', dataIndex: 'count', width: 70, align: 'right' },
                            { title: '启用', dataIndex: 'activeCount', width: 60, align: 'right', render: (v: number, r: any) => v === r.count ? <Tag color="green" style={{ fontSize: 9 }}>全部</Tag> : v },
                            { title: '加权报价(¥)', dataIndex: 'weighted', width: 120, align: 'right', render: (v: number) => v > 0 ? <span style={{ fontFamily: 'monospace' }}>¥{v.toFixed(2)}</span> : <span style={{ color: '#ccc' }}>-</span> },
                          ]}
                        />
                      </Card>
                    </Col>
                    {/* ODM 供应商覆盖项目数 */}
                    <Col xs={24} lg={12}>
                      <Card title="ODM 供应商承接项目数" size="small">
                        <DataTable tableId="sup_odm_rank"
                          dataSource={Array.from(new Set(projectSuppliers.map(s => s.supplier_name)))
                            .map(name => {
                              const sups = projectSuppliers.filter(s => s.supplier_name === name);
                              const projCount = new Set(sups.map(s => s.project_id)).size;
                              const avgPrice = sups.reduce((sum, s) => sum + (s.quoted_price || 0), 0) / sups.length;
                              return { name, projCount, avgPrice };
                            })
                            .sort((a, b) => b.projCount - a.projCount)}
                          rowKey="name"
                          size="small"
                          pagination={false}
                          columns={[
                            { title: 'ODM 供应商', dataIndex: 'name', ellipsis: true, render: (v: string) => <><BuildOutlined style={{ marginRight: 4, color: '#0369A1' }} />{v}</> },
                            { title: '承接项目', dataIndex: 'projCount', width: 100, align: 'right' },
                            { title: '平均报价(¥)', dataIndex: 'avgPrice', width: 120, align: 'right', render: (v: number) => `¥${v.toFixed(2)}` },
                          ]}
                        />
                      </Card>
                    </Col>
                  </Row>
                  <div style={{ marginTop: 12, fontSize: 11.5, color: '#94A3B8' }}>
                    <EmojiIcon e="💡" /> ODM 供应商的报价、份额、报价历史在「项目管理 → 项目详情 → <EmojiIcon e="🏭" /> 整机供应商」中维护，此处自动汇总。
                  </div>
                </div>
              )
            }
          ),
          supplierType === 'part' ? {
            key: 'compare',
            label: <span><SearchOutlined /> 供应商对比</span>,
            children: (
              <div>
                <Card size="small" style={{ marginBottom: 20 }}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <div>选择2-4个供应商进行对比：</div>
                    <Select
                      mode="multiple"
                      placeholder="选择供应商"
                      style={{ width: '100%' }}
                      value={selectedSuppliers}
                      onChange={setSelectedSuppliers}
                      maxCount={4}
                    >
                      {Array.from(new Set(allSuppliers.map(s => s.supplier_name))).map(name => (
                        <Select.Option key={name} value={name}>{name}</Select.Option>
                      ))}
                    </Select>
                  </Space>
                </Card>

                {selectedSuppliers.length >= 2 ? (
                  <Row gutter={[16, 16]}>
                    {/* 供货范围对比 */}
                    <Col xs={24}>
                      <Card title="供货范围对比" size="small">
                        <DataTable tableId="sup_compare"
                          dataSource={selectedSuppliers.map(supplierName => {
                            const supplies = allSuppliers.filter(s => s.supplier_name === supplierName);
                            const categories = new Set(
                              supplies.map(s => {
                                const part = allParts.find(p => p.id === s.part_id);
                                return part?.main_category;
                              }).filter(Boolean)
                            );
                            return {
                              supplierName,
                              totalParts: supplies.length,
                              categories: Array.from(categories),
                              avgPrice: supplies.reduce((sum, s) => sum + (s.price || 0), 0) / supplies.length,
                              avgShare: supplies.reduce((sum, s) => sum + (s.share_ratio || 0), 0) / supplies.length
                            };
                          })}
                          rowKey="supplierName"
                          size="small"
                          pagination={false}
                          columns={[
                            { title: '供应商', dataIndex: 'supplierName', width: 150 },
                            { title: '供货数量', dataIndex: 'totalParts', width: 100, align: 'right' },
                            {
                              title: '供货大类',
                              dataIndex: 'categories',
                              render: (cats: string[]) => (
                                <Space wrap>
                                  {cats.map(c => <Tag key={c} color={getCategoryColor(c)}>{c}</Tag>)}
                                </Space>
                              )
                            },
                            { title: '平均价格', dataIndex: 'avgPrice', width: 120, align: 'right', render: (v: number) => `¥${v.toFixed(2)}` },
                            { title: '平均份额', dataIndex: 'avgShare', width: 100, align: 'right', render: (v: number) => `${v.toFixed(1)}%` }
                          ]}
                        />
                      </Card>
                    </Col>

                    {/* 重叠器件分析 */}
                    <Col xs={24}>
                      <Card title="重叠器件分析（降本机会点）" size="small">
                        {(() => {
                          // 找出所有选中供应商都能供的器件
                          const supplierParts: Record<string, Set<number>> = {};
                          selectedSuppliers.forEach(supplierName => {
                            supplierParts[supplierName] = new Set(
                              allSuppliers.filter(s => s.supplier_name === supplierName).map(s => s.part_id)
                            );
                          });

                          // 找交集
                          const intersection = Array.from(supplierParts[selectedSuppliers[0]] || []).filter(partId =>
                            selectedSuppliers.every(supplierName => supplierParts[supplierName]?.has(partId))
                          );

                          if (intersection.length === 0) {
                            return <Empty description="所选供应商没有共同供货的器件" />;
                          }

                          return (
                            <div>
                              <div style={{ marginBottom: 12, color: '#666' }}>
                                找到 {intersection.length} 个重叠器件（这些器件可进行价格对比）
                              </div>
                              <Table
                                dataSource={intersection.slice(0, 20).map(partId => {
                                  const part = allParts.find(p => p.id === partId);
                                  const prices: Record<string, number> = {};
                                  selectedSuppliers.forEach(supplierName => {
                                    const supply = allSuppliers.find(s => s.part_id === partId && s.supplier_name === supplierName);
                                    if (supply && supply.price) prices[supplierName] = supply.price;
                                  });
                                  const minPrice = Math.min(...Object.values(prices));
                                  const maxPrice = Math.max(...Object.values(prices));
                                  const priceDiff = maxPrice - minPrice;
                                  const diffPercent = minPrice > 0 ? (priceDiff / minPrice * 100).toFixed(1) : 0;

                                  return {
                                    partId,
                                    partName: part?.name,
                                    mainCategory: part?.main_category,
                                    prices,
                                    minPrice,
                                    maxPrice,
                                    priceDiff,
                                    diffPercent
                                  };
                                }).sort((a: any, b: any) => b.priceDiff - a.priceDiff)}
                                rowKey="partId"
                                size="small"
                                pagination={{ pageSize: 10 }}
                                columns={[
                                  { title: '器件名称', dataIndex: 'partName', ellipsis: true },
                                  { title: '大类', dataIndex: 'mainCategory', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                                  ...selectedSuppliers.map(supplierName => ({
                                    title: supplierName,
                                    width: 100,
                                    align: 'right' as const,
                                    render: (_: any, record: any) => {
                                      const price = record.prices[supplierName];
                                      const isMin = price === record.minPrice;
                                      return (
                                        <span style={{ color: isMin ? '#52c41a' : undefined, fontWeight: isMin ? 600 : undefined }}>
                                          ¥{price.toFixed(2)}
                                        </span>
                                      );
                                    }
                                  })),
                                  {
                                    title: '价差',
                                    width: 120,
                                    align: 'right' as const,
                                    render: (_: any, record: any) => (
                                      <span style={{ color: parseFloat(record.diffPercent) > 20 ? '#f5222d' : undefined }}>
                                        ¥{record.priceDiff.toFixed(2)} ({record.diffPercent}%)
                                      </span>
                                    )
                                  }
                                ]}
                              />
                            </div>
                          );
                        })()}
                      </Card>
                    </Col>
                  </Row>
                ) : (
                  <Empty description="请至少选择2个供应商进行对比" />
                )}
              </div>
            )
          } : null
        ].filter((item): item is { key: string; label: React.ReactElement; children: React.ReactElement } => item !== null)}
      />

      {/* 供应商详情弹窗：供应项目情况（默认）+ 供货器件明细 */}
      <Modal
        title={<span><ShopOutlined /> {selectedSupplier?.supplierName || overviewSupplier}</span>}
        open={detailModalOpen}
        onCancel={() => { setDetailModalOpen(false); setOverviewSupplier(''); }}
        width={960}
        footer={null}
      >
        {(selectedSupplier || overviewSupplier) && (
          <Tabs
            size="small"
            items={[
              {
                key: 'projects',
                label: '供应项目情况',
                children: <>
                  <div style={{ marginBottom: 10, fontSize: 13, color: '#666' }}>
                    供货器件数量：<strong>{selectedSupplier ? selectedSupplier.partCount : '见下表'}</strong>
                  </div>
                  <SupplierProjectPanel
                    supplierName={selectedSupplier?.supplierName || overviewSupplier}
                    onEditLocation={openProfileModal}
                  />
                </>,
              },
              ...(selectedSupplier ? [{
                key: 'parts',
                label: `供货器件明细（${selectedSupplier.parts.length}）`,
                children: <DataTable tableId="sup_detail_parts"
                  dataSource={selectedSupplier.parts}
                  rowKey="supplierId"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: '大类', dataIndex: 'mainCategory', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                    { title: '子类', dataIndex: 'subCategory', width: 100 },
                    { title: '器件名称', dataIndex: 'partName', ellipsis: true },
                    { title: '型号', dataIndex: 'partModel', width: 120, ellipsis: true },
                    { title: '价格(¥)', dataIndex: 'price', width: 100, align: 'right' as const, render: (v: number) => <span style={{ fontFamily: 'monospace' }}>¥{v.toFixed(2)}</span> },
                    { title: '份额', dataIndex: 'shareRatio', width: 80, render: (v: number) => `${v}%` },
                    {
                      title: '操作',
                      width: 80,
                      render: (_: any, record: any) => (
                        <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showPriceHistory(record.partId, record.supplierName)} />
                      )
                    }
                  ]}
                />,
              }] : []),
            ]}
          />
        )}
      </Modal>

      {/* 编辑关系弹窗 */}
      <Modal
        title={editingRelation ? '编辑供应商关系' : '添加供应商关系'}
        open={editModalOpen}
        onOk={saveRelation}
        onCancel={() => setEditModalOpen(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="器件" name="part_id" rules={[{ required: true, message: '请选择器件' }]}>
            <Select
              showSearch
              placeholder="选择器件"
              optionFilterProp="children"
            >
              {allParts.map(p => (
                <Select.Option key={p.id} value={p.id}>
                  {p.name} {p.model ? `(${p.model})` : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="供应商名称" name="supplier_name" rules={[{ required: true, message: '请输入供应商名称' }]}>
            <SupplierNameInput />
          </Form.Item>
          <Form.Item label="报价(¥)" name="price" rules={[{ required: true, message: '请输入报价' }]}>
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="份额(%)" name="share_ratio" rules={[{ required: true, message: '请输入份额' }]}>
            <InputNumber min={0} max={100} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="状态" name="is_active" initialValue={1}>
            <Select>
              <Select.Option value={1}>启用</Select.Option>
              <Select.Option value={0}>停用</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`维护供应商厂家地址 - ${profileTarget || ''}`}
        open={profileModalOpen}
        onOk={saveProfileLocation}
        onCancel={() => setProfileModalOpen(false)}
        okText="保存位置"
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
          <Select
            style={{ flex: 1 }}
            value={profileSiteId || undefined}
            placeholder="选择已有厂家"
            allowClear
            options={(supplierSites[profileTarget || ''] || []).map(site => ({ label: `${site.site_name}${site.city ? ` · ${site.city}` : ''}`, value: site.id }))}
            onChange={siteId => profileTarget && openProfileModal(profileTarget, siteId)}
          />
          <Button onClick={addSupplierSiteForm}>新增厂家</Button>
          {profileSiteId && <Popconfirm title="删除这个厂家地址？" onConfirm={async () => { await deleteSupplierSite(profileSiteId); message.success('厂家地址已删除'); setProfileModalOpen(false); await loadData(); }}>
            <Button danger>删除</Button>
          </Popconfirm>}
        </div>
        <Alert
          type="info"
          showIcon
          message="一个供应商可以维护多个厂家；地址用于识别工厂，地图落点仍建议填写准确经纬度。"
          style={{ marginBottom: 16 }}
        />
        <Form form={profileForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item label="厂家名称" name="site_name" rules={[{ required: true, message: '请输入厂家名称' }]}>
              <Input placeholder="例如：深圳总部 / 东莞注塑厂" />
            </Form.Item>
            <Form.Item label="厂家地址" name="address" rules={[{ required: true, message: '请输入厂家地址' }]}>
              <Input placeholder="例如：广东省东莞市松山湖某工业园" />
            </Form.Item>
            <Form.Item label="省 / 区域" name="province">
              <Input placeholder="例如：广东省 / 华南" />
            </Form.Item>
            <Form.Item label="城市" name="city">
              <Input placeholder="例如：深圳市" />
            </Form.Item>
            <Form.Item label="经度" name="longitude">
              <InputNumber min={73} max={136} precision={6} style={{ width: '100%' }} placeholder="例如：114.0579" />
            </Form.Item>
            <Form.Item label="纬度" name="latitude">
              <InputNumber min={3} max={54} precision={6} style={{ width: '100%' }} placeholder="例如：22.5431" />
            </Form.Item>
            <Form.Item label="联系人" name="contact">
              <Input placeholder="厂家联系人" />
            </Form.Item>
            <Form.Item label="联系电话" name="phone">
              <Input placeholder="厂家联系电话" />
            </Form.Item>
          </div>
          <Form.Item name="is_primary" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>设为该供应商主厂</Checkbox>
          </Form.Item>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>经纬度可从厂家官网地址、地图工具或企业档案中确认；不要凭估计填写。未填经纬度时，仅“华东/华南/华北/西南”支持区域中心定位；其他地址会列为待定位。</div>
        </Form>
      </Modal>

      {/* 价格历史弹窗 */}
      <Modal
        title="价格历史"
        open={priceHistoryOpen}
        onCancel={() => setPriceHistoryOpen(false)}
        footer={null}
        width={800}
      >
        <DataTable tableId="sup_price_hist"
          dataSource={priceHistory}
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 800 }}
          columns={[
            { title: '变更时间', dataIndex: 'changed_at', width: 150 },
            { title: '旧价格', dataIndex: 'old_price', width: 100, render: (v: number) => `¥${v.toFixed(2)}` },
            { title: '新价格', dataIndex: 'new_price', width: 100, render: (v: number) => `¥${v.toFixed(2)}` },
            {
              title: '变动',
              width: 120,
              render: (_: any, record: any) => {
                const diff = record.new_price - record.old_price;
                const percent = ((diff / record.old_price) * 100).toFixed(1);
                return (
                  <span style={{ color: diff > 0 ? '#f5222d' : '#52c41a' }}>
                    {diff > 0 ? '↑' : '↓'} {Math.abs(diff).toFixed(2)} ({percent}%)
                  </span>
                );
              }
            },
            { title: '变更原因', dataIndex: 'change_reason', ellipsis: true }
          ]}
        />
      </Modal>

      {/* 供应商Logo上传弹窗 */}
      <Modal
        title={`上传 Logo - ${uploadTarget || ''}`}
        open={!!uploadTarget}
        onCancel={() => setUploadTarget(null)}
        footer={null}
        width={420}
      >
        <Upload
          accept="image/png,image/jpeg,image/svg+xml"
          showUploadList={false}
          beforeUpload={(file) => {
            // 限制2MB以内
            if (file.size > 2 * 1024 * 1024) { message.warning('图片请小于2MB'); return false; }
            const reader = new FileReader();
            reader.onload = async (e) => {
              const base64 = String(e.target?.result || '');
              if (uploadTarget) {
                try {
                  await saveSupplierProfile({ supplier_name: uploadTarget, logo: base64 });
                  // 刷新档案
                  const profs = await getSupplierProfiles();
                  const pmap: Record<string, any> = {};
                  profs.forEach((p: any) => { pmap[p.supplier_name] = p; });
                  setProfiles(pmap);
                  message.success('Logo 已上传');
                } catch (err: any) { message.error(`上传失败：${err?.message || err}`); }
              }
            };
            reader.readAsDataURL(file);
            return false;
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0', border: '1px dashed #d9d9d9', borderRadius: 8, cursor: 'pointer' }}>
            <CameraOutlined style={{ fontSize: 36, color: '#999' }} />
            <div style={{ fontSize: 13, color: '#666' }}>点击选择图片（PNG/JPG/SVG，小于2MB）</div>
            {uploadTarget && profiles[uploadTarget]?.logo && (
              <img src={profiles[uploadTarget].logo} alt="logo" style={{ width: 60, height: 60, objectFit: 'contain' }} />
            )}
          </div>
        </Upload>
        {uploadTarget && profiles[uploadTarget]?.logo && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Button size="small" danger onClick={async () => {
              if (uploadTarget) {
                await saveSupplierProfile({ supplier_name: uploadTarget, logo: '' });
                const profs = await getSupplierProfiles();
                const pmap: Record<string, any> = {};
                profs.forEach((p: any) => { pmap[p.supplier_name] = p; });
                setProfiles(pmap);
                message.success('已移除 Logo');
              }
            }}>移除 Logo</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
