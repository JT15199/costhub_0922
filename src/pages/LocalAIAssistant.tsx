import { useState, useEffect, useRef, useCallback, createElement } from 'react';
import { Button, Input, InputNumber, Select, Tooltip, Modal, Divider, Empty, Spin, Upload, Table, Tag, Steps, Alert, Form, Popconfirm, Space, Switch, Radio, Dropdown, Drawer, notification } from 'antd';
import { CopyOutlined, RadarChartOutlined, LockOutlined, MessageOutlined, AppstoreOutlined } from '@ant-design/icons';
import {
  SendOutlined, RobotOutlined, PlusOutlined, HistoryOutlined,
  ThunderboltOutlined, TeamOutlined, ClearOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined,
  BookOutlined, DeleteOutlined, ApartmentOutlined, SettingOutlined, ArrowDownOutlined,
  UploadOutlined, FileExcelOutlined, EditOutlined, FilePptOutlined,
  WarningOutlined, BulbOutlined, CheckOutlined, ArrowRightOutlined,
  LikeOutlined, DislikeOutlined, ExperimentOutlined, ToolOutlined,
} from '@ant-design/icons';
import { message } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import * as XLSX from 'xlsx';
import { getDb, saveProject, getModuleRules, saveModuleRule, deleteModuleRule, clearModuleRules, loadContextEntries, saveContextEntry, deleteContextEntry, getSetting, setSetting, saveAIRequestLog, getAllAIRequestLogs } from '../db';
import { MAIN_CATEGORIES } from '../constants';
import { startOllamaStream, logLocalAICall } from '../ollama';
import { toolIcon } from '../aiTools';
import { cleanProtocolText } from '../thinkEngine';
import { getAdvisorInsights, updateAdvisorStatus, getRecentBridgeLog, materialKey } from '../db/advisor';
import { getDailyCloudUsage } from '../db/settings';
import { runAutoAdvisor } from '../autoAdvisor';

// AI 学习：反馈原因选项（👎 时让用户选择/补充期望逻辑）
const FEEDBACK_REASONS_UI: Record<string, string> = {
  vague: '回答太泛泛，没有落到具体行动建议',
  nodata: '没有结合我的本地数据（成本/占比/项目）',
  wrong_logic: '结论逻辑不对，我想要另一种分析方式',
  focus: '没有优先回答我最关注的部分',
};

// AI 调用类型 → 中文名（活动记录展示用）
const AI_TYPE_NAMES: Record<string, string> = {
  quote_compare: '报价识别', project_health: '项目体检', snapshot_explain: '快照解释', global_ask: '全局问询',
  auto_audit: '自主巡检', auto_advisor: '建议润色', local_chat: '本地对话',
  bridge_intent: '洞察意图', bridge_summary: '洞察总结', daily_brief: '今日速览', demo_gen: '演示生成',
};
import { isProjectInsight } from '../aiBridge';
import { EmojiIcon } from '../iconMap';
import DemoGenerator from '../components/DemoGenerator';
import AutoThinkPanel from '../components/AutoThinkPanel';
import GoalsCard from '../components/GoalsCard';

// ===== Types =====
interface ChatMessage { id?: number; role: 'user' | 'assistant'; content: string; reasoning?: string; steps?: string[]; created_at?: string; }
interface Session { id: number; title: string; updated_at: string; }
interface ContextEntry { id?: number; key: string; title: string; content: string; }

// ===== DB Helpers =====
async function loadSessions(): Promise<Session[]> {
  return (await getDb()).select<Session[]>("SELECT * FROM local_ai_sessions ORDER BY updated_at DESC LIMIT 60");
}
async function newSession(title: string): Promise<number> {
  const r = await (await getDb()).execute("INSERT INTO local_ai_sessions (title) VALUES (?)", [title]);
  return r.lastInsertId!;
}
async function deleteSession(id: number) {
  const db = await getDb();
  await db.execute("DELETE FROM local_ai_messages WHERE session_id=?", [id]);
  await db.execute("DELETE FROM local_ai_sessions WHERE id=?", [id]);
}
async function loadMessages(sessionId: number): Promise<ChatMessage[]> {
  return (await getDb()).select<ChatMessage[]>("SELECT * FROM local_ai_messages WHERE session_id=? ORDER BY id", [sessionId]);
}
async function saveMsg(sessionId: number, role: string, content: string, reasoning = '') {
  const db = await getDb();
  await db.execute("INSERT INTO local_ai_messages (session_id,role,content,reasoning) VALUES (?,?,?,?)", [sessionId, role, content, reasoning]);
  await db.execute("UPDATE local_ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?", [sessionId]);
}
// ===== 长期记忆（自动提炼 + 相关性检索） =====
interface MemoryItem { id: number; content: string; category: string; hit_count: number; last_used_at: string; created_at: string; }

async function loadMemories(limit = 30): Promise<MemoryItem[]> {
  return (await getDb()).select<MemoryItem[]>(
    "SELECT * FROM local_ai_memory ORDER BY hit_count DESC, last_used_at DESC LIMIT ?", [limit]
  );
}

async function saveMemory(content: string, category = 'general', sessionId = 0) {
  const db = await getDb();
  // 内容太短不记
  if (content.trim().length < 10) return;
  // 去重：完全相同的内容只更新热度，不重复存
  const existing = await db.select<any[]>('SELECT id FROM local_ai_memory WHERE content = ?', [content]);
  if (existing.length) {
    await db.execute("UPDATE local_ai_memory SET hit_count = hit_count + 1, last_used_at = datetime('now','localtime') WHERE id = ?", [existing[0].id]);
  } else {
    await db.execute("INSERT INTO local_ai_memory (content, category, source_session) VALUES (?,?,?)", [content, category, sessionId]);
  }
}

async function deleteMemory(id: number) {
  await (await getDb()).execute("DELETE FROM local_ai_memory WHERE id = ?", [id]);
}

async function clearAllMemories() {
  await (await getDb()).execute("DELETE FROM local_ai_memory");
}

// 基于关键词匹配最相关的记忆（简单启发式，无需模型调用，快且离线）
async function recallMemories(userContent: string): Promise<MemoryItem[]> {
  const all = await loadMemories(100);
  if (!all.length) return [];
  const words = userContent.replace(/[^一-龥a-zA-Z0-9]+/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  const scored = all.map(mem => {
    let score = 0;
    const content = mem.content;
    // 中文连续片段匹配（2字以上）
    for (const w of words) {
      if (w.length >= 2 && content.includes(w)) score += 1;
    }
    // 命中记录越多权重越高（热记忆）
    score += Math.min(mem.hit_count, 5) * 0.5;
    return { mem, score };
  });
  return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.mem);
}

// ===== Ollama Streaming via Tauri Events（已移至 src/ollama.ts，与演示生成器共用） =====
// ===== 提示音（用 WebAudio 生成，无需音频文件） =====
function playChime(kind: 'done' | 'error') {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === 'done' ? [880, 1320] : [440, 330];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.4);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.4);
    });
    // 自动关闭上下文
    setTimeout(() => ctx.close().catch(() => {}), 2000);
  } catch { /* 静默失败 */ }
}

// ===== 思考过程可视化组件 =====
// 把模型的自由推理文本实时渲染成"步骤化"的思考跟踪器
function ThinkingTracker({ reasoning, phase, elapsed, streamRate }: {
  reasoning: string;
  phase: 'fetching' | 'thinking' | 'querying' | 'streaming';
  elapsed: number;
  streamRate: number;
}) {
  // 根据推理内容检测当前思考阶段（启发式关键词）
  const steps = [
    { label: '读取数据库', pattern: /数据库|数据|BOM|项目|查询|读取|供应商|报价/ },
    { label: '分析问题', pattern: /分析|问题|理解|用户|需求|目标/ },
    { label: '推理判断', pattern: /认为|判断|因为|所以|如果|对比|计算|比较|原因|结论|可能/ },
    { label: '组织回答', pattern: /回答|总结|建议|方案|接下来|最后/ },
  ];
  let activeIdx = 0;
  let bestScore = -1;
  steps.forEach((s, i) => {
    const m = reasoning.match(s.pattern);
    if (m) {
      const pos = reasoning.indexOf(m[0]);
      if (pos > bestScore) { bestScore = pos; activeIdx = i; }
    }
  });

  return (
    <div style={{ marginBottom: 8, padding: '10px 12px', background: '#F5F3FF', borderLeft: '3px solid #8B5CF6', borderRadius: 8, fontSize: 12 }}>
      {/* 阶段进度条 */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {steps.map((s, i) => {
          const done = i < activeIdx;
          const current = i === activeIdx;
          return (
            <div key={s.label} style={{ flex: 1, padding: '3px 6px', borderRadius: 6, textAlign: 'center', fontSize: 11,
              background: done ? '#C4B5FD' : current ? '#8B5CF6' : '#EDE9FE',
              color: done || current ? '#FFF' : '#6D28D9',
              fontWeight: current ? 700 : 500 }}>
              {done ? <CheckOutlined style={{ marginRight: 2, fontSize: 10 }} /> : current ? <ArrowRightOutlined style={{ marginRight: 2, fontSize: 10 }} /> : ''}{s.label}
            </div>
          );
        })}
      </div>
      {/* 实时计时 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, color: '#6D28D9' }}>
        <Spin size="small" />
        <span style={{ fontWeight: 600 }}>
          {phase === 'fetching' ? '正在读取数据库…'
            : phase === 'querying' ? '正在查询数据…'
            : phase === 'thinking' ? `正在思考分析… ${elapsed}s`
            : `正在生成回答… ${elapsed}s${streamRate > 0 ? ` (${streamRate}字/秒)` : ''}`}
        </span>
      </div>
      {/* 实时推理文本 */}
      {reasoning && (
        <div style={{ maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', lineHeight: 1.6, color: '#4C1D95', fontFamily: 'var(--font-mono)', fontSize: 11, background: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: 8 }}>
          {reasoning}
        </div>
      )}
    </div>
  );
}

// ===== Data Injection Builders =====
async function buildBOMContext(projectId: number): Promise<string> {
  const db = await getDb();
  const [proj] = await db.select<any[]>('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!proj) return '';
  const boms = await db.select<any[]>(`SELECT pb.*,p.name as pn,p.model as pm,p.cost as pc,p.main_category as mc,p.sub_category as sc FROM project_boms pb JOIN parts p ON pb.part_id=p.id WHERE pb.project_id=? AND COALESCE(pb.is_deleted,0)=0 ORDER BY pb.module_name,p.main_category`, [projectId]);
  const total = boms.reduce((s, b) => s + (b.pc || 0) * (b.quantity || 1), 0);
  const byMod: Record<string, any[]> = {};
  boms.forEach(b => { const m = b.module_name || '未分模块'; (byMod[m] = byMod[m] || []).push(b); });
  let out = `【项目BOM】${proj.code} - ${proj.name}\n档位:${proj.tier} 状态:${proj.status}\nBOM总成本: ¥${total.toFixed(2)}\n\n`;
  for (const [mod, items] of Object.entries(byMod)) {
    const mc = items.reduce((s, b) => s + (b.pc || 0) * (b.quantity || 1), 0);
    out += `▍${mod} ¥${mc.toFixed(2)}\n`;
    items.forEach(b => { out += `  · ${b.pn}(${b.pm||'-'}) ¥${(b.pc||0).toFixed(2)}×${b.quantity||1} ${b.mc}/${b.sc}\n`; });
  }
  const hist = await db.select<any[]>(`SELECT ref_name,old_value,new_value,change_reason,changed_at FROM cost_change_log WHERE change_type='project_total_cost' AND ref_id=? ORDER BY changed_at DESC LIMIT 8`, [projectId]);
  if (hist.length) {
    out += `\n【近期成本变动】\n`;
    hist.forEach(h => { const d = h.new_value - h.old_value; out += `${(h.changed_at||'').slice(0,10)} ¥${h.old_value.toFixed(2)}→¥${h.new_value.toFixed(2)} (${d>0?'+':''}${d.toFixed(2)}) ${h.change_reason}\n`; });
  }
  return out;
}

async function buildCrossProjectContext(projectIds: number[]): Promise<string> {
  if (!projectIds.length) return '';
  const db = await getDb();
  const placeholders = projectIds.map(() => '?').join(',');
  const common = await db.select<any[]>(`
    SELECT p.name,p.model,p.main_category,
      COUNT(DISTINCT pb.project_id) as cnt,
      GROUP_CONCAT(pr.code||':¥'||ROUND(p.cost,2),' | ') as info,
      ROUND(MAX(p.cost)-MIN(p.cost),2) as spread
    FROM project_boms pb JOIN parts p ON pb.part_id=p.id JOIN projects pr ON pb.project_id=pr.id
    WHERE pb.project_id IN (${placeholders}) AND COALESCE(pb.is_deleted,0)=0
    GROUP BY p.name,p.model HAVING cnt>1 ORDER BY spread DESC LIMIT 40
  `, projectIds);
  const projs = await db.select<any[]>(`SELECT code,name FROM projects WHERE id IN (${placeholders})`, projectIds);
  let out = `【跨项目分析】涉及项目：${projs.map((p:any)=>p.code).join('、')}\n\n`;
  if (!common.length) { out += '所选项目之间没有完全相同型号的共用器件。\n'; return out; }
  out += `共用器件（按价差排序，共${common.length}个）：\n`;
  common.forEach(c => { out += `· ${c.name}(${c.model}) ${c.main_category} | 出现${c.cnt}项目 | 价差¥${c.spread}\n  ${c.info}\n`; });
  return out;
}

async function buildCostHistoryContext(months = 6): Promise<string> {
  const db = await getDb();
  const since = new Date(); since.setMonth(since.getMonth() - months);
  const sinceStr = since.toISOString().slice(0, 10);
  const logs = await db.select<any[]>(`SELECT * FROM cost_change_log WHERE changed_at>=? ORDER BY changed_at DESC LIMIT 150`, [sinceStr]);
  const proj = logs.filter(l => l.change_type === 'project_total_cost');
  const part = logs.filter(l => l.change_type === 'part_cost');
  let out = `【成本变动历史】过去${months}个月（${sinceStr}至今）\n\n`;
  if (proj.length) {
    out += `项目总成本变动（${proj.length}条）：\n`;
    proj.forEach(c => { const d = c.new_value - c.old_value; out += `${(c.changed_at||'').slice(0,10)} ${c.ref_name} ${d>0?'↑':'↓'}¥${Math.abs(d).toFixed(2)} | ${c.change_reason}\n`; });
  }
  if (part.length) {
    out += `\n器件成本变动（${part.length}条）：\n`;
    part.slice(0, 40).forEach(c => { const d = c.new_value - c.old_value; out += `${(c.changed_at||'').slice(0,10)} ${c.ref_name} ${d>0?'+':''}¥${d.toFixed(2)} 供应商:${c.supplier_name||'-'} | ${c.change_reason}\n`; });
  }
  return out;
}

async function buildSupplierContext(): Promise<string> {
  const db = await getDb();
  const rows = await db.select<any[]>(`SELECT ps.*,p.name as pn,p.model as pm,p.main_category as mc FROM part_suppliers ps JOIN parts p ON ps.part_id=p.id WHERE ps.is_active=1 ORDER BY ps.supplier_name,p.main_category`);
  const byS: Record<string, any[]> = {};
  rows.forEach(r => { (byS[r.supplier_name] = byS[r.supplier_name] || []).push(r); });
  let out = `【供应商分布】活跃供应商${Object.keys(byS).length}家\n\n`;
  for (const [s, parts] of Object.entries(byS)) {
    out += `▍${s} (${parts.length}个器件)\n`;
    parts.slice(0, 15).forEach(p => { out += `  · ${p.pn}(${p.pm||'-'}) ¥${p.price} 份额${p.share_ratio}%\n`; });
    if (parts.length > 15) out += `  …另${parts.length - 15}个器件\n`;
  }
  return out;
}

async function buildCompetitorContext(): Promise<string> {
  const db = await getDb();
  const comps = await db.select<any[]>('SELECT * FROM competitors ORDER BY COALESCE(sort_order,0), created_at DESC');
  let out = `【竞品库】共${comps.length}个竞品\n`;
  comps.slice(0, 25).forEach(c => {
    out += `· ${c.brand} ${c.model} | 档位:${c.tier} | 市场价:¥${c.market_price||0} | BOM估算:¥${c.bom_cost||0}\n`;
  });
  return out;
}

async function buildDashboardDigest(): Promise<string> {
  const db = await getDb();
  const totalParts = (await db.select<{c:number}[]>('SELECT COUNT(*) as c FROM parts'))[0].c;
  const totalProjects = (await db.select<{c:number}[]>('SELECT COUNT(*) as c FROM projects WHERE COALESCE(is_deleted,0)=0'))[0].c;
  const activeProjects = (await db.select<{c:number}[]>("SELECT COUNT(*) as c FROM projects WHERE status='进行中' AND COALESCE(is_deleted,0)=0"))[0].c;
  const totalCompetitors = (await db.select<{c:number}[]>('SELECT COUNT(*) as c FROM competitors'))[0].c;
  const totalSuppliers = (await db.select<{c:number}[]>('SELECT COUNT(DISTINCT supplier_name) as c FROM part_suppliers WHERE is_active=1'))[0].c;
  const cats = await db.select<any[]>('SELECT main_category as c, COUNT(*) as n FROM parts GROUP BY main_category ORDER BY n DESC');
  let out = `【数据库概览】器件${totalParts}个 · 项目${totalProjects}个（进行中${activeProjects}）· 竞品${totalCompetitors}个 · 活跃供应商${totalSuppliers}家\n`;
  if (cats.length) out += `器件分类：${cats.map(c=>`${c.c}(${c.n}个)`).join('、')}\n`;
  return out;
}

// 单个数据构建器安全包装：失败不影响整体
async function safeBuild<T>(builder: () => Promise<T>, fallback: T): Promise<T> {
  try { return await builder(); } catch (e: any) {
    console.error('数据构建失败:', e);
    return fallback;
  }
}

// 根据用户问题自动决定要注入哪些数据 —— 让助手"自己会查数据"
async function detectAndFetchData(userContent: string): Promise<{ data: string; note: string }> {
  const db = await getDb();
  const noteParts: string[] = [];
  const dataParts: string[] = [];

  // 总是注入概览 + 项目列表，让助手知道自己有哪些项目
  const digest = await safeBuild(buildDashboardDigest, '');
  if (digest) { dataParts.push(digest); noteParts.push('概览'); }

  const projs = await safeBuild(() => db.select<any[]>('SELECT id,code,name,tier,status FROM projects WHERE COALESCE(is_deleted,0)=0 ORDER BY code'), []);
  if (projs && projs.length) {
    dataParts.push(`【项目列表】${projs.map((p:any)=>`${p.code}(${p.tier||'-'}/${p.status||'-'})`).join('、')}`);
    noteParts.push('项目列表');
  }

  // 项目匹配：问题里提到了具体项目代号或名称
  if (projs && projs.length) {
    const matched = projs.filter((p:any) => userContent.includes(p.code) || (p.name && userContent.includes(p.name)));
    if (matched.length) {
      const bomCtx = await safeBuild(() => buildBOMContext(matched[0].id), '');
      if (bomCtx) { dataParts.push(bomCtx); noteParts.push(`BOM(${matched[0].code})`); }
    }
  }

  // 供应商相关
  if (/供应商|份额|货源|采购|单一来源|依赖|ODM|代工/.test(userContent)) {
    const sctx = await safeBuild(buildSupplierContext, '');
    if (sctx) { dataParts.push(sctx); noteParts.push('供应商'); }
  }

  // 成本历史 / 降本总结
  if (/成本|降本|涨价|跌价|趋势|变动|历史|总结|这段时间|半年|季度|几个月|变化/.test(userContent)) {
    const hctx = await safeBuild(() => buildCostHistoryContext(6), '');
    if (hctx) { dataParts.push(hctx); noteParts.push('成本历史'); }
  }

  // 跨项目 / 对比 / 机会
  if (projs && projs.length >= 2 && /对比|比较|共用|机会|最贵|最便宜|哪个项目|价差|规模|差异|挖掘/.test(userContent)) {
    const cctx = await safeBuild(() => buildCrossProjectContext(projs.map((p:any)=>p.id)), '');
    if (cctx) { dataParts.push(cctx); noteParts.push('跨项目'); }
  }

  // 竞品
  if (/竞品|竞争对手|友商|市场价|对标/.test(userContent)) {
    const ctx = await safeBuild(buildCompetitorContext, '');
    if (ctx) { dataParts.push(ctx); noteParts.push('竞品'); }
  }

  return { data: dataParts.join('\n\n'), note: noteParts.join('、') };
}

// ===== 模块分类规则引擎 =====
// 确定性关键词规则：命中即采用，比让弱模型"感觉"可靠得多
// 每个条目：{ keywords: 关键词数组, module: 模块名, mainCat: 大类, sub: 子类 }
const MODULE_RULES: { keywords: string[]; module: string; mainCat: string; sub: string }[] = [
  // 显示模块
  { keywords: ['面板', 'lcd', '液晶', '屏', '玻璃', '偏光片', '导光板', '光学膜', 'panel'], module: '显示模块', mainCat: '硬件类', sub: '面板' },
  // 背光模块
  { keywords: ['背光', '灯条', '灯珠', 'led灯', '背光驱动', '导光'], module: '背光模块', mainCat: '硬件类', sub: '背光模组' },
  // 电源模块
  { keywords: ['电源', '适配器', 'dc-dc', 'dcdc', '变压器', '电解电容', '电容', '电阻', '电感', 'mos', '整流', '二极管', '稳压', 'ic', '磁珠', '保险丝', 'pwm'], module: '电源模块', mainCat: '电源类', sub: '电源器件' },
  // 驱动板模块
  { keywords: ['scaler', 'tcon', '主控', '芯片', 'mcu', 'ddr', 'emmc', 'flash', '内存', '存储', '晶振', 'pcb', '主板', 'hub', 'wifi', '蓝牙', '处理器', 'soc', 'eprom', 'eeprom'], module: '驱动板模块', mainCat: '硬件类', sub: '驱动芯片' },
  // 控制板模块
  { keywords: ['按键板', '按键', 'osd', '控制板', '触控'], module: '控制板模块', mainCat: '硬件类', sub: '控制板' },
  // 接口模块
  { keywords: ['hdmi', 'dp接口', 'type-c', 'typec', 'usb接口', 'vga', '母座', '连接器', '接口'], module: '接口模块', mainCat: '硬件类', sub: '接口' },
  // 结构件
  { keywords: ['前框', '后壳', '底座', '立柱', '中框', '支架', '螺丝', '挂架', '外壳', '卡扣', '脚垫', '装饰条'], module: '结构件', mainCat: '结构类', sub: '结构件' },
  // 包装材料
  { keywords: ['外箱', '内卡', '珍珠棉', '泡沫', 'pe袋', '防静电袋', '说明书', '标签', '贴纸', '彩盒', '纸箱', '缓冲', '保修卡'], module: '包装材料', mainCat: '包材类', sub: '包材' },
  // 连接线材
  { keywords: ['hdmi线', 'dp线', '电源线', '排线', 'ffc', 'lvds', '线缆', '线材', 'usb线', 'type-c线'], module: '连接线材', mainCat: '线材类', sub: '线材' },
  // 声学模块
  { keywords: ['喇叭', '扬声器', '麦克风', '蜂鸣器', 'sound', 'audio'], module: '声学模块', mainCat: '硬件类', sub: '声学' },
  // 散热组件
  { keywords: ['散热片', '散热器', '风扇', '导热垫', '导热', '均热板'], module: '散热组件', mainCat: '结构类', sub: '散热' },
  // 加工费类
  { keywords: ['smt', '贴片加工', '组装', '测试费', '老化', '包装费', '加工费', '校准', 'dip', '烧录', '彩印'], module: '其他', mainCat: '加工费类', sub: '加工费' },
  // 软件类
  { keywords: ['firmware', '固件', '软件', 'osd菜单', '驱动'], module: '控制板模块', mainCat: '软件类', sub: '软件' },
];

// 用规则引擎判断器件归属（返回null表示规则未命中，交给AI）
// rules 参数：数据库里的用户规则；命中用户规则优先，其次用内置默认规则
function classifyByRule(
  name: string,
  rules?: { keywords: string; module: string; main_category: string; sub_category: string }[],
): { module: string; mainCat: string; sub: string } | null {
  const n = name.toLowerCase();
  // 1) 用户自定义规则（数据库）优先
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      const kws = (rule.keywords || '').split(/[,，、]/).map((k: string) => k.trim().toLowerCase()).filter(Boolean);
      for (const kw of kws) {
        if (n.includes(kw)) {
          return { module: rule.module, mainCat: rule.main_category, sub: rule.sub_category };
        }
      }
    }
  }
  // 2) 内置默认规则兜底
  for (const rule of MODULE_RULES) {
    for (const kw of rule.keywords) {
      if (n.includes(kw)) {
        return { module: rule.module, mainCat: rule.mainCat, sub: rule.sub };
      }
    }
  }
  return null;
}

// ===== 模块分类规则引擎（End） =====

// 从现有数据库分类中自动学习规则（AI 分析提炼）
// 收集每个模块的器件样本，让本地模型分析提炼出代表性关键词
async function learnRulesFromDB(
  ollamaUrl: string, model: string,
  onProgress?: (module: string, done: number, total: number, chars: number) => void,
): Promise<number> {
  const db = await getDb();
  // 收集每个模块的器件名样本
  const samples: Record<string, string[]> = {};
  const boms = await db.select<any[]>(`SELECT pb.module_name, p.name FROM project_boms pb JOIN parts p ON pb.part_id=p.id WHERE COALESCE(pb.is_deleted,0)=0 AND pb.module_name != '' AND pb.module_name != '未归类'`);
  boms.forEach(b => {
    if (!samples[b.module_name]) samples[b.module_name] = [];
    samples[b.module_name].push(b.name);
  });
  // 从模块库也收集
  const modItems = await db.select<any[]>(`SELECT m.name as module_name, mi.part_name FROM module_items mi JOIN modules m ON mi.module_id=m.id WHERE m.name != ''`);
  modItems.forEach(m => {
    if (!samples[m.module_name]) samples[m.module_name] = [];
    samples[m.module_name].push(m.part_name);
  });
  if (!Object.keys(samples).length) return 0;

  let learned = 0;
  let totalChars = 0; // 累计接收字符（跨模块）
  const moduleNames = Object.keys(samples);
  for (let mi = 0; mi < moduleNames.length; mi++) {
    const module = moduleNames[mi];
    const names = samples[module];
    // 进度上报：正在分析哪个模块
    onProgress?.(module, mi, moduleNames.length, totalChars);
    const unique = [...new Set(names)].slice(0, 15); // 每模块最多15个样本
    if (unique.length < 2) continue;
    try {
      // AI 分析：从器件样本中提炼该模块的关键词
      const sampleList = unique.map((n, i) => `${i + 1}. ${n}`).join('\n');
      const systemPrompt = `你是器件分类专家。用户会给你某个功能模块（如"电源模块"）下的一组器件名称样本，请分析这些器件名的共同特征，提炼出3-6个最能代表该模块的关键词。
规则：
1. 关键词要短（2-4个字或英文单词），能作为"包含即命中"的匹配词
2. 从器件名里提取真实出现的词，不要编造
3. 输出JSON数组，格式：["关键词1","关键词2",...]，不要输出其他内容`;
      // 流式调用，实时反馈接收字符数
      let learnText = '';
      let learnErr = '';
      let learnDone = false;
      await new Promise<void>((resolve) => {
        const finish = () => { if (!learnDone) { learnDone = true; resolve(); } };
        startOllamaStream(
          ollamaUrl, model,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `模块「${module}」的器件样本：\n${sampleList}` },
          ],
          (token) => {
            learnText += token;
            totalChars += token.length;
            onProgress?.(module, mi, moduleNames.length, totalChars); // 每收到字符刷新进度
          },
          () => { /* 关闭思考 */ },
          () => { finish(); },
          (e) => { learnErr = e; finish(); },
          { num_predict: 500, temperature: 0.2, think: false, endpoint: 'native' },
        ).then(cleanup => { setTimeout(cleanup, 20000); });
        setTimeout(() => finish(), 60000);
      });
      logLocalAICall({
        request_type: 'module_learn',
        material_name: module || '',
        system_prompt: systemPrompt.slice(0, 1000),
        user_prompt: (sampleList || '').slice(0, 1000),
        response_summary: (learnText || '').slice(0, 200),
        success: !learnErr,
        error_message: learnErr || '',
        model_name: model,
      });
      if (learnErr) { console.warn('[模块学习] 失败（不影响对话）:', learnErr); continue; }
      const text = learnText.trim();
      // 解析关键词：优先提取 JSON 数组，失败则按行解析兜底
      let keywords: string[] = [];
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          const parsed = JSON.parse(arrMatch[0].replace(/,\s*]/g, ']'));
          if (Array.isArray(parsed)) {
            keywords = parsed
              .map((k: any) => String(k).trim().replace(/^["'“‘\[]/, '').replace(/["”’\],;:。]+$/, ''))
              .filter((k: string) => k && k.length >= 2 && k.length <= 12 && !/[,，、]/.test(k));
          }
        } catch { /* JSON 解析失败则走行解析兜底 */ }
      }
      if (keywords.length === 0) {
        keywords = text.split('\n')
          .map((l: string) => l
            .replace(/^\d+[.、)）]\s*/, '')
            .replace(/^[-*•]\s*/, '')
            .replace(/^["'“‘\[]/, '')
            .replace(/["”’\],;:。]+$/, '')
            .trim())
          .filter((k: string) => k && k.length >= 2 && k.length <= 12 && !/[,，、]/.test(k) && !/\s+/.test(k.trim()));
      }
      if (keywords.length === 0) continue;
      // 保存规则（先查重）
      const existing = await db.select<any[]>('SELECT id FROM module_rules WHERE module=?', [module]);
      if (!existing.length) {
        await saveModuleRule({
          keywords: keywords.join(','), module, main_category: '硬件类', sub_category: '', source: 'learned',
        });
        learned++;
      } else {
        // 已存在则更新关键词（学习更优的词）
        await saveModuleRule({
          id: existing[0].id, keywords: keywords.join(','), module, main_category: '硬件类', sub_category: '', source: 'learned',
        });
        learned++;
      }
    } catch (e) {
      console.error(`模块「${module}」规则学习失败:`, e);
    }
  }
  return learned;
}

