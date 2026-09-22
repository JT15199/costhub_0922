import { WebSocket } from 'ws';

const port = Number(process.argv[2] || 9244);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(item => item.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
ws.on('message', raw => {
  const message = JSON.parse(raw.toString());
  if (message.id !== 1) return;
  console.log(message.result?.result?.value || message.result?.result?.description || JSON.stringify(message));
  ws.close();
});
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    returnByValue: true,
    expression: `JSON.stringify({
      text: document.body.innerText.slice(-5000),
      buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.innerText, aria: button.getAttribute('aria-label'), title: button.title, className: String(button.className) })).slice(-35),
      inputs: [...document.querySelectorAll('input')].map(input => ({ type: input.type, placeholder: input.placeholder, aria: input.getAttribute('aria-label') })),
      composer: document.querySelector('.local-ai-composer')?.outerHTML.slice(0, 5000),
      modelSelect: document.querySelector('[aria-label="选择本地模型"]')?.closest('.ant-select')?.outerHTML.slice(0, 4000),
      modelOptions: [...document.querySelectorAll('.ant-select-item-option')].map(item => item.innerText),
    })`,
  },
}));
setTimeout(() => process.exit(1), 5000);
