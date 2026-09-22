import { expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('../ollama', () => ({ startOllamaStream: mocks.stream }));
import { runPiAgent } from '../ai/piRuntime';

it.each([1, 3])('runs %i batch calls without shell or redundant read recovery', async (calls) => {
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['型号','数量','单价'],['A',2,3.25]]),'报价');
  const bytes=new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'}));
  const writeFile=vi.fn(async()=>({ok:true,value:undefined}));
  const execution:any={workspace:'workspace',shellEnabled:false,skills:[],dependencies:{},diagnostics:[],env:{absolutePath:async(path:string)=>({ok:true,value:path}),readBinaryFile:async()=>({ok:true,value:bytes}),writeFile}};
  const source={path:'quote.xlsx',sheet:'报价',startRow:2,endRow:2,priceColumn:'C',quantityColumn:'B',keyColumns:['A'],basis:'CNY 含税 元/台'};
  let requests=0;
  mocks.stream.mockImplementation(async (...args:any[])=>{
    const names=(args[7].tools || []).map((tool:any)=>tool.function.name);
    expect(names).not.toContain('powershell');
    if(requests===0){args[7].onToolCalls([{id:'activate',function:{name:'activate_tools',arguments:{tool_ids:['read_excel']}}}]);}
    else if(requests<=calls){expect(names).toContain('analyze_spreadsheet');args[7].onToolCalls([{id:'batch-'+requests,function:{name:'analyze_spreadsheet',arguments:{action:'calculate',source}}}]);}
    else {if(calls===3)expect(names).toEqual([]);args[3]('根据已有计算，合计 6.5 元。');}
    requests++;if(requests>calls+2)throw new Error('工具循环未停止');args[5]();
  });
  const result=await runPiAgent({baseUrl:'http://localhost',model:'test',contextWindow:32768,systemPrompt:'',userContent:'核对报价',tools:[],execution,executeTool:vi.fn(),onCheckpoint:async()=>{}});
  expect(requests).toBe(calls+2);
  expect(writeFile.mock.calls.filter((call: any[]) => String(call[0]).endsWith('.txt'))).toHaveLength(1);
  expect(writeFile.mock.calls.some((call: any[]) => String(call[0]).endsWith('.meta.json'))).toBe(true);
  expect(result.finalText).toContain('6.5');
  const toolResults = result.messages.filter(message=>message.role==='toolResult');
  expect(toolResults).toHaveLength(calls+1);
  expect(JSON.stringify(toolResults)).toContain('resultId');
},15000);

