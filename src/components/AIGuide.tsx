import { useEffect, useState } from 'react';
import { Modal, Tag, Button } from 'antd';
import { RobotOutlined, CheckCircleOutlined, WarningOutlined, SettingOutlined } from '@ant-design/icons';
import { getAllApiProviders, getSetting } from '../db';

// AI 能力引导（v2.3.19）：解锁后首次显示，告知已有哪些 AI 能力 + 当前配置状态
// 避免'不知道 AI 能干什么'——能力清单 + 配置就绪度一眼可见

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export default function AIGuide({ open, onClose, onOpenSettings }: Props) {
  const [llmReady, setLlmReady] = useState(false);
  const [llmName, setLlmName] = useState('');
  const [localModel, setLocalModel] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const providers = await getAllApiProviders();
        const active = providers.find((p: any) => p.provider_type === 'llm' && p.is_active && p.api_key);
        setLlmReady(!!active);
        setLlmName(active?.provider_name || '');
        setLocalModel(await getSetting('local_ai_model', ''));
      } catch { /* ignore */ }
    })();
  }, [open]);

  const Cap = ({ title, desc, ready, readyText, warnText }: { title: string; desc: string; ready: boolean; readyText: string; warnText: string }) => (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 16, marginTop: 2 }}>{ready ? <CheckCircleOutlined style={{ color: '#10B981' }} /> : <WarningOutlined style={{ color: '#F59E0B' }} />}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2, lineHeight: 1.6 }}>{desc}</div>
        <div style={{ marginTop: 6 }}>
          <Tag color={ready ? 'green' : 'orange'}>{ready ? readyText : warnText}</Tag>
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      title={<span><RobotOutlined style={{ color: '#0A84FF', marginRight: 8 }} />CostHub AI 能力一览</span>}
      open={open}
      onCancel={onClose}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            本地主脑 {localModel ? <>已配置（{localModel}）</> : '未配置'} · 受控云端 {llmReady ? <>已配置（{llmName}）</> : '未配置'} · 外发需审查/条件审批
          </span>
          <div>
            <Button onClick={onClose}>知道了</Button>
            <Button type="primary" icon={<SettingOutlined />} style={{ marginLeft: 8 }} onClick={() => { onClose(); onOpenSettings(); }}>去设置</Button>
          </div>
        </div>
      )}
      width={560}
    >
      <Cap
        title='报价情报（自动扫描）'
        desc='后台自动比对同物料跨项目报价，发现差异红点提醒；AI 疑似识别需本地模型'
        ready={!!localModel}
        readyText='本地模型已配置，自动扫描生效'
        warnText='未配置本地模型——在「系统设置 → 连接设置」配置 Ollama 后自动生效'
      />
      <Cap
        title='项目 AI 体检'
        desc='打开项目自动检查：BOM 完整性 / 目标超支 / 成本异动 / 同类报价偏高；「AI 小结」需本地模型'
        ready={!!localModel}
        readyText='已启用（规则部分不依赖模型，AI 小结需本地模型）'
        warnText='规则检查已启用；配置本地模型后可用「AI 小结」'
      />
      <Cap
        title='物料趋势洞察'
        desc='先查本地历史，再按需调用云端补充公开行情；云端仅收到通用物料名、品类与问题'
        ready={!!localModel && llmReady}
        readyText='本地分析 + 受控云端均可用'
        warnText={!localModel ? '需配置本地模型' : '未配置云端模型，仍可分析本地历史'}
      />
      <Cap
        title='全局 AI 问询'
        desc='侧边栏随时提问（带当前项目上下文），回答可一键记入工作手账'
        ready={!!localModel}
        readyText='本地模型已配置，可读取项目数据（安全边界：云端不接本地数据）'
        warnText='需本地模型（数据安全原则：只有本地模型可读项目数据）'
      />
      <Cap
        title='成本快照 AI 解释'
        desc='快照对比弹窗内一键解释「这次成本为什么变了」（本地模型）'
        ready={!!localModel}
        readyText='已启用'
        warnText='需本地模型'
      />
      <Cap
        title='自主建议（后台分析）'
        desc='空闲自动扫描：项目成本久未变动 / 大额物料久未调价 / 超目标 / 单一供应商——以成本经理视角找机会与风险，处理后可撤销'
        ready={true}
        readyText='已启用（驾驶舱可见待处理数；忽略过的建议数据不变不再重提）'
        warnText=''
      />
      <Cap
        title='Skill 数据分析与图表'
        desc='本地模型先调白名单工具取真实数据，再按构成/对比/大头分析自动选择饼图、柱状图或帕累托图'
        ready={!!localModel}
        readyText='本地 Skill 可用，图表数字由代码从数据库聚合'
        warnText='配置本地模型后可用'
      />
      <Cap
        title='物料洞察树（升级）'
        desc='洞察覆盖度一眼可见（已洞察/待洞察/大头优先），悬停看上游传导血缘链，面包屑 + 聚焦模式不迷路'
        ready={!!localModel}
        readyText='已启用（规则部分不依赖模型）'
        warnText='规则可用；配置本地模型后可完整使用'
      />
    </Modal>
  );
}
