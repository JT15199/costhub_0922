import { useState, useEffect, useMemo } from 'react';
import { Card, Button, Input, Select, Tag, Space, Modal, Form, message, Tabs, Row, Col, Statistic, Table, Popconfirm, Empty, InputNumber, Radio, Upload } from 'antd';
import { ShopOutlined, AppstoreOutlined, UnorderedListOutlined, EditOutlined, DeleteOutlined, HistoryOutlined, HomeOutlined, BuildOutlined, ToolOutlined, BarChartOutlined, SearchOutlined, CameraOutlined } from '@ant-design/icons';
import { getAllPartSuppliers, getParts, addPartSupplier, updatePartSupplier, deletePartSupplier, getSupplierPriceHistory, getProjects, getProjectSuppliers, getSupplierProfiles, saveSupplierProfile } from '../db';
import { getCategoryColor } from '../constants';
import DataTable from '../components/DataTable';
import type { PartSupplier, ProjectSupplier } from '../types';

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

export default function SupplierManagement() {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('map');
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
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
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

  // 价格历史
  const [priceHistoryOpen, setPriceHistoryOpen] = useState(false);
  const [priceHistory, setPriceHistory] = useState<any[]>([]);

  // 供应商对比选择
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);

  useEffect(() => {
    loadData();
  }, [supplierType]);

  const loadData = async () => {
    setLoading(true);
    try {
      if (supplierType === 'part') {
        // 加载器件供应商数据
        console.log('Loading part suppliers...');
        const suppliers = await getAllPartSuppliers();
        console.log('Suppliers loaded:', suppliers);

        const parts = await getParts('', '', '');
        console.log('Parts loaded:', parts);

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
        // 加载供应商档案（Logo等）
        try {
          const profs = await getSupplierProfiles();
          const pmap: Record<string, any> = {};
          profs.forEach((p: any) => { pmap[p.supplier_name] = p; });
          setProfiles(pmap);
        } catch (e) { console.error('加载供应商档案失败:', e); }
      } else {
        // 加载整机供应商数据
        console.log('Loading project suppliers...');
        const projects = await getProjects();
        console.log('Projects loaded:', projects);
        setAllProjects(projects);

        // 获取所有整机供应商
        const allProjectSuppliers: ProjectSupplier[] = [];
        for (const project of projects) {
          const suppliers = await getProjectSuppliers(project.id!);
          allProjectSuppliers.push(...suppliers);
        }
        console.log('Project suppliers loaded:', allProjectSuppliers);
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
      const part = parts.find(p => p.id === s.part_id);
      if (!part) return;

      if (!map[s.supplier_name]) {
        map[s.supplier_name] = {
          supplierName: s.supplier_name,
          partCount: 0,
          mainCategories: [],
          parts: []
        };
      }

      map[s.supplier_name].partCount++;

      // 记录涉及的大类（去重）
      if (!map[s.supplier_name].mainCategories.includes(part.main_category)) {
        map[s.supplier_name].mainCategories.push(part.main_category);
      }

      map[s.supplier_name].parts.push({
        partId: part.id,
        partName: part.name,
        partModel: part.model || '',
        mainCategory: part.main_category,
        subCategory: part.sub_category || '',
        price: s.price || 0,
        shareRatio: s.share_ratio || 0,
        supplierId: s.id!,
        supplierName: s.supplier_name
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

  // 查看供应商详情
  const showSupplierDetail = (supplier: SupplierMapItem) => {
    setSelectedSupplier(supplier);
    setDetailModalOpen(true);
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

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}><HomeOutlined /> 供应商管理</h2>
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
                添加方式：在<b>「项目管理」→ 项目详情 → 🏭 整机供应商</b>标签页中为该项目的 ODM 工厂录入报价与份额，此处自动汇总展示。
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
          {
            key: 'map',
            label: <span><AppstoreOutlined /> 供应商地图</span>,
            children: supplierType === 'part' ? (
              <div>
                {filteredSupplierMap.length === 0 ? (
                  <Empty description="暂无数据" />
                ) : (
                  (() => {
                    // 按大类分组供应商
                    const groupedByCategory: Record<string, SupplierMapItem[]> = {};

                    filteredSupplierMap.forEach(supplier => {
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
                                        {supplier.mainCategories.length > 1 && (
                                          <div style={{ marginBottom: 4 }}>
                                            涉及 {supplier.mainCategories.length} 个大类
                                          </div>
                                        )}
                                        点击查看详情
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
              <DataTable tableId="sup_detail"
                dataSource={detailListData}
                rowKey="id"
                size="small"
                loading={loading}
                pagination={{ pageSize: 20 }}
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
                        <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showPriceHistory(record.part_id, record.supplier_name)} />
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
            ) : (
              <DataTable tableId="sup_odm_list"
                dataSource={projectSupplierListData}
                rowKey="id"
                size="small"
                loading={loading}
                pagination={{ pageSize: 20 }}
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
                        <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showPriceHistory(record.part_id, record.supplier_name)} />
                      </Space>
                    )
                  }
                ]}
              />
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
                    💡 ODM 供应商的报价、份额、报价历史在「项目管理 → 项目详情 → 🏭 整机供应商」中维护，此处自动汇总。
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

      {/* 供应商详情弹窗 */}
      <Modal
        title={<span><ShopOutlined /> {selectedSupplier?.supplierName}</span>}
        open={detailModalOpen}
        onCancel={() => setDetailModalOpen(false)}
        width={800}
        footer={null}
      >
        {selectedSupplier && (
          <div>
            <div style={{ marginBottom: 15, fontSize: 13, color: '#666' }}>
              供货器件数量：<strong>{selectedSupplier.partCount}</strong> 个
            </div>
            <DataTable tableId="sup_detail_parts"
              dataSource={selectedSupplier.parts}
              rowKey="supplierId"
              size="small"
              pagination={false}
              columns={[
                { title: '大类', dataIndex: 'mainCategory', width: 100, render: (v: string) => <Tag color={getCategoryColor(v)}>{v}</Tag> },
                { title: '子类', dataIndex: 'subCategory', width: 100 },
                { title: '器件名称', dataIndex: 'partName', ellipsis: true },
                { title: '型号', dataIndex: 'partModel', width: 120, ellipsis: true },
                { title: '价格(¥)', dataIndex: 'price', width: 100, align: 'right', render: (v: number) => <span style={{ fontFamily: 'monospace' }}>¥{v.toFixed(2)}</span> },
                { title: '份额', dataIndex: 'shareRatio', width: 80, render: (v: number) => `${v}%` },
                {
                  title: '操作',
                  width: 80,
                  render: (_: any, record: any) => (
                    <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => showPriceHistory(record.partId, record.supplierName)} />
                  )
                }
              ]}
            />
          </div>
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
            <Input placeholder="输入供应商名称" />
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
