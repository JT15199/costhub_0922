import { useEffect, useState, useRef } from 'react';
import {
  Button, Space, Alert, message, Spin, Descriptions, Modal, Tag, Empty, Select, Input, Tooltip,
  Card, Row, Col, Switch, Tabs, Form, Popconfirm, Table, Checkbox, InputNumber,
} from 'antd';
import {
  ApiOutlined, CheckCircleOutlined, DeleteOutlined, EditOutlined,
  LinkOutlined, SafetyCertificateOutlined, CloudServerOutlined, ThunderboltOutlined,
  PlusOutlined, DragOutlined, CheckOutlined, CloseOutlined, KeyOutlined,
  StopOutlined, HistoryOutlined,
} from '@ant-design/icons';
import { testSearchConnection, testLLMConnection, BUILTIN_SKILLS, loadSkillConfig, saveSkillConfig, getSkill, SkillTemplate } from '../trendService';
import {
  getApiProviders, saveApiProvider, deleteApiProvider, setActiveProvider,
  PRESET_PROVIDERS, updateProviderPriorities,
  getAllChecklistWithLogs, updateChecklistActive, deleteAnalysisChecklistItem,
} from '../db';
import { encryptText } from '../apiConfig';

const STRENGTH_COLORS: Record<string, string> = {
  'observing': '#94A3B8',
  'active': '#3B82F6',
  'stable': '#8B5CF6',
};
const STRENGTH_LABELS: Record<string, string> = {
  'observing': '观察中',
  'active': '已生效',
  'stable': '稳定记忆',
};