// 通用列名识别：从供应商BOM表头猜测字段
const COL_KEYS: Record<string, string[]> = {
  name: ['器件名称', '名称', 'name', 'part_name', 'Description', '物料名称', '品名', '器件', '料名'],
  model: ['型号', 'model', 'part_model', 'MPN', '料号', '规格型号', '型号规格'],
  cost: ['单价', 'cost', '价格', 'price', '成本', 'unit_price', '不含税单价', '报价'],
  qty: ['数量', 'quantity', 'qty', '用量', '数量/台', '单机用量'],
  category: ['分类', '类别', 'category', '物料分类', '类型'],
  remark: ['备注', 'remark', 'note', '说明'],
};

function detectColumn(row: any): { name: string; model: string; cost: string; qty: string; remark: string } {
  const keys = Object.keys(row);
  const find = (cands: string[]) => cands.find(c => keys.some(k => k.trim().toLowerCase() === c.toLowerCase()));
  return {
    name: find(COL_KEYS.name) || keys[0] || '名称',
    model: find(COL_KEYS.model) || '',
    cost: find(COL_KEYS.cost) || '',
    qty: find(COL_KEYS.qty) || '',
    remark: find(COL_KEYS.remark) || '',
  };
}

// 解析Excel为统一的行结构（带诊断信息）
function parseSupplierBOM(file: File): Promise<{
  rows: any[];
  skipped: { row: number; reason: string }[];
  headerFound: boolean;
  totalDataRows: number;
}> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const wb = XLSX.read(e.target?.result, { type: 'binary' });
        if (!wb.SheetNames.length) { reject(new Error('文件中没有工作表')); return; }
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(firstSheet, { defval: '' });
        if (!rows.length) { reject(new Error('工作表为空，请检查文件内容')); return; }

        // 找到表头行（含器件名关键词）
        const headerIdx = rows.findIndex(r => {
          const vals = Object.values(r).map(v => String(v).toLowerCase());
          return vals.some(v => v.includes('器件') || v.includes('名称') || v.includes('name') || v.includes('料') || v.includes('description') || v.includes('品名'));
        });
        const headerRow = headerIdx >= 0 ? rows[headerIdx] : rows[0];
        const cols = detectColumn(headerRow);
        const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;

        // 校验表头：必须识别到"名称"列，否则模板有问题
        const headerFound = !!cols.name && cols.name !== '名称'; // 如果没匹配到候选列，detectColumn回退到keys[0]
        if (!cols.name) { reject(new Error('无法识别器件名称列。请确认表头包含「器件名称/名称/品名/name」等列名')); return; }

        const parsed: any[] = [];
        const skipped: { row: number; reason: string }[] = [];
        let totalDataRows = 0;
        for (let i = startIdx; i < rows.length; i++) {
          const row = rows[i];
          totalDataRows++;
          // 跳过全空行
          const allEmpty = Object.values(row).every(v => String(v).trim() === '');
          if (allEmpty) continue;
          const name = String(row[cols.name] || '').trim();
          if (!name) {
            skipped.push({ row: i + 1, reason: '缺少器件名称' });
            continue;
          }
          const costStr = cols.cost ? String(row[cols.cost] || '').trim() : '';
          const cost = parseFloat(costStr.replace(/[¥￥,\s]/g, '')) || 0;
          if (!cols.cost) skipped.push({ row: i + 1, reason: '未识别到单价列' });
          else if (!cost && costStr) skipped.push({ row: i + 1, reason: `单价「${costStr}」无法解析` });
          parsed.push({
            name,
            model: cols.model ? String(row[cols.model] || '').trim() : '',
            cost,
            qty: cols.qty ? parseInt(String(row[cols.qty] || '1')) || 1 : 1,
            remark: cols.remark ? String(row[cols.remark] || '') : '',
          });
        }
        resolve({ rows: parsed, skipped, headerFound, totalDataRows });
      } catch (err: any) { reject(new Error(`文件解析失败: ${err?.message}`)); }
    };
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsBinaryString(file);
  });
}

// 建立"已有分类经验库"：
// - 器件库里的器件 → 大类/子类经验
// - 项目BOM里的器件+模块 → 模块划分经验（同一器件可能出现在多个模块）
async function buildExistingPartKnowledge() {
  const db = await getDb();
  // 器件库：name(+model) → 大类/子类
  const parts = await db.select<any[]>(`SELECT name, model, main_category, sub_category FROM parts`);
  const exactCat: Record<string, { main_category: string; sub_category: string; count: number }> = {};
  const nameCat: Record<string, Record<string, number>> = {};
  parts.forEach(p => {
    const key = `${p.name}__${p.model || ''}`;
    if (!exactCat[key]) exactCat[key] = { main_category: p.main_category || '硬件类', sub_category: p.sub_category || '', count: 0 };
    exactCat[key].count++;
    const nk = p.name.trim();
    if (!nameCat[nk]) nameCat[nk] = {};
    const ck = `${p.main_category || '硬件类'}/${p.sub_category || ''}`;
    nameCat[nk][ck] = (nameCat[nk][ck] || 0) + 1;
  });
  // 项目BOM：器件 → 所属模块（统计每个器件出现在哪些模块）
  const boms = await db.select<any[]>(`SELECT pb.part_id, pb.module_name, p.name, p.model FROM project_boms pb JOIN parts p ON pb.part_id = p.id WHERE COALESCE(pb.is_deleted,0)=0 AND pb.module_name != '' AND pb.module_name != '未归类'`);
  // 模块库：module_items 也有器件+模块对应关系，且模块名在 modules.name
  const modItems = await db.select<any[]>(`SELECT mi.part_name, mi.part_model, m.name as module_name FROM module_items mi JOIN modules m ON mi.module_id = m.id WHERE m.name != ''`);
  const nameModules: Record<string, Record<string, number>> = {};
  const exactModules: Record<string, Record<string, number>> = {};
  const recordModule = (n: string, mod: string, model = '') => {
    const nk = n.trim();
    if (!nameModules[nk]) nameModules[nk] = {};
    nameModules[nk][mod] = (nameModules[nk][mod] || 0) + 1;
    const ek = `${n}__${model || ''}`;
    if (!exactModules[ek]) exactModules[ek] = {};
    exactModules[ek][mod] = (exactModules[ek][mod] || 0) + 1;
  };
  boms.forEach(b => recordModule(b.name, b.module_name, b.model));
  modItems.forEach(m => recordModule(m.part_name, m.module_name, m.part_model));
  return { exactCat, nameCat, nameModules, exactModules };
}

