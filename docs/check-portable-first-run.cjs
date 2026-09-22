// Isolated real EXE + real WebView2 + real disk SQLite. No mocks and no user database.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/96529/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'CostHub-first-run-'));
 const dir=path.join(root,'中文 # 空格');fs.mkdirSync(dir);
 const exe=path.join(dir,'costhub.exe');fs.copyFileSync(path.resolve('src-tauri/target/release/costhub.exe'),exe);
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 assert(!fs.existsSync(path.join(dir,'costhub.db')));
 let child,browser,page;
 const launch=async()=>{
  child=spawn(exe,[],{cwd:dir,windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview-profile')}});
  const until=Date.now()+60000;let connected=false;
  while(Date.now()<until){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){connected=true;break;}}catch{}await new Promise(r=>setTimeout(r,300));}
  assert(connected,'WebView2 CDP did not become available');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const end=Date.now()+30000;
  while(Date.now()<end){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));if(page)break;await new Promise(r=>setTimeout(r,250));}
  assert(page,'Tauri page missing');
  await page.getByPlaceholder('请输入访问密码').waitFor({timeout:45000});
 };
 const stop=async()=>{await browser?.close().catch(()=>{});if(child?.pid)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}browser=null;page=null;await new Promise(r=>setTimeout(r,500));};
 try{
  await launch();
  await page.getByText('首次使用，默认用户名',{exact:false}).waitFor({timeout:45000});
  assert(fs.statSync(path.join(dir,'costhub.db')).size>0);
  assert.equal(await page.getByPlaceholder('请输入用户名').inputValue(),'admin');
  const query=async(sql,values=[])=>page.evaluate(async({sql,values})=>{const invoke=window.__TAURI_INTERNALS__.invoke;const db=await invoke('get_db_path');return invoke('sql_select',{request:{db,query:sql,values}});},{sql,values});
  const auth=await query("SELECT value FROM settings WHERE key='auth_password_hash'");
  assert.equal(auth[0].value,crypto.createHash('sha256').update('666666').digest('hex'));
  await page.getByPlaceholder('请输入访问密码').fill('666666');await page.locator('.login-btn').click();await page.locator('.login-screen').waitFor({state:'hidden',timeout:20000});
  await page.screenshot({path:path.resolve('docs/portable-first-run-acceptance.png')});
  await stop();
  await launch();
  await page.getByText('首次使用，默认用户名',{exact:false}).waitFor({timeout:45000});
  await page.getByPlaceholder('请输入访问密码').fill('666666');await page.locator('.login-btn').click();await page.locator('.login-screen').waitFor({state:'hidden',timeout:20000});
  const report={ok:true,checkedAt:new Date().toISOString(),directory:dir,exeSha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),checks:['EXE only in empty Unicode/space/# directory','real SQLite file auto-created','admin and SHA-256(666666) initialized','real login succeeds','restart and login succeeds']};
  fs.writeFileSync('docs/portable-first-run-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){if(page)await page.screenshot({path:path.resolve('docs/portable-first-run-failure.png')}).catch(()=>{});throw error;}finally{await stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
