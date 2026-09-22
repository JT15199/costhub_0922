import { useCallback, useEffect, useState } from 'react';
import { AutoComplete, Button, Form, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { getSupplierCategories, getSupplierCategoryMap, getSupplierResources, saveSupplierProfile, setSupplierCategories } from '../db/suppliers';
import { CHINA_CITY_LOCATIONS, CHINA_PROVINCE_CENTERS } from '../data/chinaLocationIndex';

type Resource = Awaited<ReturnType<typeof getSupplierResources>>[number];
const provinceOptions = Object.keys(CHINA_PROVINCE_CENTERS).map(value => ({ value }));
const cityOptions = [...new Set(CHINA_CITY_LOCATIONS.map(item => item.city))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(value => ({ value }));
export function SupplierNameInput({ value, onChange, placeholder = '从资源池选择或输入新供应商', style, size, id }: { value?: string; onChange?: (value: string) => void; placeholder?: string; style?: React.CSSProperties; size?: 'small' | 'middle' | 'large'; id?: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => { getSupplierResources().then(rows => { setNames(rows.map(row => row.supplier_name)); setFailed(false); }).catch(() => setFailed(true)); }, []);
  useEffect(() => { load(); window.addEventListener('costhub-suppliers-changed', load); return () => window.removeEventListener('costhub-suppliers-changed', load); }, [load]);
  return <AutoComplete id={id} value={value} onChange={onChange} onFocus={load} onBlur={() => { if (value && value !== value.trim()) onChange?.(value.trim()); }} allowClear size={size} style={{ width: '100%', ...style }} placeholder={failed ? '资源池加载失败，仍可手动输入' : placeholder} options={names.map(value => ({ value }))} filterOption={(input, option) => String(option?.value || '').toLocaleLowerCase().includes(input.toLocaleLowerCase())} />;
}

export default function SupplierResourcePool() {
  const [rows, setRows] = useState<Resource[]>([]), [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(''), [editing, setEditing] = useState<Resource | null | undefined>(undefined), [saving, setSaving] = useState(false);
  const [categoryDict, setCategoryDict] = useState<string[]>([]), [categoryMap, setCategoryMap] = useState<Record<string, string[]>>({});
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, dict, links] = await Promise.all([getSupplierResources(), getSupplierCategories(), getSupplierCategoryMap()]);
      setRows(list); setCategoryDict(dict); setCategoryMap(links);
    } catch { message.error('供应商资源池加载失败，请重试'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const open = (row: Resource | null) => {
    setEditing(row);
    form.resetFields();
    if (row) form.setFieldsValue({ ...row, product_categories: categoryMap[row.supplier_name] || [] });
    else form.setFieldsValue({ product_categories: [] });
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      const name = values.supplier_name.trim();
      if (!name) { message.warning('请输入供应商名称'); return; }
      if (!editing && (await getSupplierResources()).some(row => row.supplier_name === name)) { message.warning('该供应商已在资源池中，请编辑已有档案'); return; }
      setSaving(true);
      const { product_categories: productCategories, ...profile } = values;
      await saveSupplierProfile({ ...profile, supplier_name: name });
      await setSupplierCategories(name, Array.isArray(productCategories) ? productCategories : []);
      setEditing(undefined); window.dispatchEvent(new Event('costhub-suppliers-changed')); await load(); message.success('供应商档案已保存');
    } catch (error: any) { if (!error?.errorFields) message.error(`保存失败：${String(error?.message || error)}`); }
    finally { setSaving(false); }
  };
  return <div>
    <Space wrap style={{ marginBottom: 12 }}><Button type="primary" onClick={() => open(null)}>新增供应商资源</Button><Input.Search allowClear aria-label="搜索供应商资源" placeholder="搜索名称、供货范围或联系人" value={search} onChange={event => setSearch(event.target.value)} style={{ width: 280 }} /><Button onClick={() => void load()}>刷新资源池</Button></Space>
    <p style={{ color: 'var(--color-text-secondary)' }}>先建供应商档案，整机、器件及报价导入时均可选择；也可直接输入新名称，保存业务记录后自动纳入此池。档案本身不代表已有报价或合作关系。</p>
    <Table<Resource> size="small" rowKey="supplier_name" loading={loading} scroll={{ x: 1080 }} pagination={{ pageSize: 12, showSizeChanger: true }} dataSource={rows.filter(row => [row.supplier_name, row.category, row.contact, row.phone, row.address, row.province, row.city].join(' ').toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))} columns={[
      { title: '供应商名称', dataIndex: 'supplier_name' }, { title: '供货范围', dataIndex: 'category', render: value => value || '待补充' },
      { title: '供应品类', dataIndex: 'supplier_name', render: (name: string) => (categoryMap[name] || []).length ? (categoryMap[name] || []).map(category => <Tag key={category} color="blue">{category}</Tag>) : <span style={{ color: '#999' }}>待补充</span> },
      { title: '已有记录', dataIndex: 'sources', render: (sources: string[]) => sources.map(source => <Tag key={source}>{source}</Tag>) },
      { title: '省 / 市', render: (_, row) => [row.province, row.city].filter(Boolean).join(' / ') || '待补充' },
      { title: '地址', dataIndex: 'address', ellipsis: true, render: value => value || '待补充' },
      { title: '联系人', dataIndex: 'contact' }, { title: '联系电话', dataIndex: 'phone' }, { title: '备注', dataIndex: 'remark', ellipsis: true },
      { title: '操作', render: (_, row) => <Button size="small" onClick={() => open(row)}>编辑档案</Button> },
    ]} />
    <Modal open={editing !== undefined} title={editing ? '编辑供应商档案' : '新增供应商资源'} onCancel={() => { if (!saving) setEditing(undefined); }} onOk={() => void save()} confirmLoading={saving} okText="保存供应商" cancelText="取消">
      <Form form={form} layout="vertical"><Form.Item name="supplier_name" label="供应商名称" rules={[{ required: true, whitespace: true }]} extra={editing ? '名称用于关联现有业务记录，此处保留原名称。' : undefined}><Input disabled={!!editing} maxLength={100} /></Form.Item>
        <Form.Item name="category" label="供货范围"><AutoComplete options={['整机 / ODM', '器件', '整机及器件'].map(value => ({ value }))} placeholder="可选择或填写具体供货范围" /></Form.Item>
        <Form.Item name="product_categories" label="供应品类" extra="按产品品类区分（地图可据此筛选）；可直接输入新增品类，多个品类用回车分隔。">
          <Select mode="tags" placeholder="如：显示器、鼠标、手写笔" options={categoryDict.map(value => ({ value }))} tokenSeparators={[',', '，', '、']} />
        </Form.Item>
        <Form.Item name="province" label="省 / 直辖市 / 自治区"><AutoComplete options={provinceOptions} placeholder="如：广东省 / 广东" /></Form.Item>
        <Form.Item name="city" label="城市"><AutoComplete options={cityOptions} placeholder="如：深圳市 / 深圳" /></Form.Item>
        <Form.Item name="address" label="详细地址"><Input placeholder="保存后按省市自动关联地图；填写区县地址可更精确" /></Form.Item>
        <Form.Item name="contact" label="联系人"><Input /></Form.Item><Form.Item name="phone" label="联系电话"><Input /></Form.Item><Form.Item name="remark" label="备注"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}