// 用已有分类经验 + 本地模型混合分类
async function classifyBOMWithAI(
  ollamaUrl: string, model: string,
  rows: any[],
  knownModules: { name: string; category: string }[],
  onProgress?: (done: number, total: number, summary: string) => void,
): Promise<any[]> {
  const db = await getDb();
  // ===== 连接预检：Ollama 不可达立即失败，不假装分析 =====
  {
    let reachable = false;
    for (const u of [ollamaUrl.replace(/\/$/, ''), 'http://127.0.0.1:11434']) {
      try {
        const rr = await invoke<{ success: boolean }>('http_get', { request: { url: u + '/api/tags', headers: {}, body: null } });
        if (rr?.success) { reachable = true; break; }
      } catch { /* 试下一个 */ }
    }
    if (!reachable) throw new Error('无法连接 Ollama（' + ollamaUrl + ' 与 127.0.0.1 均不通），请先确认服务已启动并测试连接');
  }
  // 加载用户自定义规则（数据库），分类时优先使用
  const dbRules = await getModuleRules().catch(() => []);
  const knowledge = await buildExistingPartKnowledge();
  const habits = await db.select<any[]>(`SELECT main_category, sub_category, COUNT(*) as c FROM parts GROUP BY main_category, sub_category ORDER BY c DESC LIMIT 30`);
  const knownModsStr = knownModules.length ? knownModules.map(m => `${m.name}${m.category && m.category !== '未分类' ? '(' + m.category + ')' : ''}`).join('、') : '（暂无历史模块）';
  const habitStr = habits.length ? habits.map(h => `${h.main_category}/${h.sub_category||'-'}(${h.c}次)`).join('、') : '';

  const systemPrompt = `你是BOM分类助手。用户会给你器件清单，你必须输出一个JSON对象，格式为：
{"results":[{"name":"器件原名","module":"模块名","main_category":"大类","sub_category":"子类","confidence":0到1数字}]}

规则：
1. module 只从这些里选：电源模块、显示模块、驱动板模块、控制板模块、结构件、包装材料、连接线材、声学模块、背光模块、散热组件、接口模块、其他。
2. main_category 只从这些里选：${MAIN_CATEGORIES.join('、')}。
3. 各模块包含的典型器件（据此判断归属）：
   - 电源模块：电源管理IC、电解电容、陶瓷电容、贴片电阻、电感、MOS管、变压器、整流二极管、稳压器、DC-DC
   - 显示模块：面板、LCD屏、液晶玻璃、偏光片、导光板、光学膜
   - 背光模块：背光模组、灯条、LED灯珠、背光驱动
   - 驱动板模块：Scaler芯片、TCON、主控芯片、DDR内存、eMMC、Flash、晶振、PCB主板
   - 控制板模块：MCU、按键板、OSD控制板、电源按键
   - 接口模块：HDMI接口、DP接口、Type-C接口、USB接口、VGA接口
   - 结构件：前框、后壳、底座、立柱、中框、支架、螺丝、散热片
   - 包装材料：外箱、内卡、珍珠棉、PE袋、说明书、标签、贴纸
   - 连接线材：HDMI线、DP线、电源线、排线、FFC、LVDS线
   - 声学模块：喇叭、扬声器、麦克风
   - 散热组件：散热片、风扇、导热垫
   - 其他：加工费、测试费、组装费
4. 器件名后的【历史模块分布:xx】表示你历史里这个器件分到哪些模块，优先沿用次数最多的。
5. 只输出这个JSON对象，results数组长度必须等于输入器件数，顺序一一对应。

系统已有的模块（优先沿用）：${knownModsStr}
器件库已有的分类习惯（供子类参考）：${habitStr}`;

  const BATCH = 5;
  // 用索引精确映射分类结果（existing直接按idx，AI按toAsk顺序）
  const resultByIdx: Record<number, any> = {};
  // 累计收到的字符数（跨批次不归零，让进度连续可感知）
  let cumulativeChars = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let existingCount = 0;
    let aiCount = 0;
    // 先尝试用已有经验直接匹配
    const toAsk: { row: any; idx: number }[] = [];
    batch.forEach((row, offset) => {
      const idx = i + offset;
      const name = row.name.trim();
      const model = row.model || '';
      const exactKey = `${name}__${model}`;

      // 1) 完全匹配：同型号同名称的器件，直接用已有大类/子类 + 模块
      const exactMods = knowledge.exactModules[exactKey];
      const exactCat = knowledge.exactCat[exactKey];
      if (exactMods && Object.keys(exactMods).length > 0) {
        const mods = Object.entries(exactMods).sort((a, b) => b[1] - a[1]);
        resultByIdx[idx] = {
          name, model,
          module: mods[0][0],
          main_category: exactCat?.main_category || '硬件类',
          sub_category: exactCat?.sub_category || '',
          confidence: 1.0,
          source: 'existing',
        };
        existingCount++;
        return;
      }
      // 2) 名称匹配：同名称（不同型号）有分类经验
      const nameMods = knowledge.nameModules[name];
      const nameCats = knowledge.nameCat[name];
      if (nameMods && Object.keys(nameMods).length > 0) {
        // 单一主导模块 → 直接沿用；多个模块 → 交给AI但带上下文
        const mods = Object.entries(nameMods).sort((a, b) => b[1] - a[1]);
        if (mods.length === 1 || mods[0][1] / totalOccurrences(mods) >= 0.7) {
          const cat = dominantCat(nameCats);
          resultByIdx[idx] = {
            name, model,
            module: mods[0][0],
            main_category: cat?.main || '硬件类',
            sub_category: cat?.sub || '',
            confidence: 0.95,
            source: 'existing',
          };
          existingCount++;
          return;
        }
      }
      // 3) 规则引擎：确定性关键词匹配（比让弱模型"感觉"可靠）
      const ruleHit = classifyByRule(name, dbRules);
      if (ruleHit) {
        resultByIdx[idx] = {
          name, model,
          module: ruleHit.module,
          main_category: ruleHit.mainCat,
          sub_category: ruleHit.sub,
          confidence: 0.98,
          source: 'rule',
        };
        existingCount++;
        return;
      }
      // 4) 无历史、规则未命中 → 交给AI，带上已有的名称分类作为参考
      toAsk.push({ row, idx });
    });

    if (toAsk.length > 0) {
      const itemList = toAsk.map(({ row }) => {
        const name = row.name.trim();
        const modDist = knowledge.nameModules[name];
        const catDist = knowledge.nameCat[name];
        let hint = '';
        if (modDist) {
          const dist = Object.entries(modDist).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}:${c}次`).join(', ');
          hint += `【历史模块分布: ${dist}】`;
        }
        if (catDist) {
          const dist = Object.entries(catDist).sort((a, b) => b[1] - a[1]).map(([c]) => c).join('、');
          hint += `【历史分类: ${dist}】`;
        }
        return `${row.name}${row.model ? `(${row.model})` : ''}${hint}`;
      }).join('\n');
      try {
        // 用流式请求替代一次性等待：每吐一个token都有反馈，不会"卡死无进展"
        let fullText = '';
        let reasoningText = '';
        let streamErr = '';
        let streamDone = false;
        await new Promise<void>((resolve) => {
          const finish = () => { if (!streamDone) { streamDone = true; resolve(); } };
          startOllamaStream(
            ollamaUrl, model,
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `给这些器件分类，严格按这个例子输出JSON对象（不要其他文字）：
例子输入：
["面板 27寸(M270QAN02.0)", "电源管理IC(MP3394)", "前框 27寸", "外箱(瓦楞纸)"]
例子输出：
{"results":[{"name":"面板 27寸(M270QAN02.0)","module":"显示模块","main_category":"硬件类","sub_category":"面板","confidence":0.95},{"name":"电源管理IC(MP3394)","module":"电源模块","main_category":"电源类","sub_category":"电源管理IC","confidence":0.95},{"name":"前框 27寸","module":"结构件","main_category":"结构类","sub_category":"前框","confidence":0.95},{"name":"外箱(瓦楞纸)","module":"包装材料","main_category":"包材类","sub_category":"外箱","confidence":0.95}]}

现在分类这些器件：
${itemList}` },
            ],
            (token) => {
              fullText += token;
              cumulativeChars += token.length;
              // 每收到一些 token 就上报一次进度，让界面有实时进展（不卡死感）
              if (onProgress && cumulativeChars % 40 < 5) {
                onProgress?.(Math.min(i + BATCH, rows.length), rows.length, `AI正在生成分类…累计收到 ${cumulativeChars} 字符`);
              }
            },
            (t) => { reasoningText += t; }, // 不丢弃思考内容，作为 content 为空时的兜底
            () => { finish(); }, // done
            (e) => { streamErr = e; finish(); }, // error
            { num_predict: 1500, temperature: 0.2, think: false, endpoint: 'native' }, // 原生端点，think:false 确定生效
          ).then(cleanup => { setTimeout(cleanup, 30000); }); // 完成后30秒清理监听器
          // 超时保护：3分钟仍无任何响应则明确失败（不能假装完成/走兜底）
          setTimeout(() => { if (!streamDone) { streamErr = streamErr || 'Ollama 无响应（超过 180 秒未返回任何内容），请确认服务正常'; finish(); } }, 180000);
        });
        // 审计日志：智能导入分类（本地模型）
        logLocalAICall({
          request_type: 'bom_classify',
          material_name: (itemList || '').slice(0, 100),
          system_prompt: systemPrompt.slice(0, 1500),
          user_prompt: (itemList || '').slice(0, 1500),
          response_summary: (fullText || '').slice(0, 200),
          success: !streamErr,
          error_message: streamErr || '',
          model_name: model,
        });
        if (streamErr) throw new Error(streamErr);
        let text = fullText.trim() || reasoningText.trim();
        // 诊断：打印模型原始输出前300字符，便于排查字段缺失
        // 兼容：模型可能输出 ```json 包裹或带说明文字
        // 先剥掉 markdown 代码块
        text = text.replace(/```json/gi, '').replace(/```/g, '');
        // 定位第一个 [ 到最后一个 ]（排除被说明文字包裹的情况）
        const firstBracket = text.indexOf('[');
        const lastBracket = text.lastIndexOf(']');
        let hadArray = firstBracket !== -1 && lastBracket > firstBracket;
        if (hadArray) {
          text = text.slice(firstBracket, lastBracket + 1);
        }
        // 清理可能的尾逗号（JSON5风格）
        text = text.replace(/,\s*]/g, ']');
        // 如果找不到 JSON 数组，直接按大类兜底给整批分类（保证 module 有值）
        if (!hadArray) {
          console.warn('[BOM分类] 未找到JSON数组，使用大类兜底分类');
          const MODULE_BY_CATEGORY: Record<string, string> = {
            '电源类': '电源模块', '结构类': '结构件', '线材类': '连接线材',
            '包材类': '包装材料', '软件类': '控制板模块', '硬件类': '驱动板模块',
            '加工费类': '其他', '其他': '其他',
          };
          toAsk.forEach(({ row, idx }) => {
            // 尝试从器件名推断大类
            const n = row.name.toLowerCase();
            let cat = '其他';
            if (/电源|ac-dc|dc-dc|变压器|电解|mos|整流|电感/.test(n)) cat = '电源类';
            else if (/框|壳|座|柱|螺丝|支架|散热/.test(n)) cat = '结构类';
            else if (/线|排线|ffc|lvds/.test(n)) cat = '线材类';
            else if (/箱|卡|袋|说明书|标签|贴纸/.test(n)) cat = '包材类';
            else if (/软件|firmware|驱动/.test(n)) cat = '软件类';
            else if (/smt|组装|测试|贴片|dip/.test(n)) cat = '加工费类';
            else cat = '硬件类';
            resultByIdx[idx] = {
              name: row.name, module: MODULE_BY_CATEGORY[cat] || '其他',
              main_category: cat, sub_category: '', confidence: 0.4, source: 'ai',
            };
          });
          aiCount += toAsk.length;
        } else {
        try {
          const parsed = JSON.parse(text);
          // 兼容两种结构：裸数组 或 {"results":[...]}
          const arr = Array.isArray(parsed) ? parsed : (parsed?.results || []);
          if (Array.isArray(arr)) {
            // AI返回数组，按 toAsk 顺序对齐到原始索引
            arr.forEach((r: any, aiIdx: number) => {
              const target = toAsk[aiIdx];
              if (target) {
                // 兼容模型输出的各种字段名（module / module_name / mod / 模块 / 所属模块 等）
                // 兼容 main_category 字段名变体
                const catVal = r.main_category ?? r.mainCategory ?? r['大类'] ?? r['主类'];
                const modVal = r.module ?? r.module_name ?? r.mod ?? r['模块'] ?? r['所属模块'] ?? r['模块名'];
                // 过滤掉模型可能输出的占位值
                let cleanMod = String(modVal ?? '').trim();
                if (cleanMod && ['未归类','未分类','unknown','none','null','-'].includes(cleanMod.toLowerCase())) cleanMod = '';
                // 大类→模块启发式兜底：即使模型没给module，也能保证有合理值
                if (!cleanMod) {
                  const MODULE_BY_CATEGORY: Record<string, string> = {
                    '电源类': '电源模块', '结构类': '结构件', '线材类': '连接线材',
                    '包材类': '包装材料', '软件类': '控制板模块', '硬件类': '驱动板模块',
                    '加工费类': '其他', '其他': '其他',
                  };
                  cleanMod = MODULE_BY_CATEGORY[catVal] || '其他';
                }
                const subVal = r.sub_category ?? r.subCategory ?? r['子类'] ?? r['小类'];
                resultByIdx[target.idx] = {
                  name: r.name || target.row.name,
                  module: cleanMod || '未归类',
                  main_category: MAIN_CATEGORIES.includes(catVal) ? catVal : '硬件类',
                  sub_category: subVal || '',
                  confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
                  source: 'ai',
                };
              }
              aiCount++;
            });
          }
        } catch (parseErr) {
          console.error('JSON解析失败，原始文本:', text.slice(0, 200));
          aiCount += toAsk.length;
        }
        } // else: 有JSON数组的分支结束
      } catch (e) {
        console.error('分类批次失败:', e);
        // 该批失败 → 这些器件会走规则/历史兜底（调用方会提示兜底数量），不静默假装成功
        aiCount += toAsk.length;
      }
    }
    onProgress?.(Math.min(i + BATCH, rows.length), rows.length, `本批 ${existingCount} 个沿用历史，${aiCount} 个AI分析`);
  }

  // 合并：用 resultByIdx 按索引精确映射（existing直接按idx，AI按toAsk顺序）
  return rows.map((r, ridx) => {
    const res = resultByIdx[ridx];
    if (!res) {
      // 没有任何分类结果（可能该批失败）→ 先用规则引擎兜底，规则未命中才未归类
      const ruleHit = classifyByRule(r.name, dbRules);
      if (ruleHit) {
        return {
          ...r,
          module: ruleHit.module,
          main_category: ruleHit.mainCat,
          sub_category: ruleHit.sub,
          confidence: 0.98,
          source: 'rule',
        };
      }
      return {
        ...r,
        module: '未归类',
        main_category: MAIN_CATEGORIES.includes(r.main_category) ? r.main_category : '硬件类',
        sub_category: r.sub_category || '',
        confidence: 0.3,
        source: 'ai',
      };
    }
    return {
      ...r,
      module: res.module || '未归类',
      main_category: MAIN_CATEGORIES.includes(res.main_category) ? res.main_category : '硬件类',
      sub_category: res.sub_category || '',
      confidence: typeof res.confidence === 'number' ? res.confidence : 0.5,
      source: res.source || 'ai',
    };
  });
}

// 辅助函数：统计总次数
function totalOccurrences(mods: [string, number][]): number {
  return mods.reduce((s, [, c]) => s + c, 0);
}
// 辅助函数：取主导分类
function dominantCat(cats: Record<string, number> | undefined) {
  if (!cats) return null;
  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const [main, sub] = entries[0][0].split('/');
  return { main, sub };
}
// ===== 云端助手工具定义（本地模型对话中自主调用云端大模型） =====
// 安全：工具描述强制"通用名"；参数在 aiBridge.validateCloudQueryArgs 二次校验（型号/金额/供应商/项目代号 全拦）
const CLOUD_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'cloud_query',
    description: '需要实时行业行情、供需状况或更强的分析能力时，调用云端大模型辅助判断。注意：云端只能提供行业趋势/供需/参考区间（无法获取具体采购价格，具体价格以本地数据为准）。参数必须使用物料通用名称（严禁型号、金额、供应商名称、项目编号）。',
    parameters: {
      type: 'object',
      properties: {
        material: { type: 'string', description: '物料通用名称，如 液晶面板、PCB、锂电池（严禁型号/编号）' },
        category: { type: 'string', description: '物料品类，如 显示器件、硬件类' },
        question: { type: 'string', description: '要查询的具体问题，一句话' },
      },
      required: ['material', 'question'],
    },
  },
};

