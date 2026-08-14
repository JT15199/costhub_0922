import { useEffect, useState } from 'react';
import { Table, Tag, Button, Space, Switch, message, Spin, Empty, Modal, Popconfirm, Descriptions, Typography, Card, Row, Col } from 'antd';
import { DeleteOutlined, StopOutlined, CheckCircleOutlined, HistoryOutlined, BulbOutlined, ThunderboltOutlined, BookOutlined } from '@ant-design/icons';
import { getAllChecklistWithLogs, updateChecklistActive, deleteAnalysisChecklistItem } from '../db';

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

export default function AnalysisChecklist(_props: any) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logData, setLogData] = useState<any[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getAllChecklistWithLogs();
      setItems(data.items);
    } catch { }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const handleToggle = async (id: number, current: boolean) => {
    await updateChecklistActive(id, !current);
    message.success(current ? '已暂停该记忆' : '已恢复该记忆');
    load();
  };

  const handleDelete = async (id: number) => {
    await deleteAnalysisChecklistItem(id);
    message.success('已删除');
    load();
  };

  const showLogs = (logs: any[]) => {
    setLogData(logs || []);
    setLogModalOpen(true);
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 100 }}><Spin size="large" /></div>;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="page-title" style={{ marginBottom: 20 }}>
        <BulbOutlined /> 分析清单
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
        系统自动记录您在不同物料洞察分析中反复追问的角度。当某一类追问出现3次以上时，该角度自动纳入后续洞察查询的提示词。
        共 <b>{items.length}</b> 条记忆。
      </p>

      {items.length === 0 ? (
        <Empty description="暂无分析清单记录，使用洞察追问功能后会自动生成" style={{ marginTop: 60 }} />
      ) : (
        <Row gutter={[12, 12]}>
          {items.map((item: any) => (
            <Col key={item.id} xs={24} sm={12} lg={8}>
              <Card
                size="small"
                style={{
                  border: item.is_active ? `1px solid ${STRENGTH_COLORS[item.strength_level] || '#94A3B8'}` : '1px solid #E2E8F0',
                  opacity: item.is_active ? 1 : 0.5,
                }}
                actions={[
                  <Switch key="toggle" size="small" checked={!!item.is_active}
                    onChange={() => handleToggle(item.id, !!item.is_active)}
                    checkedChildren={<CheckCircleOutlined />}
                    unCheckedChildren={<StopOutlined />}
                  />,
                  <Button key="logs" type="link" size="small" icon={<HistoryOutlined />}
                    onClick={() => showLogs(item.trigger_logs || [])} disabled={!(item.trigger_logs || []).length}>
                    日志
                  </Button>,
                  <Popconfirm key="del" title="删除此记忆？" onConfirm={() => handleDelete(item.id)}>
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
                      {item.strength_level === 'stable' && <Tag color="purple" style={{ fontSize: 10 }}><ThunderboltOutlined /> 稳定记忆</Tag>}
                    </div>
                  }
                />
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 强度说明 */}
      <Card size="small" style={{ marginTop: 20 }}>
        <Descriptions column={1} size="small" title={<span><BookOutlined /> 强度分级说明</span>} style={{ fontSize: 12 }}>
          <Descriptions.Item label={<Tag color="#94A3B8">观察中</Tag>}>1-2次触发，记录但不影响分析</Descriptions.Item>
          <Descriptions.Item label={<Tag color="#3B82F6">已生效</Tag>}>3-4次触发，已自动纳入分析提示</Descriptions.Item>
          <Descriptions.Item label={<Tag color="#8B5CF6">稳定记忆</Tag>}>5次以上触发，权重较高的稳定模式</Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 8, display: 'block' }}>
          记忆仅影响分析维度的覆盖范围，不影响对具体涨跌方向的客观判断。可随时暂停或删除任意记忆。
        </Typography.Text>
      </Card>

      {/* 触发日志弹窗 */}
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
