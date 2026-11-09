#!/usr/bin/env node
/**
 * 读取小红书笔记管理页数据（只读，不写任何内容）
 *
 * 用法：
 *   node read-stats.mjs [--port 9333] [--json]
 *
 * 输出：笔记列表状态 + 每篇笔记的浏览/评论/点赞/收藏/分享数据
 */
import http from 'node:http';

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const PORT = Number(arg('port', 9333));
const AS_JSON = flag('json');

const httpGet = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
  }).on('error', rej);
});

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0; this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise(res => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[xhs-stats]', ...a);

async function main() {
  let ver;
  try {
    ver = JSON.parse(await httpGet('/json/version'));
  } catch {
    throw new Error(`CDP 端口 ${PORT} 不通。Chrome 需以调试模式启动：
  bash scripts/launch-chrome.sh`);
  }

  const list = JSON.parse(await httpGet('/json/list'));
  let page = list.find(t => t.type === 'page' && t.url.includes('xiaohongshu'));
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;

  let targetId = page?.id;
  if (!targetId) {
    const t = await cdp.send('Target.createTarget', { url: 'https://creator.xiaohongshu.com/new/note-manager' });
    targetId = t.result.targetId;
    await sleep(4000);
  }

  const { result: { sessionId } } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    return r.result?.result?.value;
  };

  await cdp.send('Page.enable', {}, sessionId);
  const cur = await ev('location.href');
  if (!cur.includes('note-manager')) {
    await cdp.send('Page.navigate', { url: 'https://creator.xiaohongshu.com/new/note-manager' }, sessionId);
  }
  await sleep(6000);

  const url = await ev('location.href');
  if (url.includes('/login')) {
    throw new Error('登录态已失效，请在那个 Chrome 窗口里重新扫码');
  }

  // ⚠️ 坑：标签页的 /json/list URL 可能显示为 login（历史状态），
  // 实际登录态要以 DOM 为准（读 body 里有没有用户名/笔记内容）。
  const data = await ev(`(()=>{
    const body=document.body.innerText;
    // Tab 计数
    const tabs={};
    ['全部','已发布','审核中','未通过'].forEach(t=>{
      const m=body.match(new RegExp(t+'\\\\s*(\\\\d+)'));
      if(m) tabs[t]=Number(m[1]);
    });
    // 笔记条目：标题 + 日期 + 尾部数字序列
    const notes=[];
    const dateRe=/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/g;
    let m;
    while((m=dateRe.exec(body))!==null){
      // 向前找标题（日期前最近的一行非导航文本）
      const before=body.slice(0,m.index).split('\\n').filter(s=>s.trim()&&!/^\\d+$/.test(s.trim()));
      const title=before[before.length-1]?.trim()||'';
      if(!title) continue;
      // 向后取 5 个数字（浏览/评论/点赞/收藏/分享，按平台列序）
      const after=body.slice(m.index+m[0].length);
      const nums=(after.match(/^\\s*\\d+\\s*\\n\\s*\\d+\\s*\\n\\s*\\d+\\s*\\n\\s*\\d+\\s*\\n\\s*\\d+/)||[])[0];
      const stats=nums?nums.trim().split(/\\s+/).map(Number):[];
      notes.push({title,date:m[0],stats});
    }
    return JSON.stringify({url:location.href,tabs,notes,raw:body.slice(body.indexOf('收起侧边栏'))});
  })()`);

  const parsed = JSON.parse(data);
  if (AS_JSON) {
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    log('URL:', parsed.url);
    log('Tab 计数:', JSON.stringify(parsed.tabs));
    console.log('');
    for (const n of parsed.notes) {
      console.log(`📌 ${n.title}`);
      console.log(`   发布时间: ${n.date}`);
      const names = ['浏览', '评论', '点赞', '收藏', '分享'];
      const s = n.stats || [];
      console.log(`   数据: ` + names.map((n2, i) => `${n2} ${s[i] ?? '-'}`).join(' · '));
      console.log('');
    }
    if (!parsed.notes.length) {
      console.log('(未解析出笔记条目，原始数据区如下)');
      console.log(parsed.raw?.slice(0, 400));
    }
  }
  process.exit(0);
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
