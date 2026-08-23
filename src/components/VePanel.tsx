// 价值工程面板（v2.3.19）VE = 价值分/每千元成本，价值由数据算不人为定义
import { useEffect, useState } from 'react';
import { Card, Select, Table, Button, Tag, Modal, Slider, message, Empty } from 'antd';
import { AimOutlined, EditOutlined } from '@ant-design/icons';
import { getProjects, getCompetitors, getProjectBOMs, getCompetitorBOMs, getCatFeatureTemplates, getValueScores, saveValueScore, getModuleFeatureLinks, getFeatures } from '../db';
import { computeValueEngineering, type VEObject } from '../valueEng';

export default function VePanel() {
  const [cateList, setCateList] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('显示器');
  const [templates, setTemplates] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [scoreTarget, setScoreTarget] = useState<any>(null);
  const [scoreMap, setScoreMap] = useState<Record<string, number>>({});

  useEffect(() => {
    (async () => {
      try {
        const projs = await getProjects();
        const comps = await getCompetitors();
        const cats = new Set<string>([...(projs || []).map((p: any) => p.category || '未分类'), ...(comps || []).map((c: any) => c.category || '未分类')].filter((c: string) => c && c !== '未分类'));
        setCateList(Array.from(cats));
        if (cats.size) { const first = Array.from(cats)[0]; if (first) setCategory(first); }
      } catch { }
    })();
  }, []);

  const load = async () => {
    try {
      const cat = category || '显示器';
      const templates = await getCatFeatureTemplates(cat);
      setTemplates(templates);
      if (templates.length === 0) { setResults([]); return; }
      const [projs, comps, links, featuresAll] = await Promise.all([getProjects('', '', ''), getCompetitors(), getModuleFeatureLinks(), getFeatures('custom')]);
      const featNameToKey: Record<string, string> = {};
      templates.forEach((t: any) => { featNameToKey[t.feature_label] = t.feature_key; });
      // links: { module_name: [feature_id...] } → 展开成 {module_name, featName} 行（特性名映射到模板 key）
      const linkRows: { module_name: string; featName: string }[] = [];
      Object.entries(links || {}).forEach(([mod, fids]: any) => {
        (fids || []).forEach((fid: number) => {
          const featName = featuresAll.find((f: any) => f.id === fid)?.name || '';
          if (featName) linkRows.push({ module_name: mod, featName });
        });
      });
      const modFeat = (modNames: string[]) => {
        const map: Record<string, string[]> = {};
        for (const mn of modNames) {
          const ks = linkRows.filter((l: any) => l.module_name === mn).map((l: any) => featNameToKey[l.featName]).filter(Boolean);
          if (ks.length > 0) map[mn] = ks;
        }
        return map;
      };
      const objects: VEObject[] = [];
      for (const p of (projs || []).filter((x: any) => (x.category || '未分类') === cat)) {
        const boms = await getProjectBOMs(p.id);
        const moduleCosts: Record<string, number> = {}; let bomCost = 0;
        boms.forEach((b: any) => { const m = b.module_name || '未分模块'; const v = (b.part_cost || b.cost || 0) * (b.quantity || 1); moduleCosts[m] = (moduleCosts[m] || 0) + v; bomCost += v; });
        const scores: Record<string, number> = {};
        (await getValueScores('project', p.id)).forEach((s: any) => { scores[s.feature_key] = s.score; });
        objects.push({ refType: 'project', refId: p.id, name: p.code + ' ' + (p.name || ''), category: cat, bomCost, moduleCosts, moduleFeatures: modFeat(Object.keys(moduleCosts)), scores });
      }
      for (const c of (comps || []).filter((x: any) => (x.category || '未分类') === cat)) {
        const boms = await getCompetitorBOMs(c.id);
        const moduleCosts: Record<string, number> = {};
        boms.forEach((b: any) => { const m = b.module_name || '未分模块'; moduleCosts[m] = (moduleCosts[m] || 0) + (b.estimated_cost || b.cost || 0); });
        const bomCost = Object.values(moduleCosts).reduce((s, v) => s + v, 0) || (c.bom_cost || 0);
        const scores: Record<string, number> = {};
        (await getValueScores('competitor', c.id)).forEach((s: any) => { scores[s.feature_key] = s.score; });
        objects.push({ refType: 'competitor', refId: c.id, name: c.brand + ' ' + c.model, category: cat, bomCost, moduleCosts, moduleFeatures: modFeat(Object.keys(moduleCosts)), scores });
      }
      setResults(computeValueEngineering(objects, templates).sort((a, b) => b.ve - a.ve));
    } catch (e: any) { console.error('价值工程加载失败:', e); message.error('价值工程加载失败'); }
  };
  useEffect(() => { load(); }, [category]);

  const openScore = (r: any) => {
    setScoreTarget(r);
    const m: Record<string, number> = {};
    (templates || []).forEach((t: any) => { m[t.feature_key] = 0; });
    (async () => { (await getValueScores(r.refType, r.refId)).forEach((s: any) => { m[s.feature_key] = s.score; }); setScoreMap(m); })();
  };

  return (
    <Card size="small" style={{ marginBottom: 14, borderRadius: 10 }} title={<span><AimOutlined style={{ color: '#0A84FF' }} /> 价值工程（VE）</span>}
      extra={<Select size="small" value={category} onChange={setCategory} style={{ width: 130 }} options={cateList.map(c => ({ label: c, value: c }))} />}>
      <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
        对比同品类项目/竞品性价比：价值分 = Σ(特性评分 × 权重)，VE = 价值分 / 每千元成本（越高越好）。先给对象按品类特性打分，AI 即可据此给取舍建议。
      </div>
      {results.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={templates.length === 0 ? '该品类暂未配置特性模板（设置 → 品类模板）' : '该品类暂无项目/竞品，或尚未评分'} />
      ) : (
        <Table size="small" dataSource={results} rowKey={(r: any) => r.refType + '-' + r.refId} pagination={false} scroll={{ x: 720 }}
          columns={[
            { title: '对象', dataIndex: 'name', width: 150, ellipsis: true },
            { title: '类型', key: 't', width: 70, render: (_: any, r: any) => <Tag color={r.refType === 'project' ? 'blue' : 'purple'}>{r.refType === 'project' ? '项目' : '竞品'}</Tag> },
            { title: '价值分', dataIndex: 'valueScore', width: 70, align: 'right' as const, render: (v: number) => <b>{v.toFixed(1)}</b> },
            { title: 'BOM成本', dataIndex: 'bomCost', width: 90, align: 'right' as const, render: (v: number) => '¥' + (v || 0).toFixed(0) },
            { title: 'VE', dataIndex: 've', width: 80, align: 'right' as const, render: (v: number) => <b style={{ color: '#1E3A6E' }}>{v.toFixed(2)}</b> },
            { title: '每分成本', dataIndex: 'costPerValue', width: 90, align: 'right' as const, render: (v: number) => '¥' + (v || 0).toFixed(0) },
            { title: '价值工程重点', key: 'w', width: 200, render: (_: any, r: any) => (r.worstModules || []).length ? r.worstModules.map((m: any) => <Tag key={m.module} color="red" style={{ marginBottom: 2 }}>{m.module}（成本{(m.costRatio * 100).toFixed(0)}%{m.valueRatio > 0 ? ' 价值比' + m.valueRatio.toFixed(2) : ''}）</Tag>) : <span style={{ color: '#CBD5E1' }}>—</span> },
            { title: '评分', key: 'sc', width: 80, render: (_: any, r: any) => <Button size="small" icon={<EditOutlined />} onClick={() => openScore(r)}>评分</Button> },
          ]} />
      )}
      <Modal title={scoreTarget ? ('评分 · ' + scoreTarget.name + '（' + category + '）') : ''} open={!!scoreTarget} onCancel={() => setScoreTarget(null)} footer={null} width={460}>
        {(templates || []).map((t: any) => (
          <div key={t.feature_key} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>{t.feature_label} <span style={{ color: '#94A3B8', fontSize: 11 }}>（权重 {t.weight}）</span></span>
              <Tag color="#0A84FF">{scoreMap[t.feature_key] || 0} 分</Tag>
            </div>
            <Slider min={0} max={10} step={0.5} value={scoreMap[t.feature_key] || 0} onChange={(v: number) => setScoreMap(prev => ({ ...prev, [t.feature_key]: v }))} />
          </div>
        ))}
        <Button type="primary" block style={{ marginTop: 8 }} onClick={async () => {
          if (!scoreTarget) return;
          for (const k of Object.keys(scoreMap)) { await saveValueScore(scoreTarget.refType, scoreTarget.refId, k, scoreMap[k] || 0, category); }
          setScoreTarget(null); message.success('评分已保存'); load();
        }}>保存评分</Button>
      </Modal>
    </Card>
  );
}