export default function LocalAIAssistant() {
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [connStatus, setConnStatus] = useState<'idle'|'ok'|'fail'>('idle');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number|null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // ===== 自主建议（后台分析引擎） =====
  const [advisorList, setAdvisorList] = useState<any[]>([]);
  const [advisorTab, setAdvisorTab] = useState<'chat' | 'advice' | 'think'>('chat'); // 主视图：对话 / 自主建议 / 自主分析
  // AI 活动记录：回溯本地模型今天都做了什么（ai_request_logs 本地留痕）
  const [aiLogs, setAiLogs] = useState<any[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const loadAiLogs = async () => {
    try { setAiLogs(await getAllAIRequestLogs(15)); } catch { /* 忽略 */ }
  };
  const [advisorRunning, setAdvisorRunning] = useState(false);
  const [advisorShowDone, setAdvisorShowDone] = useState(false);
  const [advisorLastRun, setAdvisorLastRun] = useState('');
  const [advisorProgress, setAdvisorProgress] = useState('');
  const [advisorInsightBusy, setAdvisorInsightBusy] = useState<number | null>(null);
  const [advisorShowPrompt, setAdvisorShowPrompt] = useState<number | null>(null); // 展开提示词的卡片 id
  const [bridgeReviewPrompt, setBridgeReviewPrompt] = useState<string | null>(null); // 云端发送前预览
  const [bridgeReviewResolve, setBridgeReviewResolve] = useState<((ok: boolean) => void) | null>(null);
  const [bridgeReviewMode, setBridgeReviewMode] = useState<'auto' | 'preview'>('auto'); // 云端发送前预览开关
  const [cloudToolMode, setCloudToolMode] = useState(true); // 对话中本地模型自主调用云端
  const [cloudDailyLimit, setCloudDailyLimit] = useState(50); // 每日云端调用上限
  const [bridgeReuseInfo, setBridgeReuseInfo] = useState<{ ins: any; recent: any } | null>(null); // 复用确认
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // ===== Agent 模式（P1：工具注册表 + 计划-执行-总结） =====
  const [chatMode, setChatMode] = useState<'chat' | 'agent' | 'think'>('chat'); // 输入框模式：普通对话 / Agent 任务 / 自主分析
  // 自主分析（think）运行态：思考流/工具卡/云端申请/最终回答（DSH 式过程渲染）
  const [thinkRun, setThinkRun] = useState<{
    user: string;
    thoughts: string[];
    tools: { name: string; args: any; result: string; ok: boolean }[];
    clouds: { material: string; question: string; status: 'pending' | 'approved' | 'rejected'; result?: string }[];
    answer: string;
    status: 'running' | 'done' | 'error';
    error?: string;
    round: number;
  } | null>(null);
  const [agentTrace, setAgentTrace] = useState<any[]>([]); // 工具执行轨迹（[{name,argsText,status,result}]）
  const [agentTraceOpen, setAgentTraceOpen] = useState(true);
  // ===== AI 学习（v2.3.19：👍/👎 反馈 + 学习档案） =====
  const [feedbackMap, setFeedbackMap] = useState<Record<number, 'up' | 'down'>>({});   // 按消息 index 记录已反馈
  const [feedbackModal, setFeedbackModal] = useState<{ index: number; userText: string } | null>(null);
  const [feedbackReason, setFeedbackReason] = useState('vague');
  const [feedbackCustom, setFeedbackCustom] = useState('');
  const [showLearn, setShowLearn] = useState(false);       // 学习档案弹窗
  const [toolsOpen, setToolsOpen] = useState(false);       // 数据分析工具抽屉（Demo B 重构）
  const [learnRules, setLearnRules] = useState<any[]>([]);
  const [learnFocus, setLearnFocus] = useState<{ topic: string; weight: number }[]>([]);
  const loadLearnData = async () => {
    try {
      const m = await import('../aiLearning');
      setLearnRules(await m.getLearnedRules());
      setLearnFocus(m.focusRanked(await m.getUserFocus()));
    } catch { /* 静默 */ }
  };
  const [elapsed, setElapsed] = useState(0); // 生成过程计时（秒）
  const [streamRate, setStreamRate] = useState(0); // 生成速度（字符/秒）
  const [contextEntries, setContextEntries] = useState<ContextEntry[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [showContext, setShowContext] = useState(false);
  // 分类规则管理
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<any[]>([]);
  const [ruleForm] = Form.useForm();
  const [ruleEditing, setRuleEditing] = useState<any>(null);
  const [ruleLearning, setRuleLearning] = useState(false);
  const [ruleLearnInfo, setRuleLearnInfo] = useState<{ module: string; done: number; total: number; elapsed: number; chars: number } | null>(null);
  const [ruleFormVisible, setRuleFormVisible] = useState(false);
  const [ctxTitle, setCtxTitle] = useState('');
  const [ctxContent, setCtxContent] = useState('');
  // 演示生成（HTML/PPT，本地 AI）——独立新功能，不影响聊天/知识库逻辑
  const [showDemo, setShowDemo] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [selProjects, setSelProjects] = useState<number[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [netLocked, setNetLocked] = useState(false);
  const [netOllamaFound, setNetOllamaFound] = useState(true);
  const [netBusy, setNetBusy] = useState(false);
  const [netStatusLoaded, setNetStatusLoaded] = useState(false);
  const [netWarnDismissed, setNetWarnDismissed] = useState(false);
  const [phase, setPhase] = useState<'idle'|'fetching'|'thinking'|'querying'|'streaming'>('idle');
  const cleanupRef = useRef<(() => void) | null>(null);
  const stoppedRef = useRef(false); // 用户停止标记（跨查询轮次生效）
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followScrollRef = useRef(true); // 是否跟随滚动到底部
  const [showJumpDown, setShowJumpDown] = useState(false);
  // 智能BOM导入状态
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importSkipped, setImportSkipped] = useState<{ row: number; reason: string }[]>([]);
  const [importHeaderFound, setImportHeaderFound] = useState(true);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importStep, setImportStep] = useState(0);
  const [importClassifying, setImportClassifying] = useState(false);
  const [classifyInfo, setClassifyInfo] = useState<{ done: number; total: number; summary: string; elapsed: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importTargetProject, setImportTargetProject] = useState<number | undefined>(undefined);
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [newProjectCode, setNewProjectCode] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [knownModules, setKnownModules] = useState<{ name: string; category: string }[]>([]);

  // 查询 Ollama 联网隔离状态（每次打开设置时刷新）
  const refreshNetStatus = useCallback(async () => {
    try {
      const r = await invoke<{ ollama_found: boolean; blocked: boolean }>('ollama_net_status');
      setNetLocked(r.blocked);
      setNetOllamaFound(r.ollama_found);
    } catch (e) { console.error('查询网络状态失败:', e); }
    setNetStatusLoaded(true);
  }, []);

  // 一键封禁/解封 Ollama 联网
  const toggleNetLock = useCallback(async (lock: boolean) => {
    setNetBusy(true);
    try {
      await invoke('ollama_net_set_block', { block: lock });
      setNetLocked(lock);
      message.success(lock ? '已封禁 Ollama 联网，成本数据无法外传' : '已解除封禁，Ollama 可联网');
    } catch (e: any) {
      message.error(String(e?.message || e));
    } finally { setNetBusy(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const url = await getSetting('local_ai_base_url', 'http://localhost:11434');
      const mdl = await getSetting('local_ai_model', '');
      setOllamaUrl(url); setModel(mdl);
      setBridgeReviewMode((await getSetting('ai_bridge_review', 'auto')) === 'preview' ? 'preview' : 'auto');
      setCloudToolMode((await getSetting('ai_local_cloud_tool', 'on')) !== 'off');
      setCloudDailyLimit(Math.max(1, Number(await getSetting('ai_usage_cloud_daily_limit', '50')) || 50));
      const db = await getDb();
      const projs = await db.select<any[]>('SELECT id,code,name FROM projects WHERE COALESCE(is_deleted,0)=0 ORDER BY code');
      setProjects(projs);
      setSessions(await loadSessions());
      setContextEntries(await loadContextEntries());
      // 加载已知模块，供智能BOM导入参考
      const mods = await db.select<any[]>(`SELECT DISTINCT name, module_category FROM modules WHERE name != ''`);
      setKnownModules(mods.map((m: any) => ({ name: m.name, category: m.module_category || '未分类' })));
    })();
    // 启动时自动检查 Ollama 联网隔离状态
    refreshNetStatus();
  }, []);

  // 智能跟随滚动：仅当用户位于底部附近时才自动滚到底部；
  // 用户向上回看已生成内容时，不强制打断
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 距底部 120px 内视为"在底部"，否则暂停自动跟随
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    followScrollRef.current = atBottom;
    setShowJumpDown(!atBottom && streaming);
  }, [streaming]);

  // 流式生成计时器：每秒递增，让用户看到"系统在动"
  useEffect(() => {
    if (!streaming) return;
    setElapsed(0); setStreamRate(0);
    const start = Date.now();
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 200);
    return () => clearInterval(iv);
  }, [streaming]);

  // AI分类计时器：每10秒刷新一次进度显示
  useEffect(() => {
    if (!importClassifying) return;
    const start = Date.now();
    const iv = setInterval(() => {
      setClassifyInfo(prev => prev ? { ...prev, elapsed: Math.floor((Date.now() - start) / 1000) } : prev);
    }, 1000);
    return () => clearInterval(iv);
  }, [importClassifying]);

  // 规则学习计时器
  useEffect(() => {
    if (!ruleLearning) return;
    setRuleLearnInfo(prev => prev ? { ...prev, elapsed: 0 } : prev);
    const start = Date.now();
    const iv = setInterval(() => {
      setRuleLearnInfo(prev => prev ? { ...prev, elapsed: Math.floor((Date.now() - start) / 1000) } : prev);
    }, 1000);
    return () => clearInterval(iv);
  }, [ruleLearning]);

  // 连接失败的具体原因（诊断用）
  const [connError, setConnError] = useState('');
  const testConnection = useCallback(async (silent = false) => {
    setConnStatus('idle');
    setConnError('');
    // 多地址兜底：公司代理环境会把 localhost 请求转发到代理服务器（代理连自己机器上的 localhost 失败 → 504）；
    // 配置的是 localhost 时先试 127.0.0.1（IP 字面量绕过代理/DNS），失败再试配置地址
    const candidates = [...new Set([
      ...(ollamaUrl.includes('localhost') ? ['http://127.0.0.1:11434'] : []),
      ollamaUrl.replace(/\/$/, ''),
      'http://127.0.0.1:11434',
    ])];
    let lastErr = '';
    for (const base of candidates) {
      try {
        const result = await invoke<{ status: number; body: string; success: boolean }>('http_get', {
          request: { url: `${base}/api/tags`, headers: {}, body: null }
        });
        if (!result.success) { lastErr = 'HTTP ' + result.status + (result.body ? '：' + result.body.slice(0, 400) : ''); continue; }
        const data = JSON.parse(result.body);
        const list: string[] = (data.models || []).map((m: any) => m.name);
        setModels(list);
        // 配置的模型不存在时自动切换为第一个可用模型
        if (list.length > 0) {
          const current = model || '';
          if (!list.includes(current)) { setModel(list[0]); await setSetting('local_ai_model', list[0]); }
        }
        setConnStatus('ok');
        await setSetting('local_ai_base_url', base);
        if (!silent && base !== ollamaUrl.replace(/\/$/, '')) {
          message.success('已通过 127.0.0.1 连接（localhost 解析异常已自动切换）');
        }
        return;
      } catch (e: any) {
        lastErr = String(e?.message || e);
      }
    }
    setConnStatus('fail');
    setConnError(lastErr.slice(0, 200));
    if (!silent) message.error('Ollama 连接失败：' + lastErr.slice(0, 150));
  }, [ollamaUrl, model]);

  // 连接状态自动探测（2026-08-17）：挂载立即静默探测 + 30 秒周期自检——绿点与实际 Ollama 连接实时关联，不再一直是灰色
  useEffect(() => {
    testConnection(true);
    const iv = setInterval(() => testConnection(true), 30 * 1000);
    return () => clearInterval(iv);
  }, [testConnection]);

  const startSession = useCallback(async (title = '新对话') => {
    const id = await newSession(title);
    setSessions(await loadSessions());
    setSessionId(id); setMessages([]);
  }, []);

  const switchSession = useCallback(async (id: number) => {
    setSessionId(id);
    setMessages(await loadMessages(id));
  }, []);

  const buildSystemPrompt = useCallback(async (userContent = '') => {
    const entries = await loadContextEntries();
    // 召回相关记忆
    const mems = await recallMemories(userContent);
    const persona = `你是CostHub的资深成本管理顾问，有20年ODM电子整机成本经验，帮品牌方审核显示器、PC等产品BOM。你说话直接、专业、给结论，像带徒弟的老师傅。

风格要求：
1. 开场先给结论（"这个BOM有3个问题"），再展开细节
2. 给具体数字和依据，引用数据时要准确
3. 谈价建议要具体：给出谈价空间、理由、话术
4. 不用"可能""或许"这类含糊词，能用数据判断就直接判断
5. 结构清晰，但避免教科书式的空话，像给同事看的分析报告

你读到的数据是真实的成本数据库内容，直接基于数据回答。如果数据不足以回答，明确说"这个需要看XX数据"，而不是瞎编。

【长期记忆使用规则】
- 下面提供的"长期记忆"是用户过去告诉你的业务背景、决策、约定，跨对话有效。
- 回答时优先参考相关记忆，让建议符合用户一贯的偏好和策略。
- 如果记忆与当前问题冲突，以最新记忆为准。`;

    const parts: string[] = [persona];

    // 数据库地图：让模型知道可以查什么
    // 相关记忆
    if (mems.length) {
      parts.push(`【相关长期记忆】\n${mems.map(m => `• ${m.content}`).join('\n')}`);
    }

    // 手动背景知识
    if (entries.length) {
      parts.push(`【用户背景知识】\n${entries.map(e => `【${e.title}】\n${e.content}`).join('\n\n')}`);
    }

    return parts.join('\n\n');
  }, []);

  // ===== 对话后自动提炼记忆（后台，不阻塞对话） =====
  const extractMemories = useCallback(async (sessionId: number, userContent: string, assistantContent: string) => {
    try {
      const extractionPrompt = `你是记忆提炼器。根据下面的一段对话，提取"值得长期记住的用户业务信息"。
只提取对以后分析有帮助的持久事实，例如：公司策略、成本目标、供应商关系、产品线计划、价格偏好、组织情况等。
**不要**提取：一次性的请求、纯数据表格、寒暄、明确会被更新的临时信息。
输出要求：每行一条，用短句陈述事实（20-50字），不要编号，不要解释。如果没有值得记的，输出"无"。`;

      const convText = `用户：${userContent}\n助手：${assistantContent}`;
      const result = await invoke<{ success: boolean; body: string }>('http_post', {
        request: {
          url: `${ollamaUrl.replace(/\/$/, '')}/v1/chat/completions`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: extractionPrompt },
              { role: 'user', content: convText },
            ],
            stream: false, temperature: 0.2, num_predict: 300,
            // 关键：记忆提炼也关闭思考，避免CPU上等待过久
            think: false,
          }),
        }
      });
      if (!result.success) return;
      const data = JSON.parse(result.body);
      const text = data?.choices?.[0]?.message?.content || '';
      const lines = text.split('\n').map((s: string) => s.trim()).filter((s: string) => s && s !== '无' && s.length >= 8);
      for (const line of lines.slice(0, 5)) {
        await saveMemory(line.replace(/^[-•*\d.、\s]+/, ''), 'general', sessionId);
      }
    } catch (e) {
      // 记忆提炼失败不影响主对话
      console.error('记忆提炼失败:', e);
    }
  }, [ollamaUrl, model]);

  const sendMessage = useCallback(async (userContent: string) => {
    if (!userContent.trim() || streaming) return;
    if (!model) { message.warning('请先连接Ollama并选择模型'); return; }
    // AI 学习：自动记录用户关注主题（失败静默）
    import('../aiLearning').then(m => m.trackUserFocus(userContent)).catch(() => {});
    const cloudToolEnabled = (await getSetting('ai_local_cloud_tool', 'on')) !== 'off';
    let sid = sessionId;
    if (!sid) {
      sid = await newSession(userContent.slice(0, 20));
      setSessions(await loadSessions()); setSessionId(sid);
    }
    const userMsg: ChatMessage = { role: 'user', content: userContent };
    setMessages(prev => [...prev, userMsg]);
    await saveMsg(sid, 'user', userContent);
    setInput('');

    // 先显示助手占位气泡（"正在读取数据…"），保证界面有反馈
    setStreaming(true);
    setPhase('fetching');
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    const currentSid = sid;

    // ===== 自动获取相关数据（失败不阻塞，继续发问题） =====
    let autoData: { data: string; note: string } = { data: '', note: '' };
    try {
      autoData = await detectAndFetchData(userContent);
    } catch (e: any) {
      console.error('自动读取数据失败:', e);
      autoData = { data: '', note: '' };
    }
    const systemPrompt = await buildSystemPrompt(userContent);
    // AI 学习：注入用户关注偏好与已学逻辑规则（失败静默）
    let prefCtx = '';
    try { prefCtx = await import('../aiLearning').then(m => m.buildPreferenceContext()); } catch { prefCtx = ''; }
    // 云端助手使用规则（克制调用 + 边界认知 + 防重复）：注入系统提示
    const cloudRules = '\n\n【云端助手使用规则】你可以在需要时调用 cloud_query 工具获取实时行业信息，但请遵守：\n1. 克制调用：先用本地知识与库内数据分析，确实需要实时行业趋势/供需信息时才调用；\n2. 边界认知：云端只能提供行业趋势/供需/参考区间，无法获取具体采购价格——结果仅供趋势参考与机会判断；\n3. 一次查询尽量覆盖完整问题，避免碎片化追问；\n4. 已查询过的信息不要重复查询（系统会自动复用最近结果）。';
    const dataBlock = autoData.data
      ? `\n\n【已自动读取的数据库资料（真实数据，请以此为准）】\n${autoData.data}\n`
      : '';
    // 只保留最近6轮历史，避免 CPU 上下文膨胀拖慢生成
    const recentHistory = messages.slice(-12).map(m => ({ role: m.role, content: m.content }));
    const apiMessages = [
      { role: 'system', content: systemPrompt + cloudRules + dataBlock + (prefCtx ? '\n\n' + prefCtx : '') },
      ...recentHistory,
      { role: 'user', content: userContent },
    ].filter(m => m.content);

    setPhase('thinking');
    let full = '';
    let reasoning = '';
    let rateStart = Date.now();
    let rateBase = 0;
    // ===== 流式请求（支持工具调用：本地模型可中途请求云端大模型） =====
    const runStream = (msgs: any[]): Promise<any[]> => new Promise<any[]>((resolve, reject) => {
      const toolCalls: any[] = [];
      const enabledCloudTool = cloudToolEnabled;
      startOllamaStream(
        ollamaUrl, model, msgs,
        (token) => {
          setPhase('streaming');
          full += token;
          const now = Date.now();
          if (now - rateStart > 2000) {
            setStreamRate(Math.round((full.length - rateBase) / ((now - rateStart) / 1000)));
            rateStart = now; rateBase = full.length;
          }
          setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: full, reasoning }; return arr; });
        },
        (token) => {
          reasoning += token;
          setPhase('thinking');
          setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: full, reasoning }; return arr; });
        },
        () => { resolve(toolCalls); },
        (err) => { reject(new Error(err)); },
        {
          endpoint: 'native',
          think: false,
          tools: enabledCloudTool ? [CLOUD_TOOL_DEF] : undefined,
          onToolCalls: (list) => {
            list.forEach(tc => { if (!toolCalls.some(x => JSON.stringify(x) === JSON.stringify(tc))) toolCalls.push(tc); });
          },
        },
      ).then(c => { cleanupRef.current = c; }).catch(() => { /* 错误走 onError */ });
    });
    // 云端工具执行：安全校验 → 用量阈值 → 复用检查 → 云端查询（结果回给本地模型，支持多轮追问）
    const executeCloudQuery = async (tcs: any[], sessionCache: Map<string, string>): Promise<string> => {
      const fn = tcs?.[0]?.function;
      if (!fn || fn.name !== 'cloud_query') return '错误：不支持的云端工具';
      let args: any = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch { return '错误：云端工具参数解析失败'; }
      const { validateCloudQueryArgs } = await import('../aiBridge');
      const v = validateCloudQueryArgs(args);
      if (!v.ok) {
        try {
          await logLocalAICall({ request_type: 'local_chat_cloud_tool', material_name: String(args.material || ''), system_prompt: '工具参数安全校验', user_prompt: fn.arguments.slice(0, 1000), response_summary: '', success: false, error_message: v.reason || '参数校验失败', model_name: model });
        } catch { /* 留痕失败忽略 */ }
        return `云端调用被安全审计拦截：${v.reason}。请换一种说法重新发起（使用物料通用名，不含型号/金额/供应商/项目信息）。`;
      }
      // 用量阈值管控（每日云端请求上限）
      const limit = Math.max(1, Number(await getSetting('ai_usage_cloud_daily_limit', '50')) || 50);
      const usage = await getDailyCloudUsage();
      if (usage.count >= limit) {
        try {
          await logLocalAICall({ request_type: 'local_chat_cloud_tool', material_name: v.clean!.material, system_prompt: '云端用量阈值管控', user_prompt: `material=${v.clean!.material}`, response_summary: '', success: false, error_message: `已达今日云端上限 ${limit} 次`, model_name: model });
        } catch { /* 忽略 */ }
        return `今日云端调用已达上限（${usage.count}/${limit} 次），无法继续查询。请基于本地数据继续分析；如需提高上限可在设置中调整。`;
      }
      // 会话内防重复：同物料本会话已查 → 直接复用结果（不消耗 token）
      const key = materialKey(v.clean!.material, v.clean!.category);
      if (sessionCache.has(key)) {
        return `【复用本会话已查询结果，未消耗新 token】\n${sessionCache.get(key)}\n（如需其他维度信息，可换个问题追问）`;
      }
      // 库内 7 天复用：同物料近期已洞察过 → 直接返回历史结果
      const recent = await getRecentBridgeLog(key, 7);
      if (recent) {
        let rc: any = {};
        try { rc = JSON.parse(recent.cloud_result || '{}'); } catch { rc = {}; }
        const cached = `【云端查询结果（复用 ${(recent.created_at || '').slice(0, 16)} 历史，未消耗新 token）】物料：${recent.material_name || v.clean!.material}\n行情方向：${rc.trend_direction || '未知'} · 置信度：${rc.confidence_level || '未知'}${rc.magnitude_min != null ? ` · 幅度 ${rc.magnitude_min}%~${rc.magnitude_max}%` : ''}\n摘要：${rc.summary || ''}\n建议动作：${rc.suggested_action || ''}\n（如需最新行情可要求刷新）`;
        sessionCache.set(key, cached);
        return cached;
      }
      // 气泡提示：正在调用云端（用户感知）
      setPhase('querying');
      setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: (arr[arr.length - 1]?.content || '') + '\n\n🔍 本地模型正在调用云端大模型查询行情（内容已脱敏审计）…', reasoning }; return arr; });
      try {
        const { agentSearchLoop } = await import('../trendService');
        const r = await agentSearchLoop(v.clean!.material, v.clean!.category, 'price-trend', () => { setPhase('querying'); });
        const summary = `【云端查询结果（参考性质：行业趋势/参考区间，具体价格以本地数据为准）】物料：${v.clean!.material}（品类：${v.clean!.category || '未知'}）\n行情方向：${r.trend_direction} · 置信度：${r.confidence_level}${r.magnitude_min != null ? ` · 近1-3月幅度 ${r.magnitude_min}%~${r.magnitude_max}%` : ''}\n摘要：${r.summary}\n建议动作：${r.suggested_action}`;
        sessionCache.set(key, summary);
        try {
          await logLocalAICall({ request_type: 'local_chat_cloud_tool', material_name: v.clean!.material, system_prompt: '本地模型自主调用云端（脱敏）', user_prompt: `material=${v.clean!.material}&category=${v.clean!.category}&question=${v.clean!.question}`, response_summary: summary.slice(0, 800), success: true, model_name: model });
        } catch { /* 忽略 */ }
        return summary;
      } catch (e: any) {
        return `云端查询失败：${e?.message || e}（请确认云端 LLM/搜索已配置；本地回答可继续）`;
      }
    };
    const finishStream = async () => {
      setStreaming(false); cleanupRef.current = null; setPhase('idle');
      await saveMsg(currentSid, 'assistant', full || '(无内容)', reasoning);
      setSessions(await loadSessions());
      playChime('done');
      extractMemories(currentSid, userContent, full);
      // 审计日志：本地 AI 对话与外部 LLM 调用同表记录（设置页审计日志统一可见）
      try {
        await saveAIRequestLog({
          request_type: 'local_ai_chat',
          system_prompt: (systemPrompt + dataBlock).slice(0, 2000),
          user_prompt: userContent.slice(0, 2000),
          response_summary: (full || '').slice(0, 2000),
          success: true,
          provider_name: 'Ollama（本地）', model_name: model,
        });
      } catch (e) { console.error('审计日志记录失败', e); }
    };
    stoppedRef.current = false; // 重置停止标记
    // ===== 工具循环：本地模型可自主调用云端（拦截重试≤2 次不耗轮次；真实云端调用≤3 轮，防死循环） =====
    try {
      const sessionCloudCache = new Map<string, string>();
      let tcs = await runStream(apiMessages);
      let toolRounds = 0;
      let blockedRetries = 0;
      while (tcs.length > 0 && !stoppedRef.current) {
        const toolResult = await executeCloudQuery(tcs, sessionCloudCache);
        const blocked = toolResult.indexOf('云端调用被安全审计拦截') === 0;
        if (blocked) {
          blockedRetries++;
          if (blockedRetries >= 2) {
            setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: (arr[arr.length - 1]?.content || '') + '\n\n⚠️ 云端调用参数多次未通过安全审计（2 次），已停止云端查询。可手动以"生成行业洞察"方式发起。', reasoning }; return arr; });
            break;
          }
        } else {
          toolRounds++;
          if (toolRounds >= 3) {
            setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: (arr[arr.length - 1]?.content || '') + '\n\nℹ️ 已进行多轮云端查询（3 轮），如需继续分析可再次提问。', reasoning }; return arr; });
            break;
          }
        }
        const followMsgs = [
          ...apiMessages,
          { role: 'assistant' as const, content: full || '', tool_calls: tcs },
          { role: 'tool' as const, content: toolResult },
        ];
        tcs = await runStream(followMsgs);
      }
      await finishStream();
    } catch (e: any) {
      setStreaming(false); cleanupRef.current = null; setPhase('idle');
      const err = String(e?.message || e);
      try {
        await saveAIRequestLog({
          request_type: 'local_ai_chat', system_prompt: (systemPrompt + dataBlock).slice(0, 2000),
          user_prompt: userContent.slice(0, 2000), response_summary: (full || '').slice(0, 2000),
          success: false, error_message: err.slice(0, 500), provider_name: 'Ollama（本地）', model_name: model,
        });
      } catch { /* 忽略 */ }
      if (full) {
        setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: `${full}\n\n---\n[警告] 输出中断：${err}`, reasoning }; return arr; });
        saveMsg(currentSid, 'assistant', `${full}\n\n---\n[警告] 输出中断：${err}`, reasoning);
      } else {
        setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: `请求失败：${err}\n\n请确认 Ollama 正在运行，且模型已下载。可在右上角设置里重新连接。`, reasoning }; return arr; });
      }
      playChime('error');
    }
  }, [streaming, model, sessionId, messages, ollamaUrl, buildSystemPrompt, extractMemories]);

  const injectAndSend = useCallback(async (dataCtx: string, prompt: string) => {
    await sendMessage(`${dataCtx}\n\n${prompt}`);
  }, [sendMessage]);

  // ===== Agent 任务（P1）：计划-执行-总结，工具轨迹可见 =====
  // 云端审批（Agent/自主分析共用）：preview 就地弹窗展示将发送的脱敏提示词，auto 直接放行
  const requestCloudApproval = useCallback(async (prompt: string): Promise<boolean> => {
    try {
      const mode = await getSetting('ai_bridge_review', 'auto');
      if (mode !== 'preview') return true;
    } catch { return true; }
    return new Promise<boolean>(resolve => {
      setBridgeReviewPrompt(prompt);
      setBridgeReviewResolve(() => (ok: boolean) => resolve(ok));
    });
  }, []);

  const sendAgentTask = useCallback(async (userContent: string) => {
    if (!userContent.trim() || streaming) return;
    if (!model) { message.warning('请先连接Ollama并选择模型'); return; }
    let sid = sessionId;
    if (!sid) {
      sid = await newSession(userContent.slice(0, 20));
      setSessions(await loadSessions()); setSessionId(sid);
    }
    setMessages(prev => [...prev, { role: 'user', content: userContent }]);
    await saveMsg(sid, 'user', userContent);
    setInput('');
    setStreaming(true);
    setPhase('thinking');
    setAgentTrace([]);
    setAgentTraceOpen(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    const currentSid = sid;
    let full = '', reasoning = '';

    try {
      // ⚠️ DSH 式循环（2026-08-18 重构）：一次流式对话中模型自主 思考→[TOOL]→结果回填→继续→结论
      // 替代原「计划(非流式JSON)→顺序执行→总结」三段式：不再要求模型先输出完整计划，模型自己决定何时调什么工具，
      // 轨迹卡实时呈现每次工具调用（复用 runThinkLoop 文本协议，与自主分析同一引擎）
      setPhase('thinking');
      const { listTools, executeTool } = await import('../aiTools');
      const { buildThinkSystemPrompt, runThinkLoop, buildCloudReviewPrompt } = await import('../thinkEngine');
      const { agentSearchLoop } = await import('../trendService');
      import('../aiLearning').then(m => m.trackUserFocus(userContent)).catch(() => {});
      let prefCtx = '';
      try { prefCtx = await import('../aiLearning').then(m => m.buildPreferenceContext()); } catch { prefCtx = ''; }
      const localTools = listTools();
      const sysPrompt = buildThinkSystemPrompt(localTools.map(t => t.name), prefCtx) +
        '\n【任务】' + userContent + '\n这是一个需要调用工具完成的多步分析任务：先想清楚需要哪些数据（BOM/供应商/目标/快照/工作手账/报价情报等），' +
        '逐步输出 [TOOL] 调用获取，观察结果后继续；数据齐了直接给出结构化结论（发现/判断/建议行动）。';
      const { finalText } = await runThinkLoop({
        baseUrl: ollamaUrl,
        model,
        systemPrompt: sysPrompt,
        userContent,
        localTools,
        executeTool,
        approveCloud: async (call) => requestCloudApproval(buildCloudReviewPrompt(call)),
        runCloud: async (call) => agentSearchLoop(call.material_name, call.category || '', 'price-trend'),
        onEvent: {
          onToolResult: (name, args, ok, text) => {
            const tool = localTools.find(t => t.id === name);
            setAgentTrace(prev => [...prev, { tool: name, name: tool?.name || name, argsText: JSON.stringify(args || {}) === '{}' ? '无参数' : JSON.stringify(args || {}), status: ok ? 'ok' : 'fail', result: text }]);
            window.dispatchEvent(new CustomEvent('costhub-ai-task', { detail: { task: 'Agent：' + (tool?.name || name) + (ok ? ' ✓' : ' ✗') } }));
          },
          onAnswer: (t) => {
            setPhase('streaming');
            full += t;
            setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: full, reasoning }; return arr; });
          },
          onThought: (t) => { reasoning += t; setPhase('thinking'); },
        },
        maxRounds: 8,
      });
      const resultText = finalText || full;
      await logLocalAICall({ request_type: 'agent_answer', system_prompt: sysPrompt.slice(0, 3000), user_prompt: userContent.slice(0, 3000), response_summary: (resultText || '').slice(0, 2000), success: true, model_name: model });
      if (resultText) await saveMsg(currentSid, 'assistant', resultText, reasoning);
      if (!full) setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: resultText || '（未输出结论）', reasoning }; return arr; });
    } catch (e: any) {
      const err = e?.message || String(e);
      await logLocalAICall({ request_type: 'agent_answer', system_prompt: '', user_prompt: userContent.slice(0, 3000), response_summary: '', success: false, error_message: String(err).slice(0, 500), model_name: model });
      setMessages(prev => { const arr = [...prev]; arr[arr.length - 1] = { role: 'assistant', content: 'Agent 任务执行失败：' + err + '\n\n可切换回「普通对话」重试。', reasoning }; return arr; });
      await saveMsg(currentSid, 'assistant', 'Agent 任务执行失败：' + err, reasoning);
      playChime('error');
    } finally {
      setStreaming(false);
      setPhase('idle');
    }
  }, [streaming, model, sessionId, ollamaUrl, sendMessage, requestCloudApproval]);

  // ===== 自主分析（think）：本地模型自由思考 + 按需申请云端（2026-08-17 用户需求，DSH 式过程渲染） ======
  const sendThinkTask = useCallback(async (userContent: string) => {
    if (!userContent.trim() || streaming) return;
    if (!model) { message.warning('请先连接Ollama并选择模型'); return; }
    let sid = sessionId;
    if (!sid) {
      sid = await newSession(userContent.slice(0, 20));
      setSessions(await loadSessions()); setSessionId(sid);
    }
    setMessages(prev => [...prev, { role: 'user', content: userContent }]);
    await saveMsg(sid, 'user', userContent);
    setInput('');
    setStreaming(true);
    setPhase('thinking');
    setThinkRun({ user: userContent, thoughts: [], tools: [], clouds: [], answer: '', status: 'running', round: 0 });
    const currentSid = sid;
    const curThinkRef = { current: '' }; // 当前轮思考增量缓冲
    try {
      // AI 学习：记录关注主题 + 注入偏好上下文
      import('../aiLearning').then(m => m.trackUserFocus(userContent)).catch(() => {});
      let prefCtx = '';
      try { prefCtx = await import('../aiLearning').then(m => m.buildPreferenceContext()); } catch { prefCtx = ''; }
      const { listTools, executeTool } = await import('../aiTools');
      const { buildThinkSystemPrompt, buildCloudReviewPrompt, runThinkLoop } = await import('../thinkEngine');
      const { agentSearchLoop } = await import('../trendService');
      const localTools = listTools();
      const sysPrompt = buildThinkSystemPrompt(localTools.map(t => t.name), prefCtx);
      // 通用思考循环（前端与后台 autoThink 共用同一协议）
      const { finalText } = await runThinkLoop({
        baseUrl: ollamaUrl,
        model,
        systemPrompt: sysPrompt,
        userContent,
        localTools,
        executeTool,
        approveCloud: async (call) => requestCloudApproval(buildCloudReviewPrompt(call)),
        runCloud: async (call) => agentSearchLoop(call.material_name, call.category || '', 'price-trend'),
        onEvent: {
          onRoundStart: (round) => { curThinkRef.current = ''; setThinkRun(prev => prev ? { ...prev, round, thoughts: [...(prev.thoughts || []), ''] } : prev); },
          onThought: (t) => { curThinkRef.current += t; setThinkRun(prev => { const thoughts = [...(prev?.thoughts || [])]; if (thoughts.length > 0) thoughts[thoughts.length - 1] = curThinkRef.current; return prev ? { ...prev, thoughts } : prev; }); },
          onAnswer: (t) => setThinkRun(prev => prev ? { ...prev, answer: (prev.answer || '') + t } : prev),
          onToolResult: (name, args, ok, text) => setThinkRun(prev => prev ? { ...prev, tools: [...(prev.tools || []), { name, args, result: text, ok }] } : prev),
          onCloudResult: (call, ok, result) => setThinkRun(prev => prev ? { ...prev, clouds: [...(prev.clouds || []), { material: call.material_name, question: call.question || '近1-3月价格趋势', status: ok ? 'approved' : 'rejected', result }] } : prev),
        },
        maxRounds: 8,
      });
      setThinkRun(prev => prev ? { ...prev, status: 'done' } : prev);
      await logLocalAICall({ request_type: 'think_run', system_prompt: sysPrompt.slice(0, 3000), user_prompt: userContent.slice(0, 3000), response_summary: (finalText || '').slice(0, 2000), success: true, model_name: model });
      if (finalText) await saveMsg(currentSid, 'assistant', finalText);
      setMessages(prev => [...prev, { role: 'assistant', content: finalText || '(未输出结论)' }]);
    } catch (e: any) {
      const err = e?.message || String(e);
      setThinkRun(prev => prev ? { ...prev, status: 'error', error: String(err).slice(0, 300) } : prev);
      await logLocalAICall({ request_type: 'think_run', system_prompt: '', user_prompt: userContent.slice(0, 3000), response_summary: '', success: false, error_message: String(err).slice(0, 500), model_name: model });
      playChime('error');
    } finally {
      setStreaming(false);
      setPhase('idle');
    }
  }, [streaming, model, sessionId, ollamaUrl, requestCloudApproval]);

  // 智能导入：更新某行分类字段
  const updateImportRow = useCallback((idx: number, field: string, value: any) => {
    setImportRows(prev => {
      const arr = [...prev];
      if (arr[idx]) { (arr[idx] as any)[field] = value; }
      return arr;
    });
  }, []);

  // 智能导入：确认后写入器件库 + 项目BOM
  const doSmartImport = useCallback(async (rows: any[], projectId?: number, onProgress?: (done: number, total: number) => void) => {
    const db = await getDb();
    let partCount = 0;
    let bomCount = 0;
    // 用事务包裹全部写入：任何一步失败整体回滚，避免"部分入库"造成困惑
    await db.execute('BEGIN');
    try {
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        if (!row.name) continue;
        // 防御：确保字段都是合法值，避免脏数据导致 SQL 报错回滚
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        const model = String(row.model ?? '').trim();
        const mainCat = MAIN_CATEGORIES.includes(row.main_category) ? row.main_category : '硬件类';
        const subCat = String(row.sub_category ?? '').trim();
        const category = subCat || mainCat;
        const remark = String(row.remark ?? '').trim();
        // 成本必须是有限数字，否则用0
        const rawCost = parseFloat(String(row.cost ?? '0').replace(/[¥￥,\s]/g, ''));
        const cost = Number.isFinite(rawCost) ? Math.round(rawCost * 10000) / 10000 : 0;
        // 数量必须是正整数
        const rawQty = parseInt(String(row.qty ?? '1'));
        const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
        // 模块名清理
        const moduleName = String(row.module ?? '未归类').trim() || '未归类';

        // 查重：同型号同名的已存在则复用
        const existing = await db.select<any[]>(
          'SELECT id FROM parts WHERE name=? AND model=? LIMIT 1', [name, model]
        );
        let partId: number;
        if (existing.length) {
          partId = existing[0].id;
          // 更新价格信息
          await db.execute(
            "UPDATE parts SET main_category=?, sub_category=?, category=?, cost=?, updated_at=datetime('now','localtime') WHERE id=?",
            [mainCat, subCat, category, cost, partId]
          );
        } else {
          const r = await db.execute(
            'INSERT INTO parts (main_category, sub_category, category, name, model, cost, remark) VALUES (?,?,?,?,?,?,?)',
            [mainCat, subCat, category, name, model, cost, remark]
          );
          partId = r.lastInsertId!;
        }
        partCount++;

        // 如果选择了目标项目，加入项目BOM
        if (projectId) {
          const [existingBom] = await db.select<any[]>(
            'SELECT id FROM project_boms WHERE project_id=? AND part_id=? AND COALESCE(is_deleted,0)=0 LIMIT 1',
            [projectId, partId]
          );
          if (existingBom) {
            await db.execute('UPDATE project_boms SET quantity=quantity+?, module_name=?, cost=? WHERE id=?', [qty, moduleName, cost, existingBom.id]);
          } else {
            await db.execute(
              'INSERT INTO project_boms (project_id, part_id, module_name, quantity, cost, remark) VALUES (?,?,?,?,?,?)',
              [projectId, partId, moduleName, qty, cost, remark]
            );
          }
          bomCount++;
        }
        onProgress?.(idx + 1, rows.length);
      }
      await db.execute('COMMIT');
    } catch (e: any) {
      try { await db.execute('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
      // 尽量提取具体出错行
      throw new Error(`导入中止并已回滚：${e?.message || e}`);
    }
    return { partCount, bomCount };
  }, []);

  // ===== 对话后自动提炼记忆（后台，不阻塞对话） =====
  const TOOLS = [
    {
      label: 'BOM 审查', icon: <ThunderboltOutlined />, color: '#F97316',
      render: () => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Select placeholder="选择项目" style={{ flex: 1, minWidth: 120 }} options={projects.map(p => ({ value: p.id, label: `${p.code}` }))}
            onChange={async (id) => { const ctx = await buildBOMContext(id); injectAndSend(ctx, '请仔细分析这个项目的BOM成本结构：1）哪些模块/器件成本偏高？2）与同类项目相比有什么异常？3）建议重点关注和谈价的器件是哪些？请给出具体的分析和建议。'); }} />
        </div>
      ),
    },
    {
      label: '跨项目挖掘', icon: <ApartmentOutlined />, color: '#6366F1',
      render: () => (
        <div style={{ display: 'flex', gap: 6, flexDirection: 'column' }}>
          <Select mode="multiple" placeholder="选择多个项目" style={{ width: '100%' }} value={selProjects} onChange={setSelProjects}
            options={projects.map(p => ({ value: p.id, label: p.code }))} maxTagCount={3} />
          <Button size="small" disabled={selProjects.length < 2} onClick={async () => {
            const ctx = await buildCrossProjectContext(selProjects);
            injectAndSend(ctx, '请分析这些项目的共用器件情况：1）哪些器件在不同项目中有明显价差？2）有哪些批量采购或统一供应商的机会？3）建议优先推进哪些降本措施？');
          }}>开始分析</Button>
        </div>
      ),
    },
    {
      label: '供应商分布', icon: <TeamOutlined />, color: '#0891B2',
      render: () => (
        <Button size="small" block onClick={async () => {
          const ctx = await buildSupplierContext();
          injectAndSend(ctx, '请分析当前供应商分布情况：1）有没有单点依赖风险（某类器件只有一家供应商）？2）哪些供应商的价格水平相对偏高？3）从供应链安全角度有什么建议？');
        }}>分析全部供应商</Button>
      ),
    },
    {
      label: '成本历史', icon: <HistoryOutlined />, color: '#16A34A',
      render: () => (
        <div style={{ display: 'flex', gap: 6 }}>
          {[3, 6, 12].map(m => (
            <Button key={m} size="small" style={{ flex: 1 }} onClick={async () => {
              const ctx = await buildCostHistoryContext(m);
              injectAndSend(ctx, `请总结过去${m}个月的成本变动情况：1）整体成本走势如何？2）哪些项目或器件成本变动最显著？3）有哪些值得关注的降本成果或成本上升风险？`);
            }}>{m}个月</Button>
          ))}
        </div>
      ),
    },
    {
      label: '智能BOM导入', icon: <FileExcelOutlined />, color: '#16A34A',
      render: () => (
        <Button size="small" block icon={<FileExcelOutlined />} onClick={() => {
          setImportModalOpen(true);
          setImportStep(0);
          setImportRows([]);
          setImportSkipped([]);
          setImportClassifying(false);
          setShowNewProjectForm(false);
        }}>打开智能BOM导入</Button>
      ),
    },
  ];

  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  
  // ===== 自主建议逻辑 =====
  const loadAdvisor = useCallback(async () => {
    try {
      const [list, last] = await Promise.all([getAdvisorInsights(), getSetting('advisor_last_run', '')]);
      setAdvisorList(list);
      setAdvisorLastRun(last || '');
    } catch (e) { console.warn('加载自主建议失败', e); }
  }, []);
  useEffect(() => {
    loadAdvisor();
    const onDone = () => loadAdvisor();
    window.addEventListener('costhub-advisor-done', onDone);
    return () => window.removeEventListener('costhub-advisor-done', onDone);
  }, [loadAdvisor]);
  const fmtA = (t: string) => {
    if (!t) return '';
    const d = new Date(t.replace('T', ' '));
    if (isNaN(d.getTime())) return t.slice(0, 16);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const runAdvisorNow = async () => {
    setAdvisorRunning(true);
    setAdvisorProgress('');
    try {
      const r = await runAutoAdvisor(m => setAdvisorProgress(m));
      if (r) message.success(r.found > 0 ? `发现 ${r.found} 条机会/风险点` : '未发现新的机会/风险点');
      else message.info('当前没有在研项目，无需分析');
    } catch (e: any) {
      message.error('分析失败：' + (e?.message || e));
    }
    setAdvisorRunning(false);
    await loadAdvisor();
  };
  const copyPrompt = async (p: string) => {
    if (!p) { message.warning('该建议暂无可复制的提示词'); return; }
    try {
      await navigator.clipboard.writeText(p);
      message.success('提示词已复制，可粘贴到 AI 助手 / 全局问询执行');
    } catch { message.warning('复制失败，请手动选择复制'); }
  };
  const setAdvisorStatus = async (id: number, status: string) => {
    // 乐观标记：立即显示新状态（已处理/已忽略条目保留在列表，切"显示全部"可见），失败回滚
    setAdvisorList(prev => prev.map(x => x.id === id ? { ...x, status } : x));
    try {
      await updateAdvisorStatus(id, status);
      await loadAdvisor();
      // ⚠️ 处理后同步驾驶舱待处理计数（2026-08-17 修复：处理完驾驶舱「AI 建议」数字不刷新）
      window.dispatchEvent(new CustomEvent('costhub-advisor-done'));
      // 反馈条带撤销：处理错了一键恢复
      notification.success({
        message: status === 'done' ? '已标记处理（切「显示全部」可查看）' : '已忽略（数据不变将不再提醒）',
        placement: 'bottomRight', duration: 4,
        btn: <Button size="small" type="link" onClick={async () => {
          try {
            await updateAdvisorStatus(id, 'open');
            await loadAdvisor();
            window.dispatchEvent(new CustomEvent('costhub-advisor-done')); // 撤销恢复后计数同步
            notification.success({ message: '已恢复为待处理', placement: 'bottomRight', duration: 3 });
          } catch (e2: any) { notification.error({ message: '撤销失败：' + (e2?.message || e2), placement: 'bottomRight' }); }
        }}>撤销</Button>,
      });
    } catch (e: any) {
      // 回滚本地标记，恢复真实状态
      setAdvisorList(prev => prev.map(x => x.id === id ? { ...x, status: 'open' } : x));
      message.error('操作失败：' + (e?.message || e));
      await loadAdvisor();
    }
  };
  // 洞察执行（force=true 强制重新查询云端）
  const doBridgedInsight = async (ins: any, force: boolean) => {
    setAdvisorInsightBusy(ins.id);
    setAdvisorProgress('');
    try {
      const { runBridgedInsight } = await import('../aiBridge');
      const reviewMode = (await getSetting('ai_bridge_review', 'auto')) === 'preview';
      const r = await runBridgedInsight(ins, {
        force,
        onProgress: m => setAdvisorProgress(m),
        onNeedReview: reviewMode ? (prompt) => new Promise<boolean>(resolve => {
          setBridgeReviewPrompt(prompt);
          setBridgeReviewResolve(() => resolve);
        }) : undefined,
      });
      const reuseTag = r.reused && r.reuseOf ? `♻ 复用 ${fmtA(r.reuseOf.created_at)} 洞察（判定 ${r.reuseOf.verdict || '未知'}，未重复查询云端）\n` : '';
      const extra = `\n\n${reuseTag}🔍 行业洞察（${r.reused && r.reuseOf ? fmtA(r.reuseOf.created_at) : fmtA(new Date().toISOString())}）：方向 ${r.cloud.trend_direction}，置信度 ${r.cloud.confidence_level}${r.cloud.magnitude_min != null ? `，近1-3月幅度约 ${r.cloud.magnitude_min}%~${r.cloud.magnitude_max}%` : ''}\n${r.cloud.summary}\n🧠 本地最终建议（结合本地数据）：判定 ${r.local.verdict}${r.local.target_price ? '；目标：' + r.local.target_price : ''}${r.local.risk ? '；风险：' + r.local.risk : ''}\n行动：${r.local.actions.join('；') || r.cloud.suggested_action}\n🔐 本次实际发送云端的内容（可核验）：\n${r.cloudPrompt}\n—— 以上为发送全文，仅含物料名/品类/问题，本地数据不外传`;
      await updateAdvisorStatus(ins.id, 'open', { detail: (ins.detail || '') + extra });
      await loadAdvisor();
      message.success(r.reused ? '已复用上次洞察结果（防重复查询），如需最新行情可点「♻ 强制最新」' : '双向 AI 洞察完成：云端行情 + 本地建议已回填');
    } catch (e: any) {
      message.error('洞察失败：' + (e?.message || e) + '（需配置本地模型与云端 LLM Key 或开启原生搜索）');
    }
    setAdvisorInsightBusy(null);
    setAdvisorProgress('');
  };
  // 入口：近期已有洞察 → 先确认复用/强制最新（防重复花钱查云端）
  const insightForAdvisor = async (ins: any) => {
    try {
      const { getRecentBridgeLog, materialKey } = await import('../db/advisor');
      const recent = await getRecentBridgeLog(materialKey(ins.ref_name || '', ''), 7);
      if (recent) {
        setBridgeReuseInfo({ ins, recent });
        return;
      }
    } catch { /* 查询失败直接走全链路 */ }
    await doBridgedInsight(ins, false);
  };
  const ADVISOR_TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
    stale_project_cost: { icon: '🕐', color: '#3B82F6', label: '成本久未变动' },
    stale_part_price: { icon: '💰', color: '#F59E0B', label: '久未调价·议价机会' },
    target_gap: { icon: '🎯', color: '#EF4444', label: '超目标·风险' },
    single_supplier: { icon: '⚠️', color: '#8B5CF6', label: '单一供应商·风险' },
  };
