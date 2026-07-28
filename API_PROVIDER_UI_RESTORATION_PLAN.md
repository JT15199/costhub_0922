# API供应商管理UI恢复计划

## 已完成的工作

### 1. 数据库层 ✅
- ✅ `src-tauri/src/lib.rs`: 添加了 `api_providers` 表的 migration (version 4)
- ✅ `src/db.ts`: 添加了完整的CRUD函数：
  - `getAllApiProviders()`
  - `getApiProvidersByType(type)`
  - `getActiveApiProviders(type)`
  - `addApiProvider(data)`
  - `updateApiProvider(data)`
  - `deleteApiProvider(id)`
  - `toggleApiProviderActive(id, isActive)`

### 2. 类型定义 ✅
- ✅ `src/types.ts`: 添加了 `ApiProvider` 接口

### 3. 预置供应商 ✅
- ✅ `src/constants.ts`: 
  - `PRESET_SEARCH_PROVIDERS` (7个搜索服务)
  - `PRESET_LLM_PROVIDERS` (10个大模型服务)

## 需要实现的UI部分

### Settings.tsx 需要添加的内容

基于costhub2.exe截图，Settings页面应包含：

#### 1. 页面结构
```tsx
<Tabs defaultActiveKey="providers">
  <TabPane tab="🔗 供应商管理" key="providers">
    <Tabs defaultActiveKey="search">
      <TabPane tab={`🔍 搜索服务 (${searchProviders.length})`} key="search">
        {/* 搜索服务列表 */}
      </TabPane>
      <TabPane tab={`🤖 大模型服务 (${llmProviders.length})`} key="llm">
        {/* 大模型服务列表 */}
      </TabPane>
      <TabPane tab={`🧠 分析记忆 (${memoryItems.length})`} key="memory">
        {/* 分析记忆列表（已有） */}
      </TabPane>
    </Tabs>
  </TabPane>
</Tabs>
```

#### 2. 供应商卡片组件
每个供应商显示为一个卡片，包含：

**卡片头部：**
- 供应商名称 + 使用次数统计（如"0"，"未启用"，"已启用"）
- 状态标签（"未填Key"、"未启用"、"预置"）
- 右侧操作按钮：编辑、删除、添加

**卡片内容：**
- 🔑 Key状态：`未填Key` 或 `已加密` (显示为 `Key: ["sa•••••••••ml"]`)
- 🔗 Base URL: `https://api.example.com`
- 📦 模型名称: `model-name` (仅大模型)
- 💡 免费额度说明
- 🔗 注册链接（可点击打开浏览器）

**卡片底部：**
- 启用/禁用开关（Toggle）
- 编辑按钮
- 删除按钮
- 添加按钮（克隆配置）

#### 3. 编辑/添加对话框

**对话框字段（按截图顺序）：**

```tsx
<Modal title={editing ? "编辑供应商" : "添加供应商"} visible={modalVisible}>
  <Form>
    <Form.Item label="供应商名称" required>
      <Input placeholder="如：DeepSeek 官方" />
    </Form.Item>

    <Form.Item label="类型">
      <Select>
        <Option value="search">🔍 搜索</Option>
        <Option value="llm">🤖 大模型</Option>
      </Select>
    </Form.Item>

    <Form.Item label="API Key（留空不变，新填则加密存储）">
      <Input.Password 
        placeholder="sk-••••••••••••••••••••" 
        visibilityToggle 
      />
    </Form.Item>

    <Form.Item label="Base URL">
      <Input placeholder="https://api.example.com" />
    </Form.Item>

    {providerType === 'llm' && (
      <Form.Item label="模型名称">
        <Input placeholder="deepseek-v4-pro" />
      </Form.Item>
    )}

    <Form.Item label="免费额度说明（选填）">
      <Input.TextArea 
        placeholder="注册即送500万tokens，按量计费极低，以官网为准"
        rows={2}
      />
    </Form.Item>

    <Form.Item label="注册链接（选填）">
      <Input placeholder="https://platform.example.com" />
    </Form.Item>
  </Form>

  <div style={{ textAlign: 'right' }}>
    <Button onClick={handleCancel}>取消</Button>
    <Button type="primary" onClick={handleOk}>确定</Button>
  </div>
</Modal>
```

#### 4. 预置供应商快速添加

在每个tab顶部添加一个下拉框：

