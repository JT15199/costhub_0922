import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { calculateSheet, createSpreadsheetTool, type SheetSource } from '../ai/spreadsheetTool';
const source: SheetSource = { path:'quote.xlsx',sheet:'报价',startRow:2,endRow:4,priceColumn:'D',quantityColumn:'C',keyColumns:['A'],groupColumn:'B',subtotalColumn:'E',basis:'CNY 含税 元/台' };
const workbook = (rows: unknown[][]) => { const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'报价');return book; };
const fixture = () => workbook([['型号','模块','数量','单价','小计'],['A','电源',2,3.25,6.5],['B','结构',1,0,0],['C','结构','',8,8]]);
function host(book: XLSX.WorkBook) {
  let binary = new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'}));
  const files=new Map<string,string>();let denied=false;
  const execution:any={env:{absolutePath:async(path:string)=>denied?{ok:false,error:new Error('任务目录外路径')}:{ok:true,value:path},readBinaryFile:async()=>({ok:true,value:binary}),writeFile:async(path:string,content:string)=>{files.set(path,content);return {ok:true,value:undefined};}}};
  const tool=createSpreadsheetTool(execution);
  return {files,tool,change:(book:XLSX.WorkBook)=>{binary=new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'}));},deny:()=>{denied=true;},call:async(args:any)=>{const result=await tool.execute('call',args);return JSON.parse((result.content[0] as any).text);}};
}
describe('bulk spreadsheet analysis',()=>{
 it('keeps missing values unknown, accepts explicit zero and does not trust formulas',()=>{
  const book=fixture();book.Sheets['报价'].D3={t:'n',v:999,f:'1+1'};
  const result=calculateSheet(book,source);
  expect(result.summary.total).toBeNull();expect(result.summary.knownSubtotal).toBe(6.5);expect(result.summary.missingAmounts).toBe(2);
  expect(calculateSheet(fixture(),source).rows[1].amount).toBe(0);
  expect(()=>calculateSheet(book,{...source,endRow:99})).toThrow();
  expect(()=>calculateSheet(book,{...source,priceColumn:'D;fetch()'})).toThrow();
 });
 it('flags duplicate identifiers and mismatched quoted subtotals',()=>{
  const book=fixture();book.Sheets['报价'].A3.v='A';book.Sheets['报价'].E2.v=99;
  const result=calculateSheet(book,source);
  expect(result.rows[0].issues).toContain('报价小计与单价×数量不一致');
  expect(result.rows[1].issues).toContain('匹配标识重复，不自动配对');
 });
 it('computes 10000 rows with compact output, reuses identical results and invalidates changed bytes',async()=>{
  const rows=[['型号','模块','数量','单价','小计'],...Array.from({length:10000},(_,i)=>['PART-'+i,'电源',2,3.25,6.5])];
  const h=host(workbook(rows)), mapping={...source,endRow:10001};
  const inspect=await h.call({action:'inspect',path:'quote.xlsx'});expect(inspect.sample).toHaveLength(6);
  const result=await h.call({action:'calculate',source:mapping});expect(result.current.total).toBe(65000);expect(result.current.rowCount).toBe(10000);expect(result.cacheHit).toBe(true);
  const text=JSON.stringify(result);expect(text.length).toBeLessThan(2500);expect(h.files.get(result.fullResultPath)?.split('\n')).toHaveLength(10001);
  expect((await h.call({action:'calculate',source:mapping})).reused).toBe(true);expect(h.files.size).toBe(1);
  const repeated=await h.tool.execute('repeat',{action:'calculate',source:mapping});expect((repeated.details as any).stopLoop).toBe(true);
  rows[1]=['PART-0','电源',2,4,8];h.change(workbook(rows));
  expect((await h.call({action:'calculate',source:mapping})).current.total).toBe(65001.5);
  console.log('10000 rows: model summary chars',text.length,'vs full table JSON chars',JSON.stringify(rows).length);
 });
 it('compares only unambiguous equal-quantity equal-basis rows and retains reference-only rows',async()=>{
  const h=host(fixture());
  const result=await h.call({action:'calculate',source:{...source,endRow:2},reference:{...source,endRow:3}});
  expect(result.comparableRows).toBe(1);expect(result.comparisonCount).toBe(2);expect(result.comparisonPreview[1].amountDifference).toBeNull();
  const different=await h.call({action:'calculate',source:{...source,endRow:2},reference:{...source,endRow:2,basis:'USD 未税'}});
  expect(different.comparableRows).toBe(0);
  const formulas=fixture();formulas.Sheets['报价'].E2={t:'n',v:999,f:'C2*D2'};h.change(formulas);
  const computed=await h.call({action:'calculate',source:{...source,endRow:2},reference:{...source,endRow:2}});expect(computed.comparableRows).toBe(1);expect(computed.current.total).toBe(6.5);expect(computed.current.issueRows).toBe(1);
 });
 it('preserves backend path denial and cancellation before reading or saving',async()=>{
  const h=host(fixture());h.deny();await expect(h.call({action:'inspect',path:'../outside.xlsx'})).rejects.toThrow('任务目录外');
  const controller=new AbortController();controller.abort();
  await expect(h.tool.execute('cancel',{action:'inspect',path:'quote.xlsx'},controller.signal)).rejects.toThrow();expect(h.files.size).toBe(0);
 });
});
