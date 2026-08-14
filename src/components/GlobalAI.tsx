import { useEffect, useState } from 'react';
import { Modal, Input, Button, message } from 'antd';
import { RobotOutlined, SaveOutlined } from '@ant-design/icons';
import { getProjectBOMs, getTargets, getSetting, saveWorkLog, localNow } from '../db';
import { startOllamaStream, logLocalAICall } from '../ollama';

// 全局 AI 问询（v2.3.19）：
// - 数据安全硬边界：只有本地模型（Ollama）可读取项目上下文，云端模型不接本地数据
// - 上下文：当前页面 + 选中项目 BOM 摘要（由各页面写入 localStorage costhub-ctx）
// - 回答可一键记入工作手账（带项目标签）

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GlobalAI({ open, onClose }: Props) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [ctx, setCtx] = useState('');
  const [ctxLoading, setCtxLoading] = useState(false);

  const buildContext = async (): Promise<string> => {
    const parts: string[] = [];
    try {
      const c = JSON.parse(localStorage.getItem('costhub-ctx') || 'null');
      if (c?.page === 'projects' && c.projectId) {
        parts.push(`当前页面：项目管理，选中项目「${c.code || c.projectId}」`);
        const [boms, targets] = await Promise.all([getProjectBOMs(c.projectId), getTargets(c.projectId)]);
        const byMod: Record<string, number> = {};
        boms.forEach((b: any) => { const m = b.module_name || '未归类'; byMod[m] = (byMod[m] || 0) + (b.part_cost || 0) * (b.quantity || 1); });
        const bomTotal = boms.reduce((s: number, b: any) => s + (b.part_cost || 0) * (b.quantity || 1), 0);
        parts.push(`BOM 共 ${boms.length} 项，总成本 ¥${bomTotal.toFixed(2)}`);
        parts.push('模块成本：' + Object.entries(byMod).map(([m, v]) => `${m} ¥${(v as number).toFixed(2)}`).join('、'));
        if (targets.length > 0) parts.push('目标成本：' + targets.map((t: any) => `${t.domain} ¥${Number(t.target_cost).toFixed(2)}`).join('、'));
      } else {
        parts.push(`当前页面：${c?.page || '仪表盘'}`);
      }
    } catch { parts.push('当前页面：未知'); }
    return parts.join('\n');
  };

  useEffect(() => {
    if (!open) return;
    setQuestion(''); setAnswer(''); setLoading(false);
    setCtxLoading(true);
    buildContext().then(t => { setCtx(t); setCtxLoading(false); });
  }, [open]);

  const send = async () => {
    if (!question.trim() || loading) return;
    setLoading(true);
    setAnswer('');
    try {
      const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
      const model = await getSetting('local_ai_model', '');
      if (!model) throw new Error('未配置本地模型');
      let full = '';
      await new Promise<void>((resolve, reject) => {
        startOllamaStream(url, model,
          [{ role: 'system', content: '你是嵌入 CostHub 成本管理工具的 AI 助手。回答用户问题时，成本数据只能用提供的上下文，不能编造；数据不足就说明不足。用简洁中文回答。' },
           { role: 'user', content: `当前上下文：\n${ctx}\n\n问题：${question}` }],
          t => { full += t; setAnswer(full); },
          () => {}, () => resolve(), e => reject(new Error(e)),
          { endpoint: 'native', json: false, think: false, num_predict: 700, temperature: 0.4 },
        );
      });
      logLocalAICall({
        request_type: 'global_ask',
        material_name: question.slice(0, 30),
        system_prompt: '你是嵌入 CostHub 成本管理工具的 AI 助手。回答用户问题时，成本数据只能用提供的上下文，不能编造；数据不足就说明不足。用简洁中文回答。',
        user_prompt: '当前上下文：' + ctx + '\n\n问题：' + question,
        response_summary: full.slice(0, 200),
        success: true,
        model_name: model,
      });
    } catch (e: any) {
      setAnswer(`（本地模型不可用：${e?.message || e}。全局问询需在「本地 AI 助手」页配置 Ollama——只有本地模型可以读取项目数据；云端模型按数据安全原则不接入本地数据。）`);
    }
    setLoading(false);
  };

  const saveToWorkLog = async () => {
    if (!answer.trim()) return;
    try {
      const c = JSON.parse(localStorage.getItem('costhub-ctx') || 'null');
      await saveWorkLog({
        log_date: localNow(),
        title: `AI 问询：${question.slice(0, 30)}${question.length > 30 ? '…' : ''}`,
        content: `问：${question}\n答：${answer}`,
        category: 'AI问询', tags: '', work_project: c?.code || '', is_todo: 0, done: 0,
      } as any);
      message.success('已记入工作手账');
    } catch (e: any) { message.error(`保存失败：${e?.message || e}`); }
  };

  return (
    <Modal
      title={<span><RobotOutlined style={{ color: '#0A84FF', marginRight: 8 }} />AI 问询（本地模型，读取当前上下文）</span>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnClose
    >
      <div style={{ marginBottom: 10, padding: '8px 10px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 11.5, color: '#64748B', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>
        <b>当前上下文：</b>
        {ctxLoading ? '加载中…' : ctx || '（无）'}
      </div>
      <Input.TextArea
        value={question}
        onChange={e => setQuestion(e.target.value)}
        placeholder="例如：这个项目的成本结构有什么问题？哪些模块最贵？"
        autoSize={{ minRows: 2, maxRows: 5 }}
        disabled={loading}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button type="primary" icon={<RobotOutlined />} loading={loading} onClick={send} disabled={!question.trim()}>发送</Button>
        {answer && !loading && (
          <Button icon={<SaveOutlined />} onClick={saveToWorkLog}>记入工作手账</Button>
        )}
      </div>
      {answer && (
        <div style={{ marginTop: 12, padding: '10px 12px', background: '#F0F7FF', border: '1px solid #BFDBFE', borderRadius: 8, fontSize: 13, lineHeight: 1.8, color: '#1E293B', whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto' }}>
          {answer}
        </div>
      )}
    </Modal>
  );
}
