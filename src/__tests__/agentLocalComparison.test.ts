// Opt-in local-only comparison. Uses synthetic data, no business DB or writes.
import { expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({stream:vi.fn()}));
vi.mock('../ollama',()=>({startOllamaStream:transport.stream}));
import {Agent} from '@earendil-works/pi-agent-core';
import {runPiAgent} from '../ai/piRuntime';
import {createCostHubPiStream} from '../ai/piStream';
import {buildNativeSystemPrompt} from '../ai/nativePrompt';
import {buildLocalChatBody} from '../localBackend';
import {selectAgentTools} from '../ai/toolSelection';
import {schemaFor} from '../ai/toolSchema';

it.skipIf(!process.env.COSTHUB_LIVE_MODEL)('compares bare Pi with CostHub using the same local model and synthetic tool',async()=>{
 const base=process.env.COSTHUB_LIVE_URL || 'http://127.0.0.1:8080';
 const url=new URL(base);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.protocol!=='http:' || url.username || url.password || url.pathname!=='/') throw new Error('Only a loopback HTTP model server is allowed');
 const model=process.env.COSTHUB_LIVE_MODEL!;
 const think=process.env.COSTHUB_LIVE_THINK==='1';
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),240000);
 let calls=0;
 transport.stream.mockImplementation(async(_base,modelName,messages,onText,onThinking,onDone,onError,opts)=>{
  try {
   if(++calls>12) throw new Error('Comparison request limit reached');
   const body=buildLocalChatBody('llama.cpp',modelName,messages,{think,stream:false,temperature:0,tools:opts.tools});
   const res=await fetch(base.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
   if(!res.ok) throw new Error('HTTP '+res.status);
   const data=await res.json();const message=data.choices?.[0]?.message;
   if(!message) throw new Error('Missing assistant response');
   if(message.reasoning_content) onThinking(message.reasoning_content);
   if(message.content) onText(message.content);
   if(message.tool_calls?.length) opts.onToolCalls?.(message.tool_calls);
   opts.onUsage?.({promptEvalCount:data.usage?.prompt_tokens,evalCount:data.usage?.completion_tokens,doneReason:data.choices?.[0]?.finish_reason});onDone();
  } catch(error) {onError(String(error));}
  return ()=>{};
 });
 const tool=selectAgentTools('项目成本最贵器件').find(t=>t.id==='query_project_bom')!;
 const evidence='SYNTH-01 全部三行已核对：面板 300 元、驱动板 50 元、电源 20 元。单价最高是面板 300 元。';
 const question='SYNTH-01 最贵的器件是哪个？请查工具后回答。';
 const report:any[]=[];
 try {
  // Alternate order on repeat to observe warm-cache effects. Compare medians, not one run.
  for(const mode of (process.env.COSTHUB_LIVE_ORDER==='costhub-first'?['costhub','bare']:['bare','costhub'])) {
   const start=performance.now();let toolCalls=0,firstToolMs:number|undefined,inputTokens=0,outputTokens=0,rounds=0;
   const execute=async(id:string)=>{if(id!==tool.id)throw new Error('Only synthetic BOM reads are permitted');toolCalls++;firstToolMs??=performance.now()-start;return {ok:true,text:evidence};};
   let answer='';
   if(mode==='costhub') {
    const result=await runPiAgent({baseUrl:base,backend:'llama.cpp',model,think,contextWindow:32768,systemPrompt:buildNativeSystemPrompt(),userContent:question,tools:[tool],signal:controller.signal,executeTool:execute,onMetrics:m=>{inputTokens=m.inputTokens;outputTokens=m.outputTokens;rounds=m.rounds;}});answer=result.finalText;
   } else {
    const agent=new Agent({streamFn:createCostHubPiStream(base,model,undefined,'llama.cpp'),initialState:{systemPrompt:'Use the provided tool for project facts. Answer briefly from its result.',model:{id:model,name:model,api:'costhub-ollama',provider:'costhub',baseUrl:base,reasoning:think,input:['text'],contextWindow:32768,maxTokens:16384,__unlimitedOutput:true,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} as any,thinkingLevel:think?'medium':'off',tools:[{name:tool.id,label:tool.name,description:tool.desc,parameters:schemaFor(tool),execute:async()=>({content:[{type:'text',text:(await execute(tool.id)).text}]})} as any]}});
    const abort=()=>agent.abort();controller.signal.addEventListener('abort',abort,{once:true});
    agent.subscribe(event=>{if(event.type==='turn_start')rounds++;if(event.type==='message_end'&&event.message.role==='assistant'){inputTokens+=event.message.usage.input;outputTokens+=event.message.usage.output;answer=event.message.content.filter(p=>p.type==='text').map(p=>(p as any).text).join('');}});
    try{await agent.prompt(question);}finally{controller.signal.removeEventListener('abort',abort);}
   }
   report.push({mode,elapsedMs:Math.round(performance.now()-start),firstToolMs:Math.round(firstToolMs||0),toolCalls,rounds,inputTokens,outputTokens,correct:toolCalls>0&&answer.includes('面板')&&answer.includes('300')});
  }
  console.log(JSON.stringify({model,think,transport:'non-streaming local HTTP; no TTFT measurement; no desktop rendering/persistence',report},null,2));
  expect(report.every(row=>row.correct)).toBe(true);
 } finally {clearTimeout(timer);controller.abort();}
},250000);
