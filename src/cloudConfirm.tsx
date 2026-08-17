// 云端发送前确认（v2.3.19，2026-08-16）
// 背景：自动洞察（autoInsight 后台轮询）绕过 aiBridge 的组件内预览确认，用户开了 preview 却收不到弹窗
// 方案：全局确认——任何自动链路（autoInsight 等）在调用云端前调 requestCloudConfirm：
//   settings ai_bridge_review === 'preview' → 弹 antd Modal.confirm（展示将发送的提示词）→ 用户确认/跳过
//   'auto'（默认）→ 直接放行；设置读取失败 → 放行（不阻断业务）
import { Modal } from 'antd';
import { getSetting } from './db';

export interface CloudConfirmPayload {
  material: string;   // 物料通用名称
  category: string;   // 品类
  question?: string;  // 查询问题描述
}

/** 请求云端发送确认：返回 true=放行，false=用户拒绝（调用方应跳过该次洞察） */
export async function requestCloudConfirm(payload: CloudConfirmPayload): Promise<boolean> {
  try {
    const mode = await getSetting('ai_bridge_review', 'auto');
    if (mode !== 'preview') return true;
  } catch { return true; }
  return new Promise<boolean>(resolve => {
    Modal.confirm({
      title: '🔐 云端发送确认',
      width: 500,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ marginBottom: 8, color: '#4B5563' }}>
            自动洞察将向云端发送以下内容（<b>仅物料名/品类/问题三项</b>，结构上无成本/供应商/项目数据）：
          </div>
          <div style={{ background: '#F5F7FF', border: '1px dashed #C7D2FE', borderRadius: 8, padding: '10px 14px', lineHeight: 1.9, fontFamily: 'monospace', fontSize: 12.5 }}>
            物料：{payload.material}<br />
            品类：{payload.category || '未指定'}<br />
            问题：{payload.question || '近 1-3 月价格趋势分析（price-trend）'}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#94A3B8' }}>
            确认后本次洞察才会执行；「跳过」则暂不洞察该物料（可稍后手动洞察）。每次发送都会写入审计日志。
          </div>
        </div>
      ),
      okText: '确认发送',
      cancelText: '跳过',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
