// AI 使用指南（v2.3.19，2026-08-18 用户：AI 界面做简单，用法集中在这提示）
// 一站式：连接状态 + 示例提问（点击复制）+ 23 个工具清单（分组）+ 功能用法入口
import { useEffect, useState } from 'react';
import { Modal, Tag, Button, Tooltip, message } from 'antd';
import { RobotOutlined, SettingOutlined, CopyOutlined, ExperimentOutlined, CalculatorOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { getAllApiProviders, getSetting } from '../db';
import { listTools } from '../aiTools';
import DataReadiness from './DataReadiness';

interface Props { open: boolean; onClose: () => void; onOpenSettings: () => void; }

const EXAMPLES: { label: string; prompt: string; note: string; icon: any }[] = [
  { label: '审价', prompt: '帮我审这份报价：27寸面板 ¥610、主控板 ¥185、电源适配器 ¥42…', note: 'AI 读 Excel + quote_review 逐项判定合理/偏高/虚高', icon: <ThunderboltOutlined /> },
  { label: '降本', prompt: '分析 M270 为什么贵、哪里能降本', note: 'AI 调体检+成本工具后自己推理', icon: <ExperimentOutlined /> },
  { label: '对标', prompt: '对比竞品 A 和 M270 的 BOM 成本差异', note: 'AI 调竞品BOM+项目BOM 逐规格分析', icon: <RobotOutlined /> },
  { label: '原声', prompt: '查这款显示器原声里用户最在意什么', note: 'AI 调 query_voice_dims', icon: <RobotOutlined /> },
  { label: '行情', prompt: '查液晶面板近期市场行情', note: '云端调用需底部横幅确认', icon: <ThunderboltOutlined /> },
  { label: '目标', prompt: '给我下达一个目标：把 M270 整机成本降到 ¥900', note: 'AI 调 add_goal，自主分析优先推进', icon: <ExperimentOutlined /> },
  { label: '待办', prompt: '把"去谈驱动板价格"记成待办', note: 'AI 调 create_todo 写入工作手账', icon: <CopyOutlined /> },
  { label: '算数', prompt: '算一下 (520*1+185*2)*1.05 是多少', note: 'AI 调 calc 核验，不口算', icon: <CalculatorOutlined /> },
];

const GROUPS: { title: string; match: (id: string) => boolean; color: string }[] = [
  { title: '📊 数据查询（16）', match: id => id.startsWith('query_') || id === 'compare_subcategory_cost', color: 'blue' },
  { title: '🔍 分析（2）', match: id => id === 'quote_review' || id === 'insight_material_trend', color: 'purple' },
  { title: '📄 文件/导入（1）', match: id => id === 'read_excel', color: 'green' },
  { title: '🧮 计算/工具（2）', match: id => id === 'calc' || id === 'now', color: 'cyan' },
  { title: '✅ 做事/行动（2）', match: id => id === 'create_todo' || id === 'add_goal', color: 'orange' },
];

export default function AIUsageGuide({ open, onClose, onOpenSettings }: Props) {
  const [llmReady, setLlmReady] = useState(false);
  const [llmName, setLlmName] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [tools, setTools] = useState<{ id: string; name: string; desc: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const providers = await getAllApiProviders();
        const active = providers.find((p: any) => p.provider_type === 'llm' && p.is_active && p.api_key);
        setLlmReady(!!active);
        setLlmName(active?.provider_name || '');
        setLocalModel(await getSetting('local_ai_model', ''));
      } catch { }
    })();
    try { setTools(listTools().map(t => ({ id: t.id, name: t.name, desc: t.desc }))); } catch { }
  }, [open]);

  const copyPrompt = (p: string) => {
    try { navigator.clipboard.writeText(p); message.success('已复制提问，去「本地 AI 助手」对话里粘贴即可'); }
    catch { message.info(p); }
  };

  return (
    <Modal
      title={<span><RobotOutlined style={{ color: '#0A84FF', marginRight: 8 }} />AI 使用指南</span>}
      open={open} onCancel={onClose} width={760} footer={null}
    >
      <div style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 6 }}>
        {/* 1. 连接状态 */}
        <div style={{ fontSize: 12, color: '#475569', background: '#F8FAFC', border: '1px solid #E8ECF1', borderRadius: 8, padding: '8px 12px', marginBottom: 12, lineHeight: 1.7 }}>
          {localModel ? <Tag color="green">本地模型已配置：{localModel}</Tag> : <Tag color="orange">未配置本地模型</Tag>}
          {llmReady ? <Tag color="green">云端已就绪：{llmName}</Tag> : <Tag color="default">云端未配置</Tag>}
          <span style={{ marginLeft: 8, color: '#94A3B8' }}>本地模型是大脑（离线分析），云端仅查行情（需确认）</span>
        </div>

        {/* 1.5 数据就绪度：缺什么数据 → 能做到什么样 → 建议补什么（引导客户如何使用） */}
        <div style={{ marginBottom: 14 }}>
          <DataReadiness onAskAi={() => {
            onClose();
            window.dispatchEvent(new CustomEvent('costhub-open-ai-prompt'));
          }} />
        </div>

        {/* 2. 怎么用（示例提问） */}
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>💬 怎么用（直接复制提问，到「本地 AI 助手」对话里粘贴，AI 会自动调用工具）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {EXAMPLES.map((e, i) => (
            <div key={i} className="sp-suggest-card" style={{ width: 'calc(50% - 4px)', minWidth: 300, padding: '8px 10px' }} onClick={() => copyPrompt(e.prompt)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12 }}>{e.icon}</span>
                <b style={{ fontSize: 12 }}>{e.label}</b>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: '#0A84FF' }}>复制</span>
              </div>
              <div style={{ fontSize: 11.5, color: '#334155', marginTop: 3, lineHeight: 1.5 }}>{e.prompt}</div>
              <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 3 }}>{e.note}</div>
            </div>
          ))}
        </div>

        {/* 3. 工具清单 */}
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🧰 可调用工具（{tools.length} 个，AI 在对话/自主分析里自主使用）</div>
        {GROUPS.map((g, gi) => {
          const items = tools.filter(t => g.match(t.id));
          if (items.length === 0) return null;
          return (
            <div key={gi} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, color: '#475569', fontWeight: 600, marginBottom: 4 }}>{g.title}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {items.map(t => (
                  <Tooltip key={t.id} title={t.desc}>
                    <Tag color={g.color} style={{ margin: 0, cursor: 'default', fontSize: 11 }}>{t.name}</Tag>
                  </Tooltip>
                ))}
              </div>
            </div>
          );
        })}

        {/* 4. 功能入口 */}
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🗂️ 常用功能入口（数据密集型操作在页面里做，AI 对话做分析）</div>
        <div style={{ fontSize: 12, color: '#475569', lineHeight: 2 }}>
          · <b>用户原声分析</b>：导入上代原声 → AI 分析卖点/模块价值 → 指导下一代定义（AI 趋势 → 用户原声分析）<br />
          · <b>AI 审价</b>：贴报价 → 逐项判定合理价与议价要点（AI 趋势 → AI 审价助手）<br />
          · <b>物料趋势洞察</b>：按品类洞察行情与降本方向（AI 趋势 → 物料趋势洞察）<br />
          · <b>报价情报</b>：后台自动扫跨项目价差，驾驶舱红点提醒
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={onClose}>关闭</Button>
        <Button type="primary" icon={<SettingOutlined />} onClick={() => { onClose(); onOpenSettings(); }}>去设置</Button>
      </div>
    </Modal>
  );
}
