import { expect, it, vi } from 'vitest';
import { analyzeBom } from '../ai/bomAnalysis';
const source = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('../db', () => ({ getProjects: async () => [{id:1,code:'M-270',name:'测试显示器'}], getProjectBOMs: async()=>source.rows, localNow:()=> '2026-09-17' }));
import { executeStructuredTool } from '../ai/toolRegistry';

it('ranks full data before limiting, resolves name, separates unit/extended costs, ties, unknowns and groups', async () => {
  source.rows = Array.from({length:10000},(_,i)=>({id:i+1,part_name:`器件${i+1}`,part_model:'X',part_cost:1,quantity:2,price_state:'confirmed',module_name:'硬件',main_category:'硬件类'}));
  source.rows.push({id:10001,part_name:'面板',part_cost:300,quantity:1,price_state:'confirmed',module_name:'屏幕'}, {id:10002,part_name:'电容组',part_cost:2,quantity:200,price_state:'confirmed',module_name:'硬件'});
  const started=performance.now();
  const result = await executeStructuredTool({name:'query_project_bom',args:{project_code:'测试显示器',view:'rank',limit:1}});
  expect(result.ok).toBe(true);
  expect((result.data as any).rows[0]).toMatchObject({bomId:10001,unitCost:300});
  expect(JSON.stringify(result).length).toBeLessThan(2500);
  expect(result.evidence.some(e=>e.refType==='bom' && e.refId===10001)).toBe(true);
  expect(analyzeBom(source.rows,{view:'rank',metric:'extended_cost',limit:1}).rows[0]).toMatchObject({bomId:10002});
  expect(analyzeBom(source.rows,{view:'summary'}).total).toBe(20700);
  expect(analyzeBom(source.rows,{view:'group',limit:1}).rows[0]).toMatchObject({name:'硬件',total:20400,count:10001});
  source.rows.push({id:10003,part_name:'未知',part_cost:null,quantity:1}, {id:10004,part_name:'无数量',part_cost:300,quantity:null,price_state:'confirmed'});
  const incomplete=analyzeBom(source.rows,{view:'rank',limit:1});
  expect(incomplete.total).toBeNull();expect(incomplete.missingCount).toBe(2);expect(incomplete.tiedAtBoundary).toBe(2);
  expect(analyzeBom(source.rows,{view:'group'}).rows.find(r=>r.name==='未分类')).toMatchObject({total:null});
  expect(analyzeBom(source.rows,{view:'summary',module:'屏幕'})).toMatchObject({matchedCount:1,total:300});
  expect(analyzeBom(source.rows,{view:'rank',keyword:'不存在'})).toMatchObject({matchedCount:0,total:null,rows:[]});
  expect(()=>analyzeBom(source.rows,{limit:0})).toThrow();
  console.log(`10002-row real tool ranking: ${Math.round(performance.now()-started)}ms, result ${JSON.stringify(result).length} chars`);
});
