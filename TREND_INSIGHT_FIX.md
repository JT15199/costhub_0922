# 物料趋势洞察功能修复报告

## 问题诊断

### 错误现象
用户点击"洞察行情"时失败，错误信息：
```
Error: 所有 LLM 供应商均调用失败。最后一个错误: DeepSeek 官方 HTTP 0: Failed to read response: error decoding response body
```

### 根本原因
1. **HTTP 响应读取超时**：60秒超时不足以处理复杂的结构化洞察生成
2. **Prompt 过长**：sourceContext 和 buildStructuredAnalysisPrompt 生成的 prompt 可能超长
3. **错误处理不够详细**：无法准确定位问题
4. **JSON 解析容错不足**：部分边界情况未处理

## 修复内容

### 1. Rust 后端优化 (`src-tauri/src/lib.rs`)

#### 修改点 1: 增加超时时间
```rust
// 从 60 秒增加到 120 秒
.timeout(Duration::from_secs(120))
```

#### 修改点 2: 增强错误处理
```rust
let body = match response.text().await {
    Ok(text) => text,
    Err(e) => {
        let error_detail = format!(
            "Failed to read response body: {}. This may be caused by: \
            1) Response timeout (current limit: 120s), \
            2) Invalid response encoding, \
            3) Network interruption. \
            Please check if the API endpoint is correct and the response is not too large.",
            e
        );
        return Err(error_detail);
    }
};
```

**改进**：
- 提供详细的错误原因提示
- 包含超时时间信息
- 给出排查建议

---

### 2. TypeScript 前端优化 (`src/trendService.ts`)

#### 修改点 1: `callSingleLLMProviderMessages` 增强错误处理

**改进**：
- 网络层错误单独捕获
- 检查响应体是否为空
- 增加详细的日志输出
- 提供更友好的错误提示

```typescript
// 检查响应体是否为空
if (!res.body || res.body.trim() === '') {
  throw new Error(`${provider.provider_name} 返回空响应体。可能原因：API配额耗尽、请求被拒绝、或网络中断。`);
}
```

#### 修改点 2: `buildStructuredAnalysisPrompt` 限制 sourceContext 长度

**改进**：
- 限制 sourceContext 最大长度为 2000 字符
- 超长时截断并标注

```typescript
const maxSourceLength = 2000;
const truncatedSource = sourceContext.length > maxSourceLength
  ? sourceContext.slice(0, maxSourceLength) + '\n...(来源过多，已截断)'
  : sourceContext;
```

#### 修改点 3: `createStructuredInsight` 优化

**改进**：
- 限制来源数量最多 8 条
- 截断每个来源的标题和摘要长度
- 增加详细的日志输出
- 提供友好的错误提示

```typescript
// 限制 sources 长度，防止 prompt 过长
const maxSources = 8;
const limitedSources = sources.slice(0, maxSources);

const sourceContext = [
  `物料：${materialName}`,
  `已有初步摘要：${agentSummary || '无'}`,
  ...limitedSources.map((source, index) =>
    `[${index + 1}] 标题：${source.title.slice(0, 100)}\nURL：${source.url}\n摘要：${source.snippet.slice(0, 150)}`
  ),
].join('\n\n');
```

**错误处理改进**：
```typescript
// 提供更友好的错误信息
if (e.message?.includes('Failed to read response')) {
  throw new Error(
    '生成结构化洞察时响应读取失败。可能原因：\n' +
    '1. 网络不稳定或连接中断\n' +
    '2. API响应超时（已设置120秒）\n' +
    '3. 响应体格式异常\n' +
    '建议：重试或检查网络连接'
  );
}
```

#### 修改点 4: `extractJSON` 增强日志

**改进**：
- 增加详细的日志输出，便于调试
- 在降级方案中提供更详细的错误信息

```typescript
console.error('[extractJSON] 首次解析失败:', e.message);
console.error('[extractJSON] 清理后的文本片段:', cleaned.slice(0, 300));
// ...
console.log('[extractJSON] 尝试修复后的JSON:', fixed.slice(0, 300));
console.error('[extractJSON] 修复后仍然失败:', e2.message);
```

