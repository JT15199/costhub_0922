// AI 目标管理卡（v2.3.19 harness 化阶段①，2026-08-18）
// 用户下达目标 → 后台 autoThink 优先推进（概览注入+结论回写进度）→ 完成/暂停/删除
import { useEffect, useState } from 'react';
import { Card, Input, Button, Tag, message, Popconfirm, Space, Select } from 'antd';
import { PlusOutlined, CheckOutlined, PauseOutlined, PlayCircleOutlined, DeleteOutlined, AimOutlined } from '@ant-design/icons';
import { getGoals, saveGoal, updateGoalStatus, deleteGoal } from '../db';
import type { AiGoal } from '../db/goals';

export default function GoalsCard({ projects }: { projects?: { id: number; code: string }[] }) {
  const [goals, setGoals] = useState<AiGoal[]>([]);
  const [text, setText] = useState('');
  const [linked, setLinked] = useState<string | undefined>(undefined);
  const load = async () => { try { setGoals(await getGoals()); } catch { /* 忽略 */ } };
  useEffect(() => { load(); }, []);
  const add = async () => {
    const t = text.trim();
    if (!t) { message.warning('请输入目标内容'); return; }
    await saveGoal(t, linked || '');
    setText(''); setLinked(undefined);
    await load();
    message.success('目标已下达——后台 AI 将在下一轮分析中优先推进');
  };
  const setStatus = async (id: number, s: 'active' | 'paused' | 'done') => {
    await updateGoalStatus(id, s);
    await load();
  };
  const active = goals.filter(g => g.status === 'active');
  return (
    <Card size="small" style={{ marginBottom: 10, borderRadius: 10, border: '1px solid #E8ECF1' }} styles={{ body: { padding: 10 } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <AimOutlined style={{ color: '#0A84FF' }} />
        <b style={{ fontSize: 13 }}>AI 目标</b>
        <Tag color={active.length > 0 ? 'blue' : 'default'} style={{ margin: 0, fontSize: 10.5 }}>{active.length} 进行中</Tag>
        <span style={{ fontSize: 11, color: '#94A3B8' }}>下达目标后，后台自主分析会优先围绕它推进，每轮结论自动记入进度</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <Input size="small" placeholder="输入目标，如：分析 M270 的降本空间，给出 TOP3 方案" value={text} onChange={e => setText(e.target.value)} style={{ flex: 1, minWidth: 220 }} onPressEnter={add} />
        {projects && projects.length > 0 && (
          <Select size="small" allowClear placeholder="关联项目（可选）" style={{ width: 150 }} value={linked} onChange={setLinked}
            options={projects.map((p: any) => ({ label: p.code + ' ' + (p.name || ''), value: p.code }))} />
        )}
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={add}>下达</Button>
      </div>
      {goals.length === 0 ? (
        <div style={{ fontSize: 11.5, color: '#CBD5E1', padding: '4px 0' }}>暂无目标——AI 目前自主分析；下达目标后它会聚焦推进</div>
      ) : (
        <div style={{ maxHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {goals.map(g => (
            <div key={g.id} style={{ border: g.status === 'active' ? '1px solid #BFDBFE' : '1px solid #E8ECF1', background: g.status === 'active' ? '#F5FAFF' : '#FAFBFC', borderRadius: 8, padding: '6px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{g.text}</b>
                <Tag color={g.status === 'active' ? 'blue' : g.status === 'paused' ? 'orange' : 'green'} style={{ margin: 0, fontSize: 10.5 }}>
                  {g.status === 'active' ? '进行中' : g.status === 'paused' ? '已暂停' : '已完成'}
                </Tag>
                {g.linked_project && <Tag color="purple" style={{ margin: 0, fontSize: 10.5 }}>{g.linked_project}</Tag>}
                <Space size={0}>
                  {g.status === 'active' && <Button size="small" type="text" icon={<CheckOutlined />} title="标记完成" onClick={() => setStatus(g.id, 'done')} />}
                  {g.status === 'active' && <Button size="small" type="text" icon={<PauseOutlined />} title="暂停" onClick={() => setStatus(g.id, 'paused')} />}
                  {g.status === 'paused' && <Button size="small" type="text" icon={<PlayCircleOutlined />} title="恢复" onClick={() => setStatus(g.id, 'active')} />}
                  {g.status !== 'active' && <Button size="small" type="text" icon={<PlayCircleOutlined />} title="重新开始" onClick={() => setStatus(g.id, 'active')} />}
                  <Popconfirm title="删除该目标？" onConfirm={async () => { await deleteGoal(g.id); await load(); }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} title="删除" />
                  </Popconfirm>
                </Space>
              </div>
              {g.progress && (
                <div style={{ fontSize: 11, color: '#64748B', marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{g.progress}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
