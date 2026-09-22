import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({stream:vi.fn()}));
vi.mock('../ollama',()=>({startOllamaStream:mocks.stream}));
import {runPiAgent} from '../ai/piRuntime';
import {selectAgentTools} from '../ai/toolSelection';

it('exposes native full-data ranking immediately and stops consecutive identical reads without reexecution', async()=>{
 const tools=selectAgentTools('M270 最贵的器件是哪个');
 const bom=tools.find(t=>t.id==='query_project_bom')!;
 expect(bom.params.find(p=>p.key==='view')?.enum).toContain('rank');
 const execute=vi.fn(async()=>({ok:true,text:'面板 300 元，来源 BOM 10001'}));
 let requests=0;
 mocks.stream.mockImplementation(async(...args:any[])=>{
  const names=(args[7].tools||[]).map((t:any)=>t.function.name);
  if(requests<3) { expect(names).toContain('query_project_bom');args[7].onToolCalls([{id:`rank-${requests}`,function:{name:'query_project_bom',arguments:requests%2 ? {limit:1,view:'rank',project_code:'M270'} : {project_code:'M270',view:'rank',limit:1}}}]); }
  else {expect(names).toEqual([]);args[3]('面板单价最高，为 300 元。');}
  requests++;if(requests>4)throw new Error('重复工具没有收尾');args[5]();
 });
 const result=await runPiAgent({baseUrl:'http://localhost',model:'test',systemPrompt:'',userContent:'M270 最贵的器件是哪个',tools,executeTool:execute});
 expect(execute).toHaveBeenCalledTimes(1);expect(requests).toBe(4);expect(result.finalText).toContain('300');
},15000);

it('detects alternating duplicate read loops and emits content-free execution metrics', async()=>{
 const tools=selectAgentTools('M270 成本');
 const execute=vi.fn(async()=>({ok:true,text:'synthetic evidence'}));
 const metrics=vi.fn();let request=0;
 mocks.stream.mockImplementation(async(...args:any[])=>{
  const name=request%2 ? 'query_project_cost' : 'query_project_bom';
  if(request<4) args[7].onToolCalls([{id:`alt-${request}`,function:{name,arguments:{project_code:'M270'}}}]);
  else args[3]('已完成');
  if(++request>5) throw new Error('alternating loop did not stop');args[5]();
 });
 await runPiAgent({baseUrl:'http://localhost',model:'test',systemPrompt:'',userContent:'M270 成本',tools,executeTool:execute,onMetrics:metrics});
 expect(execute).toHaveBeenCalledTimes(2);expect(request).toBe(5);
 expect(metrics).toHaveBeenCalledWith(expect.objectContaining({rounds:5,toolCalls:4}));
 expect(JSON.stringify(metrics.mock.calls)).not.toContain('synthetic evidence');
},15000);
