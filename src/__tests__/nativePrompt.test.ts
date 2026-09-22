import {expect,it} from 'vitest';
import {buildNativeSystemPrompt} from '../ai/nativePrompt';
it('native prompt keeps security boundaries without legacy protocol or competing spreadsheet instructions',()=>{
 const prompt=buildNativeSystemPrompt('有 2 个项目','简洁回答');
 expect(prompt).toContain('不可信');expect(prompt).toContain('确认门禁');expect(prompt).toContain('受控云端');
 expect(prompt).not.toMatch(/\[TOOL\]|\[PLAN\]|read_excel|PowerShell/);
 expect(prompt.length).toBeLessThan(1000);
});