export default function Settings(_props: any) {
  const [loading, setLoading] = useState(true);
  const [testingSearch, setTestingSearch] = useState(false);
  const [testingLLM, setTestingLLM] = useState(false);
  const [llmTestResult, setLLMTestResult] = useState<any>(null);
  const [searchTestResult, setSearchTestResult] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('search');
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [dragId, setDragId] = useState<number | null>(null);
  const dragOverId = useRef<number | null>(null);
  // 请求日志
  const [requestLogs, setRequestLogs] = useState<any[]>([]);
  const loadRequestLogs = async () => {
    try {
      const { getOutboundRequestLogs } = await import('../db');
      setRequestLogs(await getOutboundRequestLogs());
    } catch { }
  };
  useEffect(() => { loadRequestLogs(); }, []);

  // Skill config
  const [skillConfig, setSkillConfig] = useState(loadSkillConfig());
  const [skillEditOpen, setSkillEditOpen] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<SkillTemplate | null>(null);
  const [createCustomSkillOpen, setCreateCustomSkillOpen] = useState(false);
  const [newCustomSkill, setNewCustomSkill] = useState<SkillTemplate>({
    id: '',
    name: '',
    description: '',
    icon: '📊',
    systemPrompt: '',
    searchQueries: [],
    maxSearchRounds: 2,
    outputDimensions: []
  });

  // 分析记忆
  const [memoryItems, setMemoryItems] = useState<any[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logData, setLogData] = useState<any[]>([]);

  const loadMemoryItems = async () => {
    setMemoryLoading(true);
    try { setMemoryItems(await getAllChecklistWithLogs()); } catch { }
    setMemoryLoading(false);
  };

  const handleToggleMemory = async (id: number, current: boolean) => {
    await updateChecklistActive(id, current ? 0 : 1);
    message.success(current ? '已暂停该记忆' : '已恢复该记忆');
    loadMemoryItems();
  };

  const handleDeleteMemory = async (id: number) => {
    await deleteAnalysisChecklistItem(id);
    message.success('已删除');
    loadMemoryItems();
  };

  const showMemoryLogs = (logs: any[]) => {
    setLogData(logs || []);
    setLogModalOpen(true);
  };

  const loadProviders = async () => {
    try { setProviders(await getApiProviders()); } catch (e) { console.error(e); }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadProviders();
      await loadMemoryItems();
      setLoading(false);
    })();
  }, []);

  const searchProviders = providers.filter((p: any) => p.provider_type === 'search');
  const llmProviders = providers.filter((p: any) => p.provider_type === 'llm');

  // 拖拽排序
  const handleDragStart = (id: number) => { setDragId(id); };
  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    dragOverId.current = id;
  };
  const handleDragEnd = async (type: string) => {
    if (dragId === null || dragOverId.current === null || dragId === dragOverId.current) {
      setDragId(null); dragOverId.current = null; return;
    }
    const list = type === 'search' ? [...searchProviders] : [...llmProviders];
    const fromIdx = list.findIndex(p => p.id === dragId);
    const toIdx = list.findIndex(p => p.id === dragOverId.current);
    if (fromIdx === -1 || toIdx === -1) { setDragId(null); dragOverId.current = null; return; }
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    const orderedIds = list.map(p => p.id);
    await updateProviderPriorities(orderedIds);
    await loadProviders();
    setDragId(null); dragOverId.current = null;
    message.success('排序已更新');
  };

  // 激活/停用
  const handleToggleActive = async (provider: any) => {
    if (provider.is_active) {
      // 停用
      await saveApiProvider({ ...provider, is_active: 0 });
      message.info(`已停用「${provider.provider_name}」`);
    } else {
      await setActiveProvider(provider.provider_type, provider.id);
      message.success(`已启用「${provider.provider_name}」`);
    }
    loadProviders();
  };

  const handleDeleteProvider = async (id: number) => {
    await deleteApiProvider(id);
    message.success('已删除');
    loadProviders();
  };

  const handleSaveProvider = async () => {
    if (!editingProvider?.provider_name) { message.warning('请输入供应商名称'); return; }
    const data = { ...editingProvider };
    const looksEncrypted = data.api_key && data.api_key.startsWith('{') && data.api_key.includes('"salt"');
    if (data.api_key && data.api_key.length > 0 && !looksEncrypted) {
      try {
        data.api_key = await encryptText(data.api_key);
      } catch (e: any) {
        message.warning('Key 加密失败，将以明文存储（不推荐）');
      }
    }
    await saveApiProvider(data);
    message.success('已保存');
    setProviderModalOpen(false);
    setEditingProvider(null);
    loadProviders();
  };

  const openEditProvider = async (provider: any) => {
    if (provider.api_key && provider.api_key.startsWith('{')) {
      try {
        const { decryptText } = await import('../apiConfig');
        const decrypted = await decryptText(provider.api_key);
        setEditingProvider({ ...provider, api_key: decrypted });
      } catch { setEditingProvider({ ...provider, api_key: '' }); }
    } else {
      setEditingProvider({ ...provider });
    }
    setProviderModalOpen(true);
  };

  // 从预置模板添加
  const handleAddFromPreset = () => {
    if (!selectedPreset) { message.warning('请先选择一个供应商模板'); return; }
    const preset = PRESET_PROVIDERS.find(p => p.provider_name === selectedPreset);
    if (!preset) { message.warning('未找到该模板'); return; }
    const alreadyAdded = providers.some(
      (p: any) => p.provider_name === preset.provider_name && p.provider_type === preset.provider_type
    );
    if (alreadyAdded) { message.warning(`「${preset.provider_name}」已在列表中`); return; }

    setEditingProvider({
      provider_type: preset.provider_type,
      provider_name: preset.provider_name,
      api_key: '',
      base_url: preset.base_url || '',
      model_name: preset.model_name || '',
      priority: preset.priority || 50,
      is_preset: 0,
      monthly_quota_note: preset.monthly_quota_note || '',
      registration_url: preset.registration_url || '',
    });
    setProviderModalOpen(true);
    setSelectedPreset('');
  };

  const handleTestSearch = async () => {
    setTestingSearch(true);
    const result = await testSearchConnection();
    setSearchTestResult(result);
    if (result.success) { message.success('搜索 API 测试通过！'); } else { message.error(`搜索测试失败: ${result.detail || result.message}`); }
    setTestingSearch(false);
  };

  const handleTestLLM = async () => {
    setTestingLLM(true);
    setLLMTestResult(null);
    const result = await testLLMConnection();
    setLLMTestResult(result);
    if (result.success) { message.success('LLM API 测试通过！'); } else { message.error(`LLM测试失败: ${result.detail || result.message}`); }
    setTestingLLM(false);
  };

  const maskKey = (key: string) => {
    if (!key || key.length < 8) return '未配置';
    return key.slice(0, 4) + '••••••••' + key.slice(-4);
  };

  const renderProviderCard = (provider: any) => {
    const isDrag = dragId === provider.id;
    const hasKey = provider.api_key && provider.api_key.length > 10;
    return (
      <div
        key={provider.id}
        draggable
        onDragStart={() => handleDragStart(provider.id)}
        onDragOver={(e) => handleDragOver(e, provider.id)}
        onDragEnd={() => handleDragEnd(activeTab)}
        style={{ opacity: isDrag ? 0.4 : 1, cursor: 'grab' }}
      >
        <Card
          size="small"
          style={{
            marginBottom: 8,
            border: provider.is_active ? '2px solid var(--brand)' : '1px solid var(--card-border)',
            background: provider.is_active ? 'var(--brand-light)' : 'var(--card-bg)',
          }}
          actions={[
            <Tooltip title={provider.is_active ? '停用' : '启用'} key="toggle">
              <Switch
                size="small"
                checked={!!provider.is_active}
                onChange={() => handleToggleActive(provider)}
                checkedChildren={<CheckOutlined />}
                unCheckedChildren={<CloseOutlined />}
              />
            </Tooltip>,
            <Tooltip title="编辑" key="edit">
              <EditOutlined onClick={() => openEditProvider(provider)} />
            </Tooltip>,
            <Tooltip title="删除" key="del">
              <DeleteOutlined onClick={() => {
                Modal.confirm({
                  title: `删除供应商「${provider.provider_name}」？`,
                  content: '该操作不可恢复。',
                  okType: 'danger',
                  onOk: () => handleDeleteProvider(provider.id),
                });
              }} />
            </Tooltip>,
            <Tooltip title="拖拽排序" key="drag">
              <DragOutlined style={{ cursor: 'grab', color: 'var(--text-muted)' }} />
            </Tooltip>,
          ]}
        >
          <Card.Meta
            title={
              <Space>
                <span>{provider.provider_name}</span>
                {provider.is_active && <Tag color="green" style={{ fontSize: 10 }}>已启用</Tag>}
                {!provider.is_active && <Tag style={{ fontSize: 10 }}>未启用</Tag>}
                {provider.is_preset ? <Tag style={{ fontSize: 9 }}>预置</Tag> : null}
              </Space>
            }
            description={
              <div style={{ fontSize: 12, lineHeight: '1.8' }}>
                <div>
                  <KeyOutlined style={{ marginRight: 4 }} />
                  <Tag color={hasKey ? 'green' : 'red'} style={{ fontSize: 10 }}>
                    {hasKey ? '已加密' : '未填 Key'}
                  </Tag>
                </div>
                {provider.base_url && (
                  <div style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <ApiOutlined style={{ marginRight: 4 }} />
                    {provider.base_url}
                  </div>
                )}
                {provider.model_name && (
                  <div><ThunderboltOutlined style={{ marginRight: 4 }} />{provider.model_name}</div>
                )}
                {provider.monthly_quota_note && (
                  <div style={{ color: '#8B5CF6', fontSize: 11 }}>
                    💡 {provider.monthly_quota_note}
                  </div>
                )}
                {provider.registration_url && (
                  <div>
                    <a href={provider.registration_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                      <LinkOutlined /> 注册链接
                    </a>
                  </div>
                )}
                {hasKey && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Key: {maskKey(provider.api_key)}</div>
                )}
              </div>
            }
          />
        </Card>
      </div>
    );
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;

  const presetOptions = PRESET_PROVIDERS.map(p => ({
    value: p.provider_name,
    label: `${p.provider_type === 'search' ? '🔍' : '🤖'} ${p.provider_name}  —  ${p.monthly_quota_note}`,
  }));

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
      {/* 页面标题 */}
      <div style={{
        marginBottom: 32,
        paddingBottom: 16,
        borderBottom: '2px solid #e5e7eb'
      }}>
        <h1 style={{
          fontSize: 28,
          fontWeight: 600,
          margin: 0,
          color: '#111827',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}>
          <span style={{ fontSize: 32 }}>⚙️</span>
          系统设置
        </h1>
        <p style={{
          margin: '8px 0 0 44px',
          color: '#6b7280',
          fontSize: 14
        }}>
          配置API服务、分析框架和系统行为
        </p>
      </div>

      {/* 顶部提示卡片 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 16,
        marginBottom: 32
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: 12,
          padding: 20,
          color: 'white',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <CloudServerOutlined style={{ fontSize: 24 }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>工作模式</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.95 }}>
            按需手动触发查询，无自动定时任务
          </div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
          borderRadius: 12,
          padding: 20,
          color: 'white',
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <SafetyCertificateOutlined style={{ fontSize: 24 }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>隐私保护</div>
          </div>
          <div style={{ fontSize: 13, opacity: 0.95 }}>
            仅发送物料名称，不上传价格、供应商等敏感数据
          </div>
        </div>
      </div>

      {/* ====== 供应商管理 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{
              fontSize: 20,
              fontWeight: 600,
              margin: 0,
              color: '#111827',
              display: 'flex',
              alignItems: 'center',
              gap: 10
            }}>
              <ApiOutlined style={{ color: '#8b5cf6' }} />
              供应商管理
            </h2>
            <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
              配置搜索引擎和LLM服务，支持多供应商降级
            </p>
          </div>
          <Space size="middle">
            <Select
              showSearch
              placeholder="从预置模板添加..."
              value={selectedPreset || undefined}
              onChange={setSelectedPreset}
              style={{ width: 280 }}
              options={presetOptions}
              filterOption={(input, option) =>
                (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
              }
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleAddFromPreset}
              style={{
                borderRadius: 8,
                height: 36
              }}
            >
              添加
            </Button>
          </Space>
        </div>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'search',
              label: `🔍 搜索服务 (${searchProviders.length})`,
              children: (
                <div>
                  {searchProviders.length === 0 ? (
                    <Empty description="暂无搜索服务供应商，请从上方下拉选择模板添加" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Row gutter={[12, 0]}>
                      {searchProviders.map(p => (
                        <Col key={p.id} xs={24} sm={12} lg={8}>
                          {renderProviderCard(p)}
                        </Col>
                      ))}
                    </Row>
                  )}
                </div>
              ),
            },
            {
              key: 'llm',
              label: `🤖 大模型服务 (${llmProviders.length})`,
              children: (
                <div>
                  {llmProviders.length === 0 ? (
                    <Empty description="暂无大模型服务供应商，请从上方下拉选择模板添加" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <Row gutter={[12, 0]}>
                      {llmProviders.map(p => (
                        <Col key={p.id} xs={24} sm={12} lg={8}>
                          {renderProviderCard(p)}
                        </Col>
                      ))}
                    </Row>
                  )}
                </div>
              ),
            },
            {
              key: 'memory',
              label: `🧠 分析记忆 (${memoryItems.length})`,
              children: (
                <div>
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
                    系统自动记录您在不同物料洞察分析中反复追问的角度。当某一类追问出现3次以上时，该角度自动纳入后续洞察查询的提示词。
                  </p>
                  {memoryLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spin /></div>
                  ) : memoryItems.length === 0 ? (
                    <Empty description="暂无分析记忆，使用洞察追问功能后会自动生成" style={{ marginTop: 60 }} />
                  ) : (
                    <>
                      <Row gutter={[12, 12]}>
                        {memoryItems.map((item: any) => (
                          <Col key={item.id} xs={24} sm={12} lg={8}>
                            <Card
                              size="small"
                              style={{
                                border: item.is_active ? `1px solid ${STRENGTH_COLORS[item.strength_level] || '#94A3B8'}` : '1px solid #E2E8F0',
                                opacity: item.is_active ? 1 : 0.5,
                              }}
                              actions={[
                                <Switch key="toggle" size="small" checked={!!item.is_active}
                                  onChange={() => handleToggleMemory(item.id, !!item.is_active)}
                                  checkedChildren={<CheckCircleOutlined />}
                                  unCheckedChildren={<StopOutlined />}
                                />,
                                <Button key="logs" type="link" size="small" icon={<HistoryOutlined />}
                                  onClick={() => showMemoryLogs(item.trigger_logs || [])} disabled={!(item.trigger_logs || []).length}>
                                  日志
                                </Button>,
                                <Popconfirm key="del" title="删除此记忆？" onConfirm={() => handleDeleteMemory(item.id)}>
                                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                                </Popconfirm>,
                              ]}
                            >
                              <Card.Meta
                                title={
                                  <Space>
                                    <span style={{ fontSize: 13 }}>{item.item_description}</span>
                                    <Tag color={STRENGTH_COLORS[item.strength_level]} style={{ fontSize: 9 }}>
                                      {STRENGTH_LABELS[item.strength_level] || item.strength_level}
                                    </Tag>
                                  </Space>
                                }
                                description={
                                  <div style={{ fontSize: 11, lineHeight: '1.8' }}>
                                    <div>触发次数：{item.trigger_count} 次</div>
                                    {item.first_triggered_at && <div>首次：{item.first_triggered_at.slice(0, 16)}</div>}
                                    {item.last_triggered_at && <div>最近：{item.last_triggered_at.slice(0, 16)}</div>}
                                    {!item.is_active && <Tag color="red" style={{ fontSize: 10 }}>已暂停</Tag>}
                                    {item.strength_level === 'stable' && <Tag color="purple" style={{ fontSize: 10 }}>⚡ 稳定记忆</Tag>}
                                  </div>
                                }
                              />
                            </Card>
                          </Col>
                        ))}
                      </Row>
                      <Card size="small" style={{ marginTop: 20 }}>
                        <Descriptions column={1} size="small" title="📖 强度分级说明" style={{ fontSize: 12 }}>
                          <Descriptions.Item label={<Tag color="#94A3B8">观察中</Tag>}>1-2次触发，记录但不影响分析</Descriptions.Item>
                          <Descriptions.Item label={<Tag color="#3B82F6">已生效</Tag>}>3-4次触发，已自动纳入分析提示</Descriptions.Item>
                          <Descriptions.Item label={<Tag color="#8B5CF6">稳定记忆</Tag>}>5次以上触发，权重较高的稳定模式</Descriptions.Item>
                        </Descriptions>
                      </Card>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button size="small" onClick={handleTestLLM} loading={testingLLM} icon={<CheckCircleOutlined />}>
            测试 LLM 连接
          </Button>
          <Button size="small" onClick={handleTestSearch} loading={testingSearch} icon={<ApiOutlined />}>
            测试搜索连接
          </Button>
        </div>

        {/* 测试结果详情 */}
        {llmTestResult && (
          <Alert
            type={llmTestResult.success ? 'success' : 'error'}
            showIcon
            message={`LLM 测试：${llmTestResult.success ? '通过 ✅' : '失败 ❌'}`}
            description={llmTestResult.detail ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 150, overflow: 'auto' }}>
                {llmTestResult.detail}
              </div>
            ) : llmTestResult.message}
            style={{ marginTop: 12 }}
            closable
            onClose={() => setLLMTestResult(null)}
          />
        )}
        {searchTestResult && (
          <Alert
            type={searchTestResult.success ? 'success' : 'error'}
            showIcon
            message={`搜索测试：${searchTestResult.success ? '通过 ✅' : '失败 ❌'}`}
            description={searchTestResult.detail ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 150, overflow: 'auto' }}>
                {searchTestResult.detail}
              </div>
            ) : searchTestResult.message}
            style={{ marginTop: 12 }}
            closable
            onClose={() => setSearchTestResult(null)}
          />
        )}
      </div>

      {/* ====== 供应商编辑弹窗 ====== */}
      <Modal title={editingProvider?.id ? '编辑供应商' : '添加供应商'} open={providerModalOpen}
        onCancel={() => { setProviderModalOpen(false); setEditingProvider(null); }} onOk={handleSaveProvider} width={500}>
        {editingProvider && (
          <Form layout="vertical" size="small">
            <Form.Item label="供应商名称" required>
              <Input value={editingProvider.provider_name} onChange={e => setEditingProvider({ ...editingProvider, provider_name: e.target.value })} />
            </Form.Item>
            <Form.Item label="类型">
              <Select value={editingProvider.provider_type} onChange={v => setEditingProvider({ ...editingProvider, provider_type: v })}>
                <Select.Option value="search">🔍 搜索</Select.Option>
                <Select.Option value="llm">🤖 大模型</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item label="API Key（留空不变，新填则加密存储）">
              <Input.Password value={editingProvider.api_key || ''} onChange={e => setEditingProvider({ ...editingProvider, api_key: e.target.value })} placeholder="API Key" />
            </Form.Item>
            <Form.Item label="Base URL">
              <Input value={editingProvider.base_url || ''} onChange={e => setEditingProvider({ ...editingProvider, base_url: e.target.value })} placeholder="https://api.example.com/v1/chat/completions" />
            </Form.Item>
            {editingProvider.provider_type === 'llm' && (
              <Form.Item label="模型名称">
                <Input value={editingProvider.model_name || ''} onChange={e => setEditingProvider({ ...editingProvider, model_name: e.target.value })} placeholder="如：deepseek-chat" />
              </Form.Item>
            )}
            <Form.Item label="免费额度说明（选填）">
              <Input value={editingProvider.monthly_quota_note || ''} onChange={e => setEditingProvider({ ...editingProvider, monthly_quota_note: e.target.value })} />
            </Form.Item>
            <Form.Item label="注册链接（选填）">
              <Input value={editingProvider.registration_url || ''} onChange={e => setEditingProvider({ ...editingProvider, registration_url: e.target.value })} placeholder="https://..." />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* ====== 分析 Skill 配置 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 600,
            margin: 0,
            color: '#111827',
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}>
            <ThunderboltOutlined style={{ color: '#f59e0b' }} />
            分析 Skill 配置
          </h2>
          <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
            选择洞察时使用的Skill框架（可多选）。不同Skill从不同维度搜索和分析
          </p>
        </div>

        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16
          }}>
            <div style={{
              fontWeight: 500,
              color: '#374151',
              fontSize: 15
            }}>
              激活的分析框架
            </div>
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => {
                setNewCustomSkill({
                  id: `custom_${Date.now()}`,
                  name: '',
                  description: '',
                  icon: '📊',
                  systemPrompt: '',
                  searchQueries: [],
                  maxSearchRounds: 2,
                  outputDimensions: []
                });
                setCreateCustomSkillOpen(true);
              }}
              style={{ borderRadius: 6 }}
            >
              创建自定义Skill
            </Button>
          </div>
          <Checkbox.Group
            value={skillConfig.activeSkillIds}
            onChange={ids => {
              const n = { ...skillConfig, activeSkillIds: ids as string[] };
              setSkillConfig(n);
              saveSkillConfig(n);
            }}
            style={{ width: '100%' }}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
              gap: 12
            }}>
              {/* 内置Skill */}
              {BUILTIN_SKILLS.filter(s => s.id !== 'custom').map(s => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '16px 20px',
                    background: '#f9fafb',
                    borderRadius: 12,
                    border: '2px solid transparent',
                    transition: 'all 0.2s',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.background = '#eff6ff';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'transparent';
                    e.currentTarget.style.background = '#f9fafb';
                  }}
                >
                  <Checkbox value={s.id} style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{s.icon}</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{s.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.description}</div>
                      </div>
                    </div>
                  </Checkbox>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditingSkillId(s.id);
                      setEditingSkill(getSkill(s.id));
                      setSkillEditOpen(true);
                    }}
                    style={{
                      borderRadius: 6,
                      marginLeft: 12
                    }}
                  >
                    编辑
                  </Button>
                </div>
              ))}

              {/* 自定义Skill */}
              {skillConfig.customSkills.map(s => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '16px 20px',
                    background: '#fef3c7',
                    borderRadius: 12,
                    border: '2px solid #fbbf24',
                    transition: 'all 0.2s',
                    cursor: 'pointer'
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = '#f59e0b';
                    e.currentTarget.style.background = '#fef08a';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = '#fbbf24';
                    e.currentTarget.style.background = '#fef3c7';
                  }}
                >
                  <Checkbox value={s.id} style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 20 }}>{s.icon}</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {s.name}
                          <Tag color="orange" style={{ fontSize: 10, margin: 0 }}>自定义</Tag>
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.description}</div>
                      </div>
                    </div>
                  </Checkbox>
                  <Space size="small">
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingSkillId(s.id);
                        setEditingSkill(s);
                        setSkillEditOpen(true);
                      }}
                      style={{ borderRadius: 6 }}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="确定删除这个自定义Skill？"
                      onConfirm={() => {
                        const newCustomSkills = skillConfig.customSkills.filter(cs => cs.id !== s.id);
                        const newActiveIds = skillConfig.activeSkillIds.filter(id => id !== s.id);
                        const n = { ...skillConfig, customSkills: newCustomSkills, activeSkillIds: newActiveIds };
                        setSkillConfig(n);
                        saveSkillConfig(n);
                        message.success('已删除');
                      }}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} style={{ borderRadius: 6 }}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              ))}
            </div>
          </Checkbox.Group>
        </div>
      </div>

      {/* ====== 创建自定义Skill弹窗 ====== */}
      <Modal
        title="创建自定义Skill"
        open={createCustomSkillOpen}
        onCancel={() => setCreateCustomSkillOpen(false)}
        width={900}
        footer={[
          <Button key="cancel" onClick={() => setCreateCustomSkillOpen(false)}>
            取消
          </Button>,
          <Button key="save" type="primary" onClick={() => {
            if (!newCustomSkill.name || !newCustomSkill.description) {
              message.error('请填写名称和描述');
              return;
            }
            const n = {
              ...skillConfig,
              customSkills: [...skillConfig.customSkills, newCustomSkill]
            };
            setSkillConfig(n);
            saveSkillConfig(n);
            setCreateCustomSkillOpen(false);
            message.success('自定义Skill已创建');
          }}>
            创建
          </Button>,
        ]}
      >
        <Tabs
          defaultActiveKey="basic"
          items={[
            {
              key: 'basic',
              label: '基础信息',
              children: (
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>名称 *</label>
                    <Input
                      value={newCustomSkill.name}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, name: e.target.value })}
                      placeholder="Skill名称"
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>图标</label>
                    <Input
                      value={newCustomSkill.icon}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, icon: e.target.value })}
                      placeholder="输入emoji图标，如：📊"
                      maxLength={2}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>描述 *</label>
                    <Input.TextArea
                      rows={2}
                      value={newCustomSkill.description}
                      onChange={e => setNewCustomSkill({ ...newCustomSkill, description: e.target.value })}
                      placeholder="Skill描述"
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>搜索轮数</label>
                    <InputNumber
                      min={1}
                      max={3}
                      value={newCustomSkill.maxSearchRounds}
                      onChange={v => setNewCustomSkill({ ...newCustomSkill, maxSearchRounds: v || 1 })}
                      style={{ width: 120 }}
                    />
                  </div>
                </div>
              ),
            },
            {
              key: 'search',
              label: '搜索关键词',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    定义搜索时使用的关键词模板，每行一个
                  </div>
                  <Input.TextArea
                    rows={8}
                    value={newCustomSkill.searchQueries?.join('\n') || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, searchQueries: e.target.value.split('\n').filter(q => q.trim()) })}
                    placeholder="价格 走势&#10;成本 分析&#10;供需 库存"
                  />
                </div>
              ),
            },
            {
              key: 'dimensions',
              label: '输出维度',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    定义洞察结果的输出维度，每行一个
                  </div>
                  <Input.TextArea
                    rows={8}
                    value={newCustomSkill.outputDimensions?.join('\n') || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, outputDimensions: e.target.value.split('\n').filter(d => d.trim()) })}
                    placeholder="核心因子&#10;市场动态&#10;趋势预测"
                  />
                </div>
              ),
            },
            {
              key: 'advanced',
              label: '高级设置',
              children: (
                <div>
                  <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                    自定义System Prompt（可选）。留空则使用系统默认模板
                  </div>
                  <Input.TextArea
                    rows={12}
                    value={newCustomSkill.systemPrompt || ''}
                    onChange={e => setNewCustomSkill({ ...newCustomSkill, systemPrompt: e.target.value })}
                    placeholder="留空使用默认模板..."
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
              ),
            },
          ]}
        />
      </Modal>

      {/* ====== Skill编辑弹窗 ====== */}
      <Modal
        title={`编辑 Skill: ${editingSkill?.name || ''}`}
        open={skillEditOpen}
        onCancel={() => setSkillEditOpen(false)}
        width={900}
        footer={[
          // 只有内置Skill才显示"恢复默认"按钮
          editingSkillId && !editingSkillId.startsWith('custom_') ? (
            <Button key="reset" onClick={() => {
              if (!editingSkillId) return;
              const config = loadSkillConfig();
              const newOverrides = { ...config.skillOverrides };
              delete newOverrides[editingSkillId];
              const n = { ...config, skillOverrides: newOverrides };
              setSkillConfig(n);
              saveSkillConfig(n);
              setEditingSkill(BUILTIN_SKILLS.find(s => s.id === editingSkillId)!);
              message.success('已恢复默认配置');
            }}>
              恢复默认
            </Button>
          ) : null,
          <Button key="save" type="primary" onClick={() => {
            if (!editingSkillId || !editingSkill) return;

            // 判断是内置Skill还是自定义Skill
            if (editingSkillId.startsWith('custom_')) {
              // 更新自定义Skill
              const newCustomSkills = skillConfig.customSkills.map(s =>
                s.id === editingSkillId ? editingSkill : s
              );
              const n = { ...skillConfig, customSkills: newCustomSkills };
              setSkillConfig(n);
              saveSkillConfig(n);
            } else {
              // 更新内置Skill的覆盖配置
              const override: Partial<SkillTemplate> = {
                name: editingSkill.name,
                description: editingSkill.description,
                searchQueries: editingSkill.searchQueries,
                maxSearchRounds: editingSkill.maxSearchRounds,
                outputDimensions: editingSkill.outputDimensions,
                systemPrompt: editingSkill.systemPrompt,
              };
              const n = { ...skillConfig, skillOverrides: { ...skillConfig.skillOverrides, [editingSkillId]: override } };
              setSkillConfig(n);
              saveSkillConfig(n);
            }

            setSkillEditOpen(false);
            message.success('已保存');
          }}>
            保存
          </Button>,
        ]}
      >
        {editingSkill && (
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: 'basic',
                label: '基础信息',
                children: (
                  <div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>名称</label>
                      <Input
                        value={editingSkill.name}
                        onChange={e => setEditingSkill({ ...editingSkill, name: e.target.value })}
                        placeholder="Skill名称"
                      />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>描述</label>
                      <Input.TextArea
                        rows={2}
                        value={editingSkill.description}
                        onChange={e => setEditingSkill({ ...editingSkill, description: e.target.value })}
                        placeholder="Skill描述"
                      />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>搜索轮数</label>
                      <InputNumber
                        min={1}
                        max={3}
                        value={editingSkill.maxSearchRounds}
                        onChange={v => setEditingSkill({ ...editingSkill, maxSearchRounds: v || 1 })}
                        style={{ width: 120 }}
                      />
                      <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b' }}>
                        搜索轮数越多，信息越全面，但耗时和成本也更高
                      </span>
                    </div>
                  </div>
                ),
              },
              {
                key: 'search',
                label: '搜索关键词',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      定义搜索时使用的关键词模板，每行一个。支持占位符如：价格、趋势、供应商等
                    </div>
                    <Input.TextArea
                      rows={8}
                      value={editingSkill.searchQueries?.join('\n') || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, searchQueries: e.target.value.split('\n').filter(q => q.trim()) })}
                      placeholder="价格 走势 涨跌&#10;原材料 成本&#10;供需 库存&#10;政策 影响"
                    />
                  </div>
                ),
              },
              {
                key: 'dimensions',
                label: '输出维度',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      定义洞察结果的输出维度，每行一个。这些维度将按顺序出现在最终报告中
                    </div>
                    <Input.TextArea
                      rows={8}
                      value={editingSkill.outputDimensions?.join('\n') || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, outputDimensions: e.target.value.split('\n').filter(d => d.trim()) })}
                      placeholder="供给因子&#10;需求因子&#10;成本因子&#10;金融与政策因子&#10;展望"
                    />
                  </div>
                ),
              },
              {
                key: 'advanced',
                label: '高级设置',
                children: (
                  <div>
                    <div style={{ marginBottom: 8, fontSize: 13, color: '#64748b' }}>
                      自定义System Prompt（可选）。留空则使用系统默认的提示词模板
                    </div>
                    <Input.TextArea
                      rows={12}
                      value={editingSkill.systemPrompt || ''}
                      onChange={e => setEditingSkill({ ...editingSkill, systemPrompt: e.target.value })}
                      placeholder="留空使用默认模板。如需自定义，可以在这里输入完整的System Prompt..."
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <div style={{ marginTop: 8, padding: 8, background: '#f0f9ff', borderRadius: 4, fontSize: 12 }}>
                      💡 提示：自定义System Prompt仅在需要完全控制提示词时使用。通常只需修改上面的"输出维度"和"搜索关键词"即可
                    </div>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Modal>

      {/* ====== Logo 自定义 ====== */}
      <div style={{
        background: 'white',
        borderRadius: 16,
        padding: 32,
        marginBottom: 24,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)'
      }}>
        <div style={{ marginBottom: 24 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 600,
            margin: 0,
            color: '#111827',
            display: 'flex',
            alignItems: 'center',
            gap: 10
          }}>
            <SafetyCertificateOutlined style={{ color: '#10b981' }} />
            Logo 自定义
          </h2>
          <p style={{ margin: '4px 0 0 34px', color: '#6b7280', fontSize: 13 }}>
            上传自定义Logo，支持PNG、SVG等格式
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{
            width: 80,
            height: 80,
            borderRadius: 12,
            background: '#f3f4f6',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            border: '2px solid #e5e7eb'
          }}>
            {(() => {
              const savedLogo = localStorage.getItem('costhub_custom_logo');
              return savedLogo ? (
                <img src={savedLogo} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <div style={{ fontSize: 32, fontWeight: 600, color: '#6b7280' }}>CH</div>
              );
            })()}
          </div>

          <div>
            <input
              type="file"
              accept="image/*,.svg"
              id="logo-upload"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;

                if (file.size > 1024 * 1024) {
                  message.error('文件大小不能超过1MB');
                  return;
                }

                const reader = new FileReader();
                reader.onload = (event) => {
                  const dataUrl = event.target?.result as string;
                  localStorage.setItem('costhub_custom_logo', dataUrl);
                  message.success('Logo已更新，刷新页面生效');
                  setTimeout(() => window.location.reload(), 1000);
                };
                reader.readAsDataURL(file);
              }}
            />
            <Space>
              <Button
                icon={<PlusOutlined />}
                onClick={() => document.getElementById('logo-upload')?.click()}
              >
                上传Logo
              </Button>
              <Button
                onClick={() => {
                  localStorage.removeItem('costhub_custom_logo');
                  message.success('已恢复默认Logo，刷新页面生效');
                  setTimeout(() => window.location.reload(), 1000);
                }}
              >
                恢复默认
              </Button>
            </Space>
            <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
              支持 PNG、JPG、SVG 等格式，建议尺寸 256x256px，大小不超过 1MB
            </div>
          </div>
        </div>
      </div>

      {/* ====== 外部请求日志 ====== */}
      <div className="content-card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>📡 外部请求日志</h3>
          <Space>
            <Button size="small" icon={<ApiOutlined />} onClick={loadRequestLogs}>刷新</Button>
            <Popconfirm title="清空所有日志？" onConfirm={async () => {
              const { clearOutboundRequestLogs } = await import('../db');
              await clearOutboundRequestLogs();
              message.success('已清空');
              setRequestLogs([]);
            }}>
              <Button size="small" icon={<DeleteOutlined />}>清空</Button>
            </Popconfirm>
          </Space>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12 }}>
          记录所有已发出的外部查询请求。仅发送物料通用名称，不包含价格/供应商等本地数据。用户可自行验证。
        </p>
        {requestLogs.length === 0 ? (
          <Empty description="暂无外部请求记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table dataSource={requestLogs} rowKey="id" size="small" pagination={{ pageSize: 10 }}
            columns={[
              { title: '时间', dataIndex: 'requested_at', width: 150, render: (v: string) => v?.slice(0, 16) || '-' },
              { title: '关键词', dataIndex: 'query_keyword', ellipsis: true, width: 160 },
              { title: '类型', dataIndex: 'provider_type', width: 70, render: (v: string) => <Tag color={v === 'search' ? 'blue' : 'purple'}>{v === 'search' ? '搜索' : 'LLM'}</Tag> },
              { title: '供应商', dataIndex: 'provider_name', width: 120 },
              { title: '关联物料', dataIndex: 'related_component_name', width: 120 },
              { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v === 'success' ? '✅成功' : '❌失败'}</Tag> },
            ]} />
        )}
      </div>

      {/* ====== 配置说明 ====== */}
      <div className="content-card">
        <h3>📖 配置说明</h3>
        <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
          <Descriptions.Item label="存储安全">
            API Key 使用 AES-GCM 加密后存储于本地数据库中，同一设备可解密，不同设备无法解密。
          </Descriptions.Item>
          <Descriptions.Item label="数据发送范围">
            趋势查询时仅向外部 API 发送物料的通用名称，不发送采购价/供应商/BOM等内部数据。
          </Descriptions.Item>
          <Descriptions.Item label="费用说明">
            各供应商免费额度以官网为准。预置列表中已标注参考额度，实际可能有变动。
          </Descriptions.Item>
        </Descriptions>
      </div>

      {/* ====== 分析记忆触发日志模态框 ====== */}
      <Modal title="触发日志" open={logModalOpen} onCancel={() => setLogModalOpen(false)} footer={null} width={600}>
        {logData.length === 0 ? <Empty description="暂无日志" /> : (
          <Table dataSource={logData} rowKey="id" size="small" pagination={false}
            columns={[
              { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => v?.slice(0, 16) || '-' },
              { title: '追问原文', dataIndex: 'question_snippet', ellipsis: true },
            ]} />
        )}
      </Modal>
    </div>
  );
}