```tsx
<Select 
  placeholder="从预置模板添加..." 
  style={{ width: 300 }}
  onSelect={handleAddFromPreset}
>
  {PRESET_SEARCH_PROVIDERS.map(p => (
    <Option key={p.provider_name} value={p.provider_name}>
      {p.provider_name}
    </Option>
  ))}
</Select>
<Button type="primary" icon={<PlusOutlined />} onClick={handleAddNew}>
  添加
</Button>
```

#### 5. 核心功能逻辑

```tsx
const Settings = () => {
  const [searchProviders, setSearchProviders] = useState<ApiProvider[]>([]);
  const [llmProviders, setLlmProviders] = useState<ApiProvider[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing] = useState<ApiProvider | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    const search = await getApiProvidersByType('search');
    const llm = await getApiProvidersByType('llm');
    setSearchProviders(search);
    setLlmProviders(llm);
  };

  const handleAddFromPreset = async (providerName: string, type: 'search' | 'llm') => {
    const presets = type === 'search' ? PRESET_SEARCH_PROVIDERS : PRESET_LLM_PROVIDERS;
    const preset = presets.find(p => p.provider_name === providerName);
    if (!preset) return;

    form.setFieldsValue({
      provider_name: preset.provider_name,
      provider_type: type,
      base_url: preset.base_url,
      model_name: preset.model_name || '',
      monthly_quota_note: preset.monthly_quota_note,
      registration_url: preset.registration_url,
      is_preset: true,
    });
    setModalVisible(true);
  };

  const handleSave = async (values: any) => {
    if (editing) {
      await updateApiProvider({ ...editing, ...values });
      message.success('更新成功');
    } else {
      await addApiProvider(values);
      message.success('添加成功');
    }
    setModalVisible(false);
    loadProviders();
  };

  const handleDelete = async (id: number) => {
    await deleteApiProvider(id);
    message.success('删除成功');
    loadProviders();
  };

  const handleToggleActive = async (id: number, isActive: boolean) => {
    await toggleApiProviderActive(id, !isActive);
    loadProviders();
  };

  // 打开注册链接
  const handleOpenUrl = (url: string) => {
    if (!url) return;
    window.open(url, '_blank');
  };

  // ...render
};
```

#### 6. 样式提示

**卡片样式：**
- 使用 `<Card>` 组件，设置 `hoverable` 和 `bordered`
- 启用状态的卡片：左边框绿色高亮
- 未启用状态：灰色背景
- 预置供应商：右上角有"预置"标签

**Key显示：**
- 如果有key：显示前2个字符 + 省略号 + 后2个字符
- 例如：`sk-1234...abcd`
- 使用 `<Typography.Text code>` 组件

**状态指示：**
- 未填Key：红色 `<Tag color="red">未填Key</Tag>`
- 已填Key但未启用：橙色 `<Tag color="orange">未启用</Tag>`
- 已启用：绿色 `<Tag color="green">已启用</Tag>`
- 预置：蓝色 `<Tag color="blue">预置</Tag>`

## 测试清单

完成后需要测试：

- [ ] 可以从预置模板添加供应商
- [ ] 可以手动添加供应商
- [ ] 可以编辑供应商（Key留空时保留原Key）
- [ ] 可以删除供应商
- [ ] 可以启用/禁用供应商
- [ ] 注册链接可以用浏览器打开
- [ ] Key显示为加密格式（不完整显示）
- [ ] 搜索服务和大模型服务正确分类显示
- [ ] 统计数字正确（显示各类别数量）

## 参考截图说明

根据costhub2.exe的截图：
- 搜索服务有8个（Tavily、Serper、Brave Search、Bocha、Bing、SearchAPI、DuckDuckGo、Exa）
- 大模型服务有13个（DeepSeek、硅基流动、智谱GLM、Kimi、DashScope、火山引擎、腾讯混元、百度文心、Groq等）
- 每个服务卡片宽度大约占1/3行，一行3个
- 卡片间距适中，有阴影效果

## 下一步工作

1. **优先级1**: 在Settings.tsx中实现供应商管理UI（本文档）
2. **优先级2**: 在Decomposition.tsx中恢复React Flow物料分解树
3. **优先级3**: 在TrendInsight.tsx中恢复趋势洞察功能

## 开发提示

- 使用 Ant Design 的 `Card`, `Modal`, `Form`, `Switch`, `Tag` 组件
- Key加密存储在后端，前端只做显示处理
- 注册链接使用 `window.open(url, '_blank')` 打开
- 删除操作需要确认对话框 `Popconfirm`
- 所有异步操作要有 loading 状态和错误处理