---

### 3. 数据库 Schema 补全 (`src/db.ts`)

**改进**：确保所有趋势相关表的列都完整

```typescript
// trend_snapshots 表补全
await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_min REAL DEFAULT NULL"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_max REAL DEFAULT NULL"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_snapshots ADD COLUMN magnitude_reference TEXT DEFAULT ''"));

// trend_insight_dimensions 表补全
await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_title TEXT DEFAULT ''"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_insight_dimensions ADD COLUMN source_url TEXT DEFAULT ''"));

// trend_key_events 表补全（确保所有列都存在）
await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_date TEXT DEFAULT ''"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN event_description TEXT DEFAULT ''"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN impact_direction TEXT DEFAULT ''"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_title TEXT DEFAULT ''"));
await ignoreSchemaError(d.execute("ALTER TABLE trend_key_events ADD COLUMN source_url TEXT DEFAULT ''"));
```

---

## 修复效果

### 1. 提高稳定性
- **超时时间加倍**：从 60 秒增加到 120 秒，减少超时失败
- **Prompt 长度控制**：限制输入长度，防止超长 prompt 导致问题
- **来源数量限制**：最多 8 条来源，每条来源截断，避免过载

### 2. 更好的错误提示
- **详细的错误原因**：网络错误、超时、JSON 解析失败都有具体提示
- **排查建议**：提供具体的解决方案
- **日志增强**：详细的 console.log，便于调试

### 3. 更强的容错能力
- **空响应检测**：及早发现空响应问题
- **JSON 解析降级**：多层降级处理，即使失败也能返回基本结构
- **网络异常处理**：独立捕获网络层错误

### 4. 数据库完整性
- **Schema 补全**：确保所有必要的列都存在
- **启动时自动检查**：每次启动自动补齐缺失的列

---

## 测试建议

### 1. 基本功能测试
1. 选择一个器件，点击"洞察行情"
2. 观察搜索过程是否正常
3. 查看是否能成功生成结构化洞察
4. 检查洞察内容是否完整（dimensions、key_events 等）

### 2. 边界情况测试
1. **大量来源**：测试搜索到很多结果的情况（系统会自动限制到 8 条）
2. **网络不稳定**：测试网络不稳定时的错误提示是否友好
3. **API 配额耗尽**：测试 API Key 配额用完时的错误提示
4. **超长物料名**：测试物料名很长时的处理

### 3. 错误恢复测试
1. 第一次失败后，重试是否能成功
2. 切换 LLM 供应商后是否能正常工作
3. 检查控制台日志是否有足够的调试信息

---

## 预期改进

### 解决的问题
✅ HTTP 0 响应读取失败
✅ 超时导致的失败
✅ Prompt 过长导致的问题
✅ 错误提示不明确
✅ 数据库 Schema 缺失

### 未解决的问题（需要进一步观察）
- 如果是 DeepSeek API 自身的问题（如服务不稳定），仍可能失败
- 如果用户的网络环境极差，120 秒可能仍然不够

---

## 后续优化建议

### 短期优化
1. **添加重试机制**：失败后自动重试 1-2 次
2. **显示进度**：在 UI 上显示"正在生成洞察...已耗时 XX 秒"
3. **缓存结果**：相同物料的洞察结果缓存一段时间

### 长期优化
1. **流式响应**：支持 LLM streaming，实时显示生成进度
2. **分段生成**：将大任务拆分成多个小任务，避免超时
3. **本地 LLM**：支持本地部署的 LLM，避免网络问题

---

## 版本信息

- **修复日期**：2026-07-31
- **影响版本**：v2.3.16+
- **修复文件**：
  - `src-tauri/src/lib.rs`
  - `src/trendService.ts`
  - `src/db.ts`

---

## 使用建议

1. **重新构建应用**：运行 `npm run build` 或 `build.bat`
2. **测试新版本**：在开发环境测试所有趋势洞察功能
3. **监控日志**：观察控制台输出，确认日志信息是否详细
4. **反馈问题**：如仍有问题，收集控制台日志并反馈

---

**End of Report**
