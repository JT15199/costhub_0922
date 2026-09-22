import { beforeEach, expect, it, vi } from 'vitest';
const db=vi.hoisted(()=>({select:vi.fn(),execute:vi.fn()}));
vi.mock('../db/core',()=>({getDb:async()=>db}));
import { getSupplierResources, saveSupplierProfile } from '../db/suppliers';
beforeEach(()=>{vi.clearAllMocks();db.execute.mockResolvedValue({lastInsertId:10});});
it('merges existing ODM/part/quote names with maintained profiles without duplicates',async()=>{
 db.select.mockResolvedValue([{supplier_name:' A厂 ',source:'整机'},{supplier_name:'A厂',source:'器件'},{supplier_name:'A厂',source:'档案',category:'整机及器件',contact:'张工'},{supplier_name:'B厂',source:'报价'},{supplier_name:' ',source:'器件'}]);
 const rows=await getSupplierResources();expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({supplier_name:'A厂',contact:'张工',sources:['整机','器件','档案']});
});
it('updates profile details without erasing existing logo and address',async()=>{
 db.select.mockResolvedValue([{id:7,supplier_name:' A厂 ',logo:'existing-logo',address:'existing-address',rating:4,phone:'old'}]);
 await saveSupplierProfile({supplier_name:' A厂 ',contact:'新联系人'});
 expect(db.select.mock.calls[0][1]).toEqual(['A厂']);
 const [sql,values]=db.execute.mock.calls[0];expect(sql).toContain('UPDATE supplier_profiles');expect(values[0]).toBe('existing-logo');expect(values[2]).toBe('新联系人');expect(values[3]).toBe('old');expect(values[6]).toBe('existing-address');expect(values.at(-1)).toBe(7);
});
it('rejects blank names before accessing storage',async()=>{await expect(saveSupplierProfile({supplier_name:'  '})).rejects.toThrow('不能为空');expect(db.execute).not.toHaveBeenCalled();});