return (
    <div className="local-ai-root" style={{ display: 'flex', height: '100%', gap: 0, overflow: 'hidden' }}>
      {/* Left Panel */}
      {/* 左：简洁会话列（Demo B 方案 2026-08-16 重构） */}
      <div className="local-ai-left" style={{ width: 180, minWidth: 180, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border)', background: '#fff' }}>
        <div style={{ padding: '14px 12px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: connStatus === 'ok' ? '#22C55E' : connStatus === 'fail' ? '#EF4444' : '#D1D5DB', boxShadow: connStatus === 'ok' ? '0 0 6px #22C55E88' : undefined }} />
            <b style={{ fontSize: 13 }}>会话</b>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#6366F1', background: '#EEF2FF', borderRadius: 20, padding: '2px 8px', maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model || (connStatus === 'ok' ? '已连接' : '未连接')}</span>
          </div>
          {streaming && (
            <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--color-primary)', background: 'var(--color-accent-blue-bg)', borderRadius: 6, padding: '3px 8px' }}>
              <Spin size="small" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, fontWeight: 600 }}>{phase === 'fetching' ? '读取数据' : phase === 'querying' ? '查询数据' : phase === 'thinking' ? '思考分析' : '生成回答'}</span>
              <b>{elapsed}s</b>
            </div>
          )}
        </div>
        {/* 视图切换（2026-08-17 收纳：从顶部导航移到这里，顶部只留对话） */}
        <div style={{ display: 'flex', gap: 6, padding: '0 12px 8px' }}>
          <div onClick={() => setAdvisorTab('advice')} title="自主建议：成本机会/风险点" className="tappable"
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '5px 0', borderRadius: 8, fontSize: 11.5, cursor: 'pointer', background: advisorTab === 'advice' ? '#F3E8FF' : '#FAFAFC', border: advisorTab === 'advice' ? '1px solid #D8B4FE' : '1px solid var(--color-border)', color: advisorTab === 'advice' ? '#7C3AED' : '#6B7280', fontWeight: advisorTab === 'advice' ? 600 : 400 }}>
            <RobotOutlined style={{ fontSize: 12 }} /> 建议{advisorList.filter((x: any) => x.status === 'open').length > 0 ? <span style={{ background: '#EF4444', color: '#fff', fontSize: 9, borderRadius: 9, padding: '0 5px' }}>{advisorList.filter((x: any) => x.status === 'open').length}</span> : null}
          </div>
          <div onClick={() => setAdvisorTab('think')} title="自主分析：AI 后台深度思考全过程" className="tappable"
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '5px 0', borderRadius: 8, fontSize: 11.5, cursor: 'pointer', background: advisorTab === 'think' ? '#EEF2FF' : '#FAFAFC', border: advisorTab === 'think' ? '1px solid #A5B4FC' : '1px solid var(--color-border)', color: advisorTab === 'think' ? '#4338CA' : '#6B7280', fontWeight: advisorTab === 'think' ? 600 : 400 }}><ExperimentOutlined style={{ fontSize: 12 }} /> 分析</div>
        </div>
        <Button size="small" block icon={<PlusOutlined />} onClick={() => startSession()} style={{ margin: '0 12px 8px', width: 'auto', borderRadius: 9, borderColor: '#E5E9F0', background: '#FAFBFF', color: '#4338CA', fontWeight: 500 }}>新对话</Button>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {sessions.map(s => (
            <div key={s.id} onClick={() => switchSession(s.id)} style={{ padding: '9px 10px', borderRadius: 9, cursor: 'pointer', marginBottom: 2, background: s.id === sessionId ? '#EEF2FF' : 'transparent', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: s.id === sessionId ? 600 : 400, color: s.id === sessionId ? '#4338CA' : '#4B5563' }}>{s.title}</span>
              <Button size="small" type="text" icon={<DeleteOutlined />} style={{ opacity: 0, fontSize: 10 }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0')} onClick={async e => { e.stopPropagation(); await deleteSession(s.id); setSessions(await loadSessions()); if (sessionId === s.id) { setSessionId(null); setMessages([]); } }} />
            </div>
          ))}
        </div>
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--color-border)', fontSize: 10.5, color: '#B0B7C3', textAlign: 'center', lineHeight: 1.7 }}>
          🔒 数据只在本机处理<br />全部 AI 调用可审查
        </div>
      </div>
      {/* Chat Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {/* 顶部导航栏（Demo B 方案：功能平铺，不再藏左下角） */}
        <div style={{ height: 52, flexShrink: 0, background: '#fff', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, marginRight: 20, color: '#111827' }}>
            <span style={{ width: 26, height: 26, borderRadius: 8, background: 'linear-gradient(135deg,#0A84FF,#6366F1)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}><RobotOutlined /></span>
            本地 AI 助手
          </div>
          <div onClick={() => setAdvisorTab('chat')} className="tappable" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 9, fontSize: 13, cursor: 'pointer', background: advisorTab === 'chat' ? '#EEF2FF' : 'transparent', color: advisorTab === 'chat' ? '#4338CA' : '#6B7280', fontWeight: advisorTab === 'chat' ? 600 : 400 }}><MessageOutlined style={{ fontSize: 13 }} /> 对话</div>
          <span style={{ fontSize: 11, color: '#B0B7C3' }}>（自主建议 / 自主分析在左侧切换）</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: connStatus === 'ok' ? '#16A34A' : connStatus === 'fail' ? '#DC2626' : '#6B7280', background: connStatus === 'ok' ? '#F0FDF4' : connStatus === 'fail' ? '#FEF2F2' : '#F3F4F8', border: '1px solid ' + (connStatus === 'ok' ? '#BBF7D0' : connStatus === 'fail' ? '#FECACA' : '#E5E9F0'), borderRadius: 20, padding: '3px 11px', display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: connStatus === 'ok' ? '#22C55E' : connStatus === 'fail' ? '#EF4444' : '#D1D5DB' }} />
              {connStatus === 'ok' ? (model || '已连接') : connStatus === 'fail' ? '连接失败' : '未连接'}
            </span>
            <Dropdown
              menu={{
                items: [
                  { key: 'tools', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><ToolOutlined /> 数据分析工具</span> },
                  { key: 'import', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><UploadOutlined /> 智能 BOM 导入</span> },
                  { key: 'demo', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><FilePptOutlined /> 演示生成（HTML/PPTX）</span> },
                  { key: 'rules', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><AppstoreOutlined /> 分类规则管理</span> },
                  { type: 'divider' },
                  { key: 'memory', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><BookOutlined /> 知识库（AI 记忆）</span> },
                  { key: 'learn', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><BulbOutlined /> 学习档案（关注/偏好）</span> },
                  { key: 'logs', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><HistoryOutlined /> AI 活动记录</span> },
                  { type: 'divider' },
                  { key: 'settings', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><SettingOutlined /> 连接设置</span> },
                ],
                onClick: ({ key }) => {
                  if (key === 'tools') setToolsOpen(true);
                  else if (key === 'import') setImportModalOpen(true);
                  else if (key === 'demo') setShowDemo(true);
                  else if (key === 'rules') { setShowRules(true); getModuleRules().then(setRules).catch(() => {}); }
                  else if (key === 'memory') { setShowContext(true); loadMemories(50).then(setMemories).catch(() => {}); }
                  else if (key === 'learn') { setShowLearn(true); loadLearnData().catch(() => {}); }
                  else if (key === 'logs') { setLogsOpen(true); if (aiLogs.length === 0) loadAiLogs(); }
                  else if (key === 'settings') { setShowSettings(true); refreshNetStatus(); }
                },
              }}
            >
              <Button size="small" icon={<ThunderboltOutlined />} style={{ borderRadius: 8, fontSize: 12 }}>功能</Button>
            </Dropdown>
          </div>
        </div>
        {advisorTab === 'chat' ? (
        <div key="chat" className="view-enter" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* AI 活动记录：回溯"AI 今天都做了什么"（点击展开，本地留痕可审查） */}
        <div style={{ padding: '2px 16px 0', borderBottom: logsOpen ? '1px solid var(--color-border)' : undefined }}>
          <div onClick={() => { setLogsOpen(!logsOpen); if (!logsOpen && aiLogs.length === 0) loadAiLogs(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '4px 0', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <RobotOutlined style={{ color: '#6366F1', fontSize: 12 }} />
            <span>AI 活动记录{aiLogs.length > 0 ? `（最近 ${aiLogs.length} 条）` : ''}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10 }}>{logsOpen ? '▾' : '▸'}</span>
          </div>
          {logsOpen && (
            <div style={{ padding: '2px 0 8px', maxHeight: 150, overflowY: 'auto' }}>
              {aiLogs.length === 0 ? (
                <div style={{ fontSize: 11.5, color: '#94A3B8' }}>暂无记录——AI 的每一次本地调用都会留痕，稍后自动出现</div>
              ) : aiLogs.map((l: any, i: number) => (
                <div key={l.id ?? i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, padding: '3px 0', borderBottom: i < aiLogs.length - 1 ? '1px dashed var(--color-border)' : undefined }}>
                  <Tag style={{ margin: 0, fontSize: 10, flexShrink: 0, lineHeight: '16px' }} color={l.success ? 'blue' : 'red'}>{AI_TYPE_NAMES[l.request_type] || l.request_type}</Tag>
                  <span style={{ color: l.success ? 'var(--color-text-primary)' : '#DC2626', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.response_summary || (l.success ? '执行完成' : `失败：${l.error_message || ''}`)}
                  </span>
                  <span style={{ color: '#94A3B8', flexShrink: 0, fontSize: 10.5 }}>{(l.created_at || '').slice(11, 16)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 启动时若检测到 Ollama 未封禁联网，显示一次性提示条（需等首次状态查询完成，避免闪提示） */}
        {netStatusLoaded && netOllamaFound && !netLocked && !netWarnDismissed && (
          <div style={{ padding: '8px 16px', background: '#FFF7ED', borderBottom: '1px solid #FED7AA', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9A3412' }}>
            <span style={{ flex: 1 }}><WarningOutlined style={{ marginRight: 6 }} /> 检测到 Ollama 可联网。你的成本数据仅在本机处理，为彻底放心，建议一键封禁联网（<SettingOutlined style={{ marginRight: 2 }} />设置 → 数据安全保护）。</span>
            <Button size="small" type="link" onClick={() => setNetWarnDismissed(true)}>知道了</Button>
          </div>
        )}
        <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '24px 0' }}>
          <div style={{ maxWidth: 780, margin: '0 auto', padding: '0 28px' }}>
          {messages.length === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span style={{ color: 'var(--color-text-secondary)' }}>选择左侧工具注入数据，或直接输入问题<br /><span style={{ fontSize: 11 }}>所有数据仅发送给本机 Ollama，绝不联网</span></span>} style={{ marginTop: 60 }} />
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 16 }}>
              {m.role === 'assistant' && <div style={{ width: 28, height: 28, borderRadius: 8, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 10, flexShrink: 0, marginTop: 2 }}><RobotOutlined style={{ color: '#6366F1', fontSize: 14 }} /></div>}
              <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px', background: m.role === 'user' ? 'var(--color-primary)' : 'var(--color-surface)', color: m.role === 'user' ? '#fff' : 'var(--color-text-primary)', border: m.role === 'assistant' ? '1px solid var(--color-border)' : 'none', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                {m.role === 'assistant' && m.reasoning && (
                  <div style={{ marginBottom: 8 }}>
                    <ThinkingTracker
                      reasoning={m.reasoning}
                      phase={streaming && i === messages.length - 1 ? (phase as any) : 'streaming'}
                      elapsed={elapsed}
                      streamRate={streamRate}
                    />
                  </div>
                )}
                {m.content ? m.content : (streaming && i === messages.length - 1
                  ? (
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                      {phase === 'fetching'
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spin size="small" /> 正在读取数据库… <b style={{ color: 'var(--color-primary)' }}>{elapsed}s</b></span>
                        : phase === 'querying'
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spin size="small" /> 正在查询数据库… <b style={{ color: 'var(--color-primary)' }}>{elapsed}s</b></span>
                          : phase === 'thinking'
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spin size="small" /> 正在思考… <b style={{ color: 'var(--color-primary)' }}>{elapsed}s</b></span>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Spin size="small" /> 正在生成… <b style={{ color: 'var(--color-primary)' }}>{elapsed}s</b> {streamRate > 0 && <span style={{ fontSize: 11 }}>({streamRate}字/秒)</span>}</span>}
                    </span>
                  )
                  : '')}
                {/* AI 学习反馈：对完成的助手回答 👍/👎（沉淀逻辑偏好） */}
                {m.role === 'assistant' && !streaming && m.content && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 11.5 }}>
                    {!feedbackMap[i] ? (
                      <>
                        <Button size="small" type="text" icon={<LikeOutlined />} style={{ fontSize: 11, color: '#94A3B8', padding: '0 4px', height: 22 }} onClick={async () => {
                          setFeedbackMap(prev => ({ ...prev, [i]: 'up' }));
                          message.success('已记录 👍 AI 会继续保持这种分析方式', 1.5);
                        }} />
                        <Button size="small" type="text" icon={<DislikeOutlined />} style={{ fontSize: 11, color: '#94A3B8', padding: '0 4px', height: 22 }} onClick={() => {
                          const prevUser = messages.slice(0, i).filter(x => x.role === 'user').pop();
                          setFeedbackReason('vague'); setFeedbackCustom('');
                          setFeedbackModal({ index: i, userText: prevUser?.content || '' });
                        }} />
                        <span style={{ color: '#C7CBD1' }}>| 教 AI 理解你的偏好</span>
                      </>
                    ) : feedbackMap[i] === 'up' ? (
                      <span style={{ color: '#16A34A' }}>👍 已记录</span>
                    ) : (
                      <span style={{ color: '#D97706' }}>👎 已学习这条偏好，后续会遵守</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {thinkRun && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 10, flexShrink: 0, marginTop: 2 }}><ExperimentOutlined style={{ color: '#6366F1', fontSize: 14 }} /></div>
              <div style={{ maxWidth: '82%', flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <b style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExperimentOutlined /> 自主分析</b>
                  {thinkRun.status === 'running' && <Tag color="processing">思考中 · 第 {thinkRun.round} 轮</Tag>}
                  {thinkRun.status === 'done' && <Tag color="green">完成</Tag>}
                  {thinkRun.status === 'error' && <Tag color="red">失败</Tag>}
                </div>
                {thinkRun.thoughts.filter(t => (t || '').trim()).length > 0 && (
                  <div style={{ border: '1px dashed #C7D2FE', borderRadius: 10, padding: '8px 12px', marginBottom: 8, background: '#F8FAFF' }}>
                    <div style={{ fontSize: 11, color: '#6366F1', fontWeight: 600, marginBottom: 4 }}>💭 思考过程{thinkRun.status === 'running' ? '（实时）' : ''}</div>
                    {thinkRun.thoughts.map((t, ti) => (t || '').trim() ? (
                      <div key={ti} style={{ fontSize: 12, color: '#64748B', lineHeight: 1.65, whiteSpace: 'pre-wrap', marginBottom: 4 }}>{cleanProtocolText(t)}</div>
                    ) : null)}
                  </div>
                )}
                {thinkRun.tools.map((tc, ti) => (
                  <div key={'t' + ti} style={{ border: '1px solid #E8ECF1', borderRadius: 10, padding: '8px 12px', marginBottom: 8, background: 'var(--color-surface, #fff)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span style={{ color: tc.ok ? '#16A34A' : '#DC2626' }}>{tc.ok ? '✓' : '✗'}</span>
                      <b>{createElement(toolIcon(tc.name))} {tc.name}</b>
                      <span style={{ color: '#94A3B8', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{JSON.stringify(tc.args || {})}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 120, overflow: 'auto' }}>{tc.result}</div>
                  </div>
                ))}
                {thinkRun.clouds.map((cc, ci) => (
                  <div key={'c' + ci} style={{ border: cc.status === 'rejected' ? '1px solid #FECACA' : '1px solid #FFD591', borderRadius: 10, padding: '8px 12px', marginBottom: 8, background: cc.status === 'rejected' ? '#FFF7F7' : '#FFF7E6' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <LockOutlined style={{ color: '#D46B08' }} />
                      <b>申请调用云端模型</b>
                      <Tag color={cc.status === 'approved' ? 'green' : cc.status === 'rejected' ? 'red' : 'orange'} style={{ margin: 0 }}>{cc.status === 'approved' ? '已批准' : cc.status === 'rejected' ? '已拒绝' : '等待审批…'}</Tag>
                    </div>
                    <div style={{ fontSize: 11.5, color: '#7C5A12', marginTop: 4, lineHeight: 1.6 }}>查询：{cc.material}{cc.question ? ' · ' + cc.question : ''}</div>
                    {cc.result && <div style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginTop: 4 }}>{cc.result}</div>}
                  </div>
                ))}
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 10, padding: '10px 14px', background: 'var(--color-surface)', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {thinkRun.status === 'error'
                    ? <span style={{ color: '#DC2626' }}>分析失败：{thinkRun.error}</span>
                    : cleanProtocolText(thinkRun.answer) || (thinkRun.status === 'done' ? '（未输出结论）' : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spin size="small" /> 正在思考…</span>
                    ))}
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
          </div>
        </div>
        {/* 回到底部悬浮按钮：用户在流式生成时向上回看，点此跳回底部 */}
        {showJumpDown && (
          <div style={{ position: 'absolute', bottom: 90, right: 40, zIndex: 20 }}>
            <Button
              size="small"
              icon={<ArrowDownOutlined />}
              onClick={() => {
                const el = scrollRef.current;
                if (el) { el.scrollTop = el.scrollHeight; followScrollRef.current = true; setShowJumpDown(false); }
              }}
              style={{ boxShadow: '0 4px 16px rgba(0,0,0,0.15)', borderRadius: 20 }}
            >回到底部</Button>
          </div>
        )}
        <div style={{ padding: '14px 20px 16px', borderTop: '1px solid var(--color-border)', background: '#fff' }}>
          <div style={{ maxWidth: 780, margin: '0 auto' }}>
          {agentTrace.length > 0 && (
            <div style={{ marginBottom: 8, borderRadius: 8, border: '1px solid var(--color-border)', background: 'rgba(99,102,241,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text-secondary)' }} onClick={() => setAgentTraceOpen(!agentTraceOpen)}>
                <RobotOutlined style={{ color: '#6366F1' }} />
                <b>Agent 执行过程（{agentTrace.filter(x => x.status !== 'running').length}/{agentTrace.length}）</b>
                <span style={{ flex: 1 }} />
                <span>{agentTraceOpen ? '▾' : '▸'}</span>
              </div>
              {agentTraceOpen && (
                <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {agentTrace.map((tr, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5 }}>
                      <span style={{ color: tr.status === 'ok' ? '#16A34A' : tr.status === 'fail' ? '#DC2626' : '#6366F1', flexShrink: 0 }}>
                        {tr.status === 'ok' ? '✅' : tr.status === 'fail' ? '❌' : '⏳'}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ color: '#6366F1', marginRight: 4, fontSize: 12 }}>{(() => { const Icon = toolIcon(tr.tool); return <Icon />; })()}</span>
                        <b>{tr.name}</b>
                        {tr.argsText !== '无参数' && <span style={{ color: '#94A3B8' }}>（{tr.argsText}）</span>}
                        {tr.status !== 'running' && (
                          <div style={{ color: 'var(--color-text-secondary)', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginTop: 1 }}>
                            {tr.result.slice(0, 220)}{tr.result.length > 220 ? '…' : ''}
                          </div>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* 模式切换（2026-08-18 修复：横排一行图标不再撑高输入区；emoji 换 antd 图标） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <div title="普通对话（默认）" className="tappable" onClick={() => { if (!streaming) setChatMode('chat'); }}
                  style={{ width: 30, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: streaming ? 'not-allowed' : 'pointer', color: chatMode === 'chat' ? '#4338CA' : '#94A3B8', background: chatMode === 'chat' ? '#EEF2FF' : 'transparent', border: chatMode === 'chat' ? '1px solid #C7D2FE' : '1px solid transparent' }}><MessageOutlined style={{ fontSize: 13 }} /></div>
                <div title="Agent 任务：自动调用工具完成多步任务（只读）" className="tappable" onClick={() => { if (!streaming) setChatMode('agent'); }}
                  style={{ width: 30, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: streaming ? 'not-allowed' : 'pointer', color: chatMode === 'agent' ? '#4338CA' : '#94A3B8', background: chatMode === 'agent' ? '#EEF2FF' : 'transparent', border: chatMode === 'agent' ? '1px solid #C7D2FE' : '1px solid transparent' }}><RobotOutlined style={{ fontSize: 13 }} /></div>
                <div title="自主分析：本地模型自由思考 + 按需申请云端" className="tappable" onClick={() => { if (!streaming) setChatMode('think'); }}
                  style={{ width: 30, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: streaming ? 'not-allowed' : 'pointer', color: chatMode === 'think' ? '#4338CA' : '#94A3B8', background: chatMode === 'think' ? '#EEF2FF' : 'transparent', border: chatMode === 'think' ? '1px solid #C7D2FE' : '1px solid transparent' }}><BulbOutlined style={{ fontSize: 13 }} /></div>
                {chatMode === 'agent' && <span style={{ fontSize: 10.5, color: '#94A3B8', marginLeft: 4 }}>Agent 自动调用工具完成多步任务</span>}
                {chatMode === 'think' && <span style={{ fontSize: 10.5, color: '#94A3B8', marginLeft: 4 }}>本地思考 + 按需申请云端</span>}
              </div>
              <Input.TextArea value={input} onChange={e => setInput(e.target.value)} placeholder={chatMode === 'agent' ? '例如：分析 M270 成本结构，找出 top3 风险物料并洞察行情，最后总结 200 字' : chatMode === 'think' ? '例如：评估 M270 的 PCB 成本是否合理，贵的话分析贵在哪（可申请云端查行情）' : '输入问题，或使用左侧工具注入数据分析…'} autoSize={{ minRows: 1, maxRows: 5 }} onPressEnter={e => { if (!e.shiftKey) { e.preventDefault(); if (chatMode === 'agent') sendAgentTask(input); else if (chatMode === 'think') sendThinkTask(input); else sendMessage(input); } }} style={{ borderRadius: 10 }} />
            </div>
            {streaming
              ? <Button danger icon={<ClearOutlined />} onClick={() => { stoppedRef.current = true; cleanupRef.current?.(); setStreaming(false); }} style={{ alignSelf: 'flex-end' }}>停止</Button>
              : <Button type="primary" icon={<SendOutlined />} onClick={() => { if (chatMode === 'agent') sendAgentTask(input); else if (chatMode === 'think') sendThinkTask(input); else sendMessage(input); }} disabled={!input.trim()} style={{ alignSelf: 'flex-end' }}>{chatMode === 'chat' ? '发送' : '执行'}</Button>
            }
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>Shift+Enter 换行 · Enter 发送 · 数据仅在本机处理{chatMode === 'agent' ? ' · Agent 只读执行，计划与结果可审查' : chatMode === 'think' ? ' · 本地思考免费不限 · 云端发送需审批' : ''}</div>
          </div>
        </div>
        </div>
        ) : advisorTab === 'think' ? (
        <div key="think" className="view-enter" style={{ flex: 1, overflowY: 'auto', padding: '16px 0 24px' }}>
          <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 20px' }}>
            <GoalsCard />
            <AutoThinkPanel mode="full" />
          </div>
        </div>
        ) : (
        <div key="advice" className="view-enter" style={{ flex: 1, overflowY: 'auto', padding: '16px 0 24px' }}>
          <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 20px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 8 }}>
            空闲时自动分析项目成本、物料价格、目标达成与供应风险，以资深成本经理视角找机会/风险点。
            处理方式：<b>复制提示词</b>交给 AI 执行议价/分析，或 <b>生成行业洞察</b>（本地→云端→本地三步，自动防重复查询）。
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button size="small" type="primary" icon={<ThunderboltOutlined />} loading={advisorRunning} onClick={runAdvisorNow}>立即分析</Button>
            <Button size="small" type={advisorShowDone ? 'default' : 'primary'} onClick={() => setAdvisorShowDone(!advisorShowDone)}>
              {advisorShowDone ? '显示全部' : '仅看待处理'}{(() => {
                const doneCount = advisorList.filter(x => x.status !== 'open').length;
                return doneCount > 0 ? `（已处理 ${doneCount}）` : '';
              })()}
            </Button>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{advisorLastRun ? `上次分析 ${fmtA(advisorLastRun)}` : '尚未运行'}</span>
            {advisorProgress && <span style={{ fontSize: 11, color: '#8B5CF6' }}><Spin size="small" style={{ marginRight: 4 }} />{advisorProgress}</span>}
          </div>
          {(() => {
            const list = advisorShowDone ? advisorList : advisorList.filter((x: any) => x.status === 'open');
            if (list.length === 0) {
              return <div style={{ fontSize: 12, color: '#94A3B8', padding: '30px 0', textAlign: 'center' }}>暂无建议——系统空闲时自动分析，或点「立即分析」手动触发</div>;
            }
            return list.map((ins: any) => {
              const meta = ADVISOR_TYPE_META[ins.insight_type] || { icon: '💡', color: '#64748B', label: ins.insight_type };
              return (
                <div key={ins.id} style={{ border: '1px solid ' + meta.color + '33', borderLeft: '3px solid ' + meta.color, borderRadius: 10, padding: '12px 14px', marginBottom: 10, background: ins.status === 'open' ? 'var(--color-surface)' : '#F8FAFC', opacity: ins.status === 'open' ? 1 : 0.75 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, display: 'inline-flex' }}><EmojiIcon e={meta.icon} /></span>
                    <b style={{ fontSize: 14 }}>{ins.title}</b>
                    <Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</Tag>
                    {ins.source === 'ai' && <Tag color="purple" style={{ margin: 0 }}>AI 润色</Tag>}
                    {ins.status !== 'open' && <Tag style={{ margin: 0 }} color={ins.status === 'done' ? 'green' : 'default'}>{ins.status === 'done' ? '已处理' : '已忽略'}</Tag>}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>{fmtA(ins.created_at)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: '#475569', marginTop: 8, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{ins.detail}</div>
                  {ins.prompt && (
                    advisorShowPrompt === ins.id ? (
                      <div style={{ marginTop: 8, background: '#F5F7FF', border: '1px dashed #C7D2FE', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#4F46E5', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                        🔒 已脱敏提示词（无型号/厂家/成本，可安全粘贴到任何 AI）：{ins.prompt}
                        <div style={{ marginTop: 4 }}><Button size="small" type="text" onClick={() => setAdvisorShowPrompt(null)}>收起 ▲</Button></div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 8 }}>
                        <Button size="small" type="text" onClick={() => setAdvisorShowPrompt(ins.id)} style={{ color: '#4F46E5', padding: 0, fontSize: 12 }}>查看可执行提示词 ▾</Button>
                      </div>
                    )
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button size="small" onClick={() => copyPrompt(ins.prompt)} icon={<CopyOutlined />}>复制提示词</Button>
                    {ins.status === 'open' && !isProjectInsight(ins) && <Button size="small" loading={advisorInsightBusy === ins.id} onClick={() => insightForAdvisor(ins)} icon={advisorInsightBusy === ins.id ? undefined : <RadarChartOutlined />}>{advisorInsightBusy === ins.id ? '洞察中…' : '生成行业洞察'}</Button>}
                    {ins.status === 'open' && <Button size="small" type="primary" onClick={() => setAdvisorStatus(ins.id, 'done')} icon={<CheckOutlined />}>已处理</Button>}
                    {ins.status === 'open' && <Button size="small" onClick={() => setAdvisorStatus(ins.id, 'dismissed')}>忽略</Button>}
                  </div>
                </div>
              );
            });
          })()}
          </div>
        </div>
        )}
      </div>

      {/* Settings Modal */}
      <Modal title="Ollama 连接设置" open={showSettings} onCancel={() => setShowSettings(false)} footer={null}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><div style={{ fontSize: 12, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Ollama 地址</div>
            <Input value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" /></div>
          <Button onClick={() => testConnection()} icon={connStatus === 'ok' ? <CheckCircleOutlined style={{ color: '#16A34A' }} /> : <SyncOutlined />}>测试连接 &amp; 获取模型列表</Button>
          {connStatus === 'fail' && (
            <div>
              <div style={{ color: '#DC2626', fontSize: 12 }}>连接失败，请确认 Ollama 正在运行（<code>ollama serve</code>）</div>
              {connError && <div style={{ color: '#B45309', fontSize: 11.5, marginTop: 4, wordBreak: 'break-all' }}>详细原因：{connError}</div>}
            </div>
          )}
          {models.length > 0 && <div><div style={{ fontSize: 12, marginBottom: 4, color: 'var(--color-text-secondary)' }}>选择模型</div>
            <Select value={model} onChange={async v => { setModel(v); await setSetting('local_ai_model', v); }} style={{ width: '100%' }} options={models.map(m => ({ value: m, label: m }))} /></div>}
          {connStatus === 'ok' && !models.length && <div style={{ color: '#D97706', fontSize: 12 }}>已连接但无模型，请先运行：<code>ollama pull qwen2.5:7b</code></div>}
          <Divider style={{ margin: '12px 0' }} />
          {/* ===== 本地-云端桥（双向 AI 洞察） ===== */}
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>双向 AI 洞察（本地-云端桥）</div>
          <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
            建议卡「生成行业洞察」：本地模型判断查询意图 → 云端查行业行情（仅物料名/品类/问题，发送前自动敏感审计）→ 本地模型结合本地数据出最终建议。成本/供应商/项目数据永不出本机。
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Switch size="small" checked={bridgeReviewMode === 'preview'} onChange={async v => { setBridgeReviewMode(v ? 'preview' : 'auto'); await setSetting('ai_bridge_review', v ? 'preview' : 'auto'); }} />
            <span style={{ fontSize: 12 }}>云端发送前预览确认（默认自动脱敏；开启后每次发送云端前弹窗展示提示词）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Switch size="small" checked={cloudToolMode} onChange={async v => { setCloudToolMode(v); await setSetting('ai_local_cloud_tool', v ? 'on' : 'off'); }} />
            <span style={{ fontSize: 12 }}>对话中允许本地模型自主调用云端助手（需实时行情/更强分析时；参数经安全审计，全程留痕）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, flexShrink: 0 }}>每日云端调用上限：</span>
            <InputNumber size="small" min={1} max={1000} value={cloudDailyLimit} onChange={async v => { setCloudDailyLimit(v ?? 50); await setSetting('ai_usage_cloud_daily_limit', String(v ?? 50)); }} style={{ width: 90 }} />
            <span style={{ fontSize: 11, color: '#94A3B8' }}>次（达上限自动停止云端调用并提示）</span>
          </div>
          {/* ===== 数据安全：一键封禁 Ollama 联网 ===== */}
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>数据安全保护</div>
          {!netOllamaFound && <div style={{ color: '#D97706', fontSize: 12, marginBottom: 8 }}>未检测到 ollama.exe（可能未安装或位置特殊），请使用项目中的「ollama-隔离工具.ps1」手动配置。</div>}
          {netOllamaFound && (
            <div style={{ padding: 12, borderRadius: 8, background: netLocked ? '#F0FDF4' : '#FFF7ED', border: `1px solid ${netLocked ? '#BBF7D0' : '#FED7AA'}`, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {netLocked
                  ? <CheckCircleOutlined style={{ color: '#16A34A', fontSize: 16 }} />
                  : <CloseCircleOutlined style={{ color: '#D97706', fontSize: 16 }} />}
                <span style={{ fontWeight: 600, fontSize: 13 }}>{netLocked ? 'Ollama 已离线（联网已封禁）' : 'Ollama 可联网'}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                {netLocked
                  ? 'Windows 防火墙已阻止 ollama.exe 的所有出站连接。你的成本数据被锁定在本机，即使模型想联网搜索也无法发出。本地AI助手不受影响。'
                  : '当前 Ollama 可访问互联网。为保护成本数据不外传，建议开启封禁（需要管理员授权一次）。'}
              </div>
              <Button
                size="small"
                type={netLocked ? 'default' : 'primary'}
                danger={!netLocked}
                loading={netBusy}
                icon={netLocked ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
                onClick={() => toggleNetLock(!netLocked)}
              >
                {netLocked ? '解除封禁' : '一键封禁联网'}
              </Button>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            <BulbOutlined style={{ marginRight: 6 }} /> 说明：本地AI助手只连接本机 Ollama（localhost）。封禁联网是在 Windows 防火墙层面彻底阻止 ollama.exe 访问外网，属于数据安全的最后一道硬防线。首次操作会弹出系统授权窗口。
          </div>
        </div>
      </Modal>

      {/* Context Knowledge Modal */}
      <Modal title={<span><BookOutlined /> 背景知识库</span>} open={showContext} onCancel={() => setShowContext(false)} footer={null} width={600}>
        <div style={{ marginBottom: 12, padding: 12, background: '#F8FAFC', borderRadius: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          存储背景知识（供应商格局、市场情报、公司策略等），每次对话自动带入让AI更有针对性。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <Input placeholder="标题（如：主要供应商格局）" value={ctxTitle} onChange={e => setCtxTitle(e.target.value)} />
          <Input.TextArea placeholder="内容描述（市场格局、竞争情报、供应商特点等）" value={ctxContent} onChange={e => setCtxContent(e.target.value)} autoSize={{ minRows: 4, maxRows: 10 }} />
          <Button type="primary" disabled={!ctxTitle.trim() || !ctxContent.trim()} onClick={async () => {
            await saveContextEntry(`ctx_${Date.now()}`, ctxTitle, ctxContent);
            setContextEntries(await loadContextEntries()); setCtxTitle(''); setCtxContent('');
          }}>添加</Button>
        </div>
        {contextEntries.map(e => (
          <div key={e.key} style={{ padding: 10, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{e.title}</span>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={async () => { await deleteContextEntry(e.key); setContextEntries(await loadContextEntries()); }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>{e.content}</div>
          </div>
        ))}
        {!contextEntries.length && <Empty description="暂无背景知识" image={Empty.PRESENTED_IMAGE_SIMPLE} />}

        {/* ===== 长期记忆（自动提炼） ===== */}
        <Divider style={{ margin: '16px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}><RobotOutlined style={{ marginRight: 6, color: '#8B5CF6' }} />长期记忆 <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>（对话后自动提炼，越用越懂你）</span></span>
          {memories.length > 0 && (
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={async () => {
              await clearAllMemories(); setMemories([]); message.success('已清空长期记忆');
            }}>清空</Button>
          )}
        </div>
        {memories.length > 0 ? memories.map(m => (
          <div key={m.id} style={{ padding: 10, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-primary)' }}>{m.content}</div>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ flexShrink: 0 }} onClick={async () => { await deleteMemory(m.id); setMemories(await loadMemories(50)); }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              命中 {m.hit_count} 次 · {(m.created_at || '').slice(0, 10)}
            </div>
          </div>
        )) : (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
            还没有记忆。和助手多聊几次业务（比如"我们的主力供应商是富士康"、"今年目标降本8%"），它会自动记住这些，下次分析时会主动引用。
          </div>
        )}
      </Modal>
      
      {/* ===== 复用确认（防重复洞察） ===== */}
      <Modal title="♻ 近期已洞察过该物料" open={!!bridgeReuseInfo} onCancel={() => setBridgeReuseInfo(null)} footer={null} width={460}>
        {bridgeReuseInfo && (() => {
          const { recent } = bridgeReuseInfo;
          let verdict = recent.verdict || '未知';
          let direction = '未知';
          try { direction = JSON.parse(recent.cloud_result || '{}').trend_direction || '未知'; } catch { }
          return (
            <div>
              <div style={{ fontSize: 13, marginBottom: 10 }}>
                {recent.created_at ? fmtA(recent.created_at) : ''} 已对该物料做过双向 AI 洞察：
              </div>
              <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, fontSize: 12, lineHeight: 1.8, marginBottom: 12 }}>
                行情方向：<b>{direction}</b> · 判定：<b style={{ color: verdict === '机会' ? '#16A34A' : verdict === '风险' ? '#DC2626' : '#64748B' }}>{verdict}</b><br />
                {recent.question ? '查询问题：' + recent.question : ''}
              </div>
              <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>
                直接复用可避免重复搜索（云端查询消耗资源）；物料行情 7 天内一般变化不大。需要最新行情可强制重新查询。
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button onClick={() => { const i = bridgeReuseInfo.ins; setBridgeReuseInfo(null); doBridgedInsight(i, false); }}>♻ 复用上次结果</Button>
                <Button type="primary" onClick={() => { const i = bridgeReuseInfo.ins; setBridgeReuseInfo(null); doBridgedInsight(i, true); }}>🔍 强制查询最新行情</Button>
              </div>
            </div>
          );
        })()}
      </Modal>
{/* ===== 云端发送前预览确认（本地-云端桥） ===== */}
      <Modal title="🔐 发送前确认（脱敏提示词）" open={!!bridgeReviewPrompt} onOk={() => { bridgeReviewResolve?.(true); setBridgeReviewPrompt(null); }} onCancel={() => { bridgeReviewResolve?.(false); setBridgeReviewPrompt(null); }} okText="确认发送" cancelText="取消" width={560}>
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 8, lineHeight: 1.6 }}>
          以下内容将发送给<b>云端模型</b>，仅含物料名/品类/问题（已通过敏感审计）。本地成本、供应商、项目数据不会包含。
        </div>
        <pre style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', margin: 0 }}>{bridgeReviewPrompt}</pre>
      </Modal>


      {/* 分类规则管理 */}
      <Modal
        title={<span><SettingOutlined /> 分类规则管理</span>}
        open={showRules} onCancel={() => setShowRules(false)} width={760} footer={null}
      >
        <Alert
          type="info" showIcon style={{ marginBottom: 12 }}
          message="规则引擎在历史经验之后、AI 之前匹配器件名关键词。规则命中即采用（确定性强），未命中才交给 AI。"
        />
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => {
            setRuleEditing(null); ruleForm.resetFields();
            ruleForm.setFieldsValue({ main_category: '硬件类', module: '其他' });
            setRuleFormVisible(true);
          }}>新增规则</Button>
          <Button size="small" icon={<RobotOutlined />} loading={ruleLearning} onClick={async () => {
            if (!model) { message.warning('请先连接Ollama并选择模型'); return; }
            setRuleLearning(true);
            setRuleLearnInfo({ module: '准备中…', done: 0, total: 1, elapsed: 0, chars: 0 });
            try {
              const n = await learnRulesFromDB(ollamaUrl, model, (module, done, total, chars) => {
                setRuleLearnInfo(prev => ({ module, done, total, elapsed: prev?.elapsed || 0, chars: chars || 0 }));
              });
              message.success(`已从现有分类学习到 ${n} 条规则`);
              setRules(await getModuleRules());
            } catch (e: any) { message.error(`学习失败：${e?.message || e}`); }
            finally { setRuleLearning(false); setRuleLearnInfo(null); }
          }}>从数据库学习</Button>
          <Button size="small" danger onClick={async () => {
            await clearModuleRules(); setRules([]); message.success('已清空所有规则');
          }}>清空</Button>
        </div>

        {/* AI 学习过程实时显示 */}
        {ruleLearning && ruleLearnInfo && (
          <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--color-accent-blue-bg)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
            <Spin size="small" />
            <span style={{ flex: 1 }}>
              AI 正在分析模块 <b style={{ color: 'var(--color-primary)' }}>「{ruleLearnInfo.module}」</b>
              <span style={{ color: 'var(--color-text-tertiary)' }}>（{ruleLearnInfo.done + 1}/{ruleLearnInfo.total} 个模块）</span>
              {ruleLearnInfo.chars > 0 && <span style={{ color: 'var(--color-text-tertiary)' }}> · 累计收到 {ruleLearnInfo.chars} 字符</span>}
            </span>
            <b>{ruleLearnInfo.elapsed}s</b>
          </div>
        )}

        <Table
          size="small" dataSource={rules} rowKey="id" pagination={{ pageSize: 8 }}
          columns={[
            { title: '关键词', dataIndex: 'keywords', render: (v: string) => v.split(/[,，]/).map((k: string, i: number) => <Tag key={i} style={{ marginBottom: 2 }}>{k.trim()}</Tag>) },
            { title: '模块', dataIndex: 'module', width: 110, render: (v: string) => <Tag color="blue">{v}</Tag> },
            { title: '大类', dataIndex: 'main_category', width: 90 },
            { title: '子类', dataIndex: 'sub_category', width: 90, render: (v: string) => v || '-' },
            { title: '来源', dataIndex: 'source', width: 70, render: (v: string) => v === 'learned' ? <Tag color="cyan">自动</Tag> : <Tag>手动</Tag> },
            { title: '操作', width: 90, render: (_: any, r: any) => (
                <Space size={4}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => {
                    setRuleEditing(r); ruleForm.setFieldsValue({
                      keywords: r.keywords, module: r.module, main_category: r.main_category, sub_category: r.sub_category,
                    }); setRuleFormVisible(true);
                  }} />
                  <Popconfirm title="删除此规则？" onConfirm={async () => { await deleteModuleRule(r.id); setRules(await getModuleRules()); }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ) },
          ]}
        />
        {!rules.length && <Empty description="暂无规则，可点击「从数据库学习」自动生成，或手动新增" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 20 }} />}
      </Modal>

      {/* 规则编辑弹窗 */}
      <Modal
        title={ruleEditing ? '编辑规则' : '新增规则'} open={ruleFormVisible} onCancel={() => setRuleFormVisible(false)}
        onOk={async () => {
          const v = await ruleForm.validateFields();
          try {
            await saveModuleRule({ id: ruleEditing?.id, ...v, source: ruleEditing?.source || 'manual' });
            message.success('已保存'); setRuleFormVisible(false); setRules(await getModuleRules());
          } catch (e: any) { message.error(`保存失败：${e?.message || e}`); }
        }} okText="保存" cancelText="取消" width={480}
      >
        <Form form={ruleForm} layout="vertical">
          <Form.Item name="keywords" label="关键词" rules={[{ required: true, message: '请填写关键词' }]} extra="多个关键词用逗号分隔，器件名含任一关键词即命中">
            <Input placeholder="如：面板,lcd,液晶,玻璃" />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="module" label="模块" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={['电源模块','显示模块','背光模块','驱动板模块','控制板模块','接口模块','结构件','包装材料','连接线材','声学模块','散热组件','其他'].map(m => ({ value: m, label: m }))} />
            </Form.Item>
            <Form.Item name="main_category" label="大类" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={MAIN_CATEGORIES.map(c => ({ value: c, label: c }))} />
            </Form.Item>
          </div>
          <Form.Item name="sub_category" label="子类（可选）">
            <Input placeholder="如：面板、电容" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 智能BOM导入 - 三步向导 */}
      <Modal
        title={<span><FileExcelOutlined /> 智能BOM导入</span>}
        open={importModalOpen}
        onCancel={() => setImportModalOpen(false)}
        width={960}
        footer={null}
        destroyOnClose
      >
        <Steps
          size="small" current={importStep}
          style={{ marginBottom: 20 }}
          items={[{ title: '上传BOM' }, { title: 'AI分类确认' }, { title: '导入完成' }]}
        />

        {/* ===== 第1步：上传 ===== */}
        {importStep === 0 && (
          <div>
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message="上传供应商原始BOM（Excel/CSV）"
              description="系统自动识别器件名称、型号、单价、数量。无需整理格式，支持供应商常用的任意表头。"
            />
            <Upload.Dragger
              accept=".xlsx,.xls,.csv"
              showUploadList={false}
              beforeUpload={async (file) => {
                try {
                  const result = await parseSupplierBOM(file);
                  if (!result.rows.length) { message.warning('未解析到有效器件行'); return false; }
                  setImportRows(result.rows);
                  setImportSkipped(result.skipped);
                  setImportHeaderFound(result.headerFound);
                  setImportStep(1);
                } catch (e: any) { message.error(String(e?.message || e)); }
                return false;
              }}
              style={{ padding: 20 }}
            >
              <p className="ant-upload-drag-icon"><UploadOutlined style={{ fontSize: 40 }} /></p>
              <p className="ant-upload-text">点击或拖拽文件到这里</p>
              <p className="ant-upload-hint">支持 .xlsx / .xls / .csv，自动识别常见列名</p>
            </Upload.Dragger>
          </div>
        )}

        {/* ===== 第2步：AI分类 + 确认 ===== */}
        {importStep === 1 && (
          <div>
            {/* 模板/行解析诊断提示 */}
            {!importHeaderFound && (
              <Alert
                type="warning" showIcon style={{ marginBottom: 12 }}
                message="未能识别标准表头，已按首行作为表头解析"
                description="建议表头包含「器件名称/品名」「型号」「单价」「数量」等列名，识别会更准确。"
              />
            )}
            {importSkipped.length > 0 && (
              <Alert
                type="warning" showIcon style={{ marginBottom: 12 }}
                message={`有 ${importSkipped.length} 行未能识别（已跳过）`}
                description={
                  <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {importSkipped.slice(0, 20).map((s, i) => (
                      <div key={i} style={{ fontSize: 12 }}>第 {s.row} 行：{s.reason}</div>
                    ))}
                    {importSkipped.length > 20 && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>…还有 {importSkipped.length - 20} 行</div>}
                  </div>
                }
              />
            )}
            {/* 顶部：项目选择（可选已有/新建）+ 操作按钮 */}
            <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select<number | '__new__'>
                placeholder="导入到项目（可选）" allowClear style={{ width: 200 }}
                options={[
                  ...projects.map(p => ({ value: p.id, label: p.code })),
                  { value: '__new__', label: '＋ 新建项目…' },
                ]}
                onChange={(v) => {
                  if (v === '__new__') {
                    setShowNewProjectForm(true);
                    setImportTargetProject(undefined);
                  } else {
                    setShowNewProjectForm(false);
                    setImportTargetProject(v as number | undefined);
                  }
                }}
                value={showNewProjectForm ? undefined : importTargetProject}
              />
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>共 <b>{importRows.length}</b> 个器件</span>
              {!importClassifying && !importRows.some(r => r.main_category !== undefined) && (
                <Button type="primary" icon={<RobotOutlined />} onClick={async () => {
                  if (!model) { message.warning('请先连接Ollama并选择模型'); return; }
                  setImportClassifying(true);
                  setClassifyInfo({ done: 0, total: importRows.length, summary: '准备中…', elapsed: 0 });
                  try {
                    const classified = await classifyBOMWithAI(ollamaUrl, model, importRows, knownModules, (done, total, summary) => {
                      setClassifyInfo(prev => ({ done, total, summary: summary || prev?.summary || '', elapsed: prev?.elapsed || 0 }));
                    });
                    setImportRows(classified);
                    setImportClassifying(false);
                    const fb = classified.filter((x: any) => x.source === 'rule' || x.source === 'fallback').length;
                    if (fb > 0) message.warning(`分类完成，但 ${fb} 项未能由 AI 解析（已用规则/历史经验兜底），请核对`);
                    else message.success('AI分类完成，请核对');
                  } catch (e: any) {
                    message.error(`分类失败：${e?.message || e}`);
                  } finally { setImportClassifying(false); }
                }}>开始AI分类</Button>
              )}
            </div>

            {/* 新建项目表单 */}
            {showNewProjectForm && (
              <div style={{ marginBottom: 12, padding: 12, background: 'var(--color-accent-blue-bg)', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>新建项目：</span>
                <Input placeholder="项目代号（如：M270-Pro）" style={{ width: 180 }} value={newProjectCode} onChange={e => setNewProjectCode(e.target.value)} />
                <Input placeholder="项目名称（可选）" style={{ width: 160 }} value={newProjectName} onChange={e => setNewProjectName(e.target.value)} />
                <Button
                  type="primary" size="small"
                  disabled={!newProjectCode.trim()}
                  onClick={async () => {
                    try {
                      const db = await getDb();
                      const dup = await db.select<any[]>('SELECT id FROM projects WHERE code=?', [newProjectCode.trim()]);
                      if (dup.length) { message.warning(`项目代号「${newProjectCode.trim()}」已存在，请换一个或选择已有项目`); return; }
                      const pid = await saveProject({
                        code: newProjectCode.trim(),
                        name: newProjectName.trim() || newProjectCode.trim(),
                        project_type: '在研', tier: '主流级', status: '进行中',
                        platform_fee_rate: 0, profit_rate: 0,
                      });
                      setProjects(await db.select<any[]>('SELECT id,code,name FROM projects WHERE COALESCE(is_deleted,0)=0 ORDER BY code'));
                      setImportTargetProject(pid);
                      setShowNewProjectForm(false);
                      setNewProjectCode(''); setNewProjectName('');
                      message.success(`项目「${newProjectCode.trim()}」已创建`);
                    } catch (e: any) { message.error(`创建失败：${e?.message || e}`); }
                  }}
                >创建</Button>
                <Button size="small" type="text" onClick={() => { setShowNewProjectForm(false); setNewProjectCode(''); setNewProjectName(''); }}>取消</Button>
              </div>
            )}

            {importClassifying && (
              <div style={{ padding: 24, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                <Spin size="large" style={{ marginBottom: 12 }} />
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>本地模型正在分析器件分类…</div>
                {classifyInfo && (
                  <div style={{ fontSize: 13, marginBottom: 8 }}>
                    已处理 <b style={{ color: 'var(--color-primary)' }}>{classifyInfo.done}</b> / {classifyInfo.total} 个器件 · 用时 {classifyInfo.elapsed}s
                  </div>
                )}
                <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                  {classifyInfo?.summary || '已沿用你历史分类的不需要AI处理，只分析新器件'}
                </div>
              </div>
            )}

            {!importClassifying && importRows.some(r => r.main_category !== undefined) && (
              <>
                <Alert
                  type="success" showIcon style={{ marginBottom: 12 }}
                  message={`分类完成：已沿用你的历史分类 ${importRows.filter(r => r.source === 'existing').length} 个，规则识别 ${importRows.filter(r => r.source === 'rule').length} 个，AI新建议 ${importRows.filter(r => r.source === 'ai' || !r.source).length} 个`}
                  description="绿色「沿用历史/规则识别」可信；蓝色「AI建议」请重点核对。所有项都可下拉修改。"
                />
                <Table
                  size="small" rowKey={(_, i) => String(i)}
                  dataSource={importRows}
                  pagination={{ pageSize: 10, showSizeChanger: true }}
                  scroll={{ x: 950 }}
                  columns={[
                    { title: '器件', dataIndex: 'name', width: 140, render: (v, r) => (
                        <Tooltip title={`${v}${r.model ? `\n型号: ${r.model}` : ''}${r.remark ? `\n备注: ${r.remark}` : ''}`} placement="topLeft">
                          <div>
                            <div style={{ fontWeight: 500, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{v}</div>
                            {r.model && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{r.model}</div>}
                          </div>
                        </Tooltip>
                      ) },
                    { title: '数量', dataIndex: 'qty', width: 50 },
                    { title: '单价(¥)', dataIndex: 'cost', width: 80, render: (v) => <span>{Number(v).toFixed(2)}</span> },
                    { title: '所属模块', dataIndex: 'module', width: 140, render: (v, _, i) => (
                        <Select size="small" value={v} style={{ width: '100%' }} onChange={val => updateImportRow(i, 'module', val)}
                          options={[...new Set([...knownModules.map(m => m.name), '电源模块', '显示模块', '驱动板模块', '结构件', '包装材料', '连接线材', '声学模块', '控制板', '背光模块', '外壳结构', '其他'])].map(x => ({ value: x, label: x }))}
                          showSearch />
                      ) },
                    { title: '大类', dataIndex: 'main_category', width: 88, render: (v, _, i) => (
                        <Select size="small" value={v} style={{ width: '100%' }} onChange={val => updateImportRow(i, 'main_category', val)} options={MAIN_CATEGORIES.map(c => ({ value: c, label: c }))} />
                      ) },
                    { title: '子类', dataIndex: 'sub_category', width: 105, render: (v, _, i) => (
                        <Input size="small" value={v} onChange={e => updateImportRow(i, 'sub_category', e.target.value)} />
                      ) },
                    { title: '来源', dataIndex: 'source', width: 86, render: (v) => v === 'existing'
                        ? <Tag color="green" style={{ marginRight: 0 }}>沿用历史</Tag>
                        : v === 'rule'
                        ? <Tag color="cyan" style={{ marginRight: 0 }}>规则识别</Tag>
                        : <Tag color="blue" style={{ marginRight: 0 }}>AI建议</Tag> },
                    { title: '置信度', dataIndex: 'confidence', width: 68, render: (v) => {
                        const c = Number(v) || 0;
                        const color = c >= 0.8 ? '#16A34A' : c >= 0.5 ? '#D97706' : '#DC2626';
                        return <span style={{ color, fontWeight: 600 }}>{Math.round(c * 100)}%</span>;
                      } },
                  ]}
                />
              </>
            )}

            {/* 底部操作 */}
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
              <Button onClick={() => { setImportStep(0); setImportRows([]); }}>← 重新上传</Button>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => setImportModalOpen(false)}>取消</Button>
                {!importClassifying && importRows.some(r => r.main_category !== undefined) && (
                  <Button type="primary" icon={<CheckCircleOutlined />} loading={importing} onClick={async () => {
                    setImporting(true);
                    try {
                      await doSmartImport(importRows, importTargetProject, (done, total) => {
                        message.loading({ content: `正在导入… ${done}/${total}`, key: 'smart_import', duration: 0 });
                      });
                      message.destroy('smart_import');
                      setImportStep(2);
                    } catch (e: any) {
                      message.destroy('smart_import');
                      message.error(`导入失败：${e?.message || e}`);
                    } finally { setImporting(false); }
                  }}>确认导入</Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===== 第3步：完成 ===== */}
        {importStep === 2 && (
          <div style={{ textAlign: 'center', padding: '30px 0' }}>
            <CheckCircleOutlined style={{ fontSize: 56, color: '#16A34A', marginBottom: 16 }} />
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>导入完成！</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 13, marginBottom: 20 }}>
              共导入 <b>{importRows.length}</b> 个器件{importTargetProject ? `到项目「${projects.find(p => p.id === importTargetProject)?.code || ''}」` : ''}，可在器件库中查看。
            </div>
            <Button type="primary" onClick={() => { setImportModalOpen(false); setImportStep(0); setImportRows([]); setImportTargetProject(undefined); }}>
              完成
            </Button>
          </div>
        )}
      </Modal>

      {/* 演示生成（本地 AI → HTML/PPTX 文件）——独立新功能 */}
      <Modal title={<span><FilePptOutlined /> 演示生成 · 本地 AI（素材与习惯均不出本机）</span>} open={showDemo}
        onCancel={() => setShowDemo(false)} footer={null} width={1040}
        styles={{ body: { maxHeight: '76vh', overflow: 'auto', paddingTop: 8 } }}>
        <DemoGenerator />
      </Modal>

      {/* AI 学习：回答反馈（👎 原因 → 沉淀逻辑偏好规则） */}
      <Modal
        title={<span><ExperimentOutlined /> 教 AI 理解你的偏好</span>}
        open={!!feedbackModal}
        onCancel={() => setFeedbackModal(null)}
        footer={null}
        width={480}
      >
        {feedbackModal && (
          <div>
            <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10, maxHeight: 60, overflow: 'auto' }}>
              你的问题：{feedbackModal.userText.slice(0, 120) || '（无法获取原问题）'}
            </div>
            <Radio.Group
              value={feedbackReason}
              onChange={e => setFeedbackReason(e.target.value)}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {Object.entries(FEEDBACK_REASONS_UI).map(([key, label]) => (
                <Radio key={key} value={key} style={{ fontSize: 13 }}>{label}</Radio>
              ))}
            </Radio.Group>
            <Input.TextArea
              value={feedbackCustom}
              onChange={e => setFeedbackCustom(e.target.value)}
              placeholder="或者直接告诉我你期望的分析方式（可选）：如「按子类对比成本」「先给结论再给数据」…"
              style={{ marginTop: 12, fontSize: 12.5 }}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <Button size="small" style={{ marginRight: 8 }} onClick={() => setFeedbackModal(null)}>取消</Button>
              <Button size="small" type="primary" onClick={async () => {
                try {
                  const m = await import('../aiLearning');
                  const topic = m.classifyUserQuestion(feedbackModal.userText)[0] || '通用';
                  const pref = m.feedbackToPreference(feedbackReason, feedbackCustom);
                  await m.addLearnedRule({ topic, preference: pref, source: 'feedback' });
                  setFeedbackMap(prev => ({ ...prev, [feedbackModal.index]: 'down' }));
                  setFeedbackModal(null);
                  message.success('已学习！后续 AI 回答会遵守这条偏好（可在「🧠 学习档案」查看）', 2);
                } catch { message.error('记录失败，请重试'); }
              }}>确认学习</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* AI 学习档案：关注主题 + 已学规则 */}
      <Modal
        title={<span><ExperimentOutlined /> AI 学习档案 · 它从对话中学到了什么</span>}
        open={showLearn}
        onCancel={() => setShowLearn(false)}
        footer={null}
        width={560}
      >
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>🎯 你的关注重点（按近期提及频率）</div>
          {learnFocus.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94A3B8' }}>还没有数据——多和我对话，我会记住你常问什么</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {learnFocus.slice(0, 5).map(f => {
                const max = learnFocus[0]?.weight || 1;
                return (
                  <div key={f.topic} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                    <span style={{ width: 70, flexShrink: 0 }}>{f.topic}</span>
                    <div style={{ flex: 1, background: '#F1F5F9', borderRadius: 4, height: 14, overflow: 'hidden' }}>
                      <div style={{ width: Math.max(8, Math.round((f.weight / max) * 100)) + '%', background: 'linear-gradient(90deg,#60A5FA,#3B82F6)', height: '100%', borderRadius: 4 }} />
                    </div>
                    <span style={{ color: '#94A3B8', width: 46, textAlign: 'right' }}>{f.weight} 次</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}><BulbOutlined /> 已学到的逻辑偏好（后续回答必须遵守）</div>
          {learnRules.length === 0 ? (
            <div style={{ fontSize: 12, color: '#94A3B8' }}>还没有——对我某条回答点 👎 并说明原因，我就会记住</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {learnRules.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12.5, border: '1px solid #E8ECF1', borderRadius: 8, padding: '7px 9px' }}>
                  <Tag style={{ margin: 0, flexShrink: 0, fontSize: 10.5 }}>{r.topic}</Tag>
                  <span style={{ flex: 1 }}>{r.preference}</span>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ fontSize: 11, height: 20 }} onClick={async () => {
                    try { const m = await import('../aiLearning'); await m.deleteLearnedRule(r.id); } catch { /* 静默 */ }
                    await loadLearnData();
                  }} />
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 数据分析工具（⚡功能菜单 → 右侧抽屉，Demo B 重构） */}
      <Drawer title={<span><ToolOutlined /> 数据分析工具</span>} open={toolsOpen} onClose={() => setToolsOpen(false)} width={330}>
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 12, lineHeight: 1.6 }}>
          点击工具注入对应的本地数据到当前对话——AI 回答将基于你的真实数据。
        </div>
        {TOOLS.map(t => (
          <div key={t.label} style={{ marginBottom: 8 }}>
            <div onClick={() => setExpandedTool(expandedTool === t.label ? null : t.label)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px', borderRadius: 9, border: '1px solid #E8ECF3', background: expandedTool === t.label ? '#FAFBFF' : '#fff' }}>
              <span style={{ color: t.color, fontSize: 15 }}>{t.icon}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9CA3AF' }}>{expandedTool === t.label ? '收起 ▲' : '展开 ▼'}</span>
            </div>
            {expandedTool === t.label && <div style={{ padding: '8px 4px 2px' }}>{t.render()}</div>}
          </div>
        ))}
      </Drawer>
    </div>
  );
}
