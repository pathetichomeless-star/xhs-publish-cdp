#!/usr/bin/env node
/**
 * 小红书图文笔记发布（CDP 直连）
 *
 * 用法：
 *   node publish.mjs --title "标题" --body-file body.txt \
 *     --images a.png,b.png --tags "ChatGPT,AI新手" \
 *     --preview ./preview.png [--publish]
 *
 * 不加 --publish 只填内容并截图（dry-run），推荐先跑这个。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const PORT = Number(arg('port', 9333));
const TITLE = arg('title');
const BODY_FILE = arg('body-file');
const IMAGES = (arg('images', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const TAGS = (arg('tags', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const PREVIEW = arg('preview');
const DO_PUBLISH = flag('publish');

if (!TITLE) { console.error('缺少 --title'); process.exit(2); }
if (!IMAGES.length) { console.error('缺少 --images'); process.exit(2); }
for (const f of IMAGES) {
  if (!fs.existsSync(f)) { console.error(`图片不存在: ${f}`); process.exit(2); }
}
const BODY = BODY_FILE
  ? fs.readFileSync(BODY_FILE, 'utf8').trim()
  : (arg('body', '') || '');

// ---------- CDP ----------
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
const log = (...a) => console.log('[xhs]', ...a);

// ---------- 主流程 ----------
let cdp, sessionId;

async function connect() {
  let ver;
  try {
    ver = JSON.parse(await httpGet('/json/version'));
  } catch (e) {
    throw new Error(
      `无法连接 CDP 端口 ${PORT}。请确认 Chrome 以调试模式启动：\n` +
      `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${PORT} --user-data-dir="~/xhs-cdp-profile"`
    );
  }
  log('Chrome', ver.Browser);

  const list = JSON.parse(await httpGet('/json/list'));
  let page = list.find(t => t.type === 'page' && t.url.includes('xiaohongshu'));

  cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.ready;

  let targetId = page?.id;
  if (!targetId) {
    // 没有就新建一个，靠后续 navigate 打开
    log('未发现小红书标签页，新建一个');
    const t = await cdp.send('Target.createTarget', { url: 'https://creator.xiaohongshu.com/publish/publish' });
    targetId = t.result.targetId;
    await sleep(3000);
  }

  const r = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = r.result.sessionId;
}

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error('JS 执行出错: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};

async function navigateToPublish() {
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: 'https://creator.xiaohongshu.com/publish/publish' }, sessionId);
  await sleep(6000);
  const url = await ev('location.href');
  if (url.includes('/login')) throw new Error('未登录，请先在那个 Chrome 窗口里扫码登录');
  log('已到发布页');
}

async function switchToImage() {
  const r = await ev(`(()=>{
    const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && e.textContent.trim()==='上传图文');
    if(!els.length) return 'not-found';
    els[els.length-1].click();
    return 'ok:'+els.length;
  })()`);
  if (r === 'not-found') throw new Error('找不到「上传图文」入口');
  await sleep(3000);
  log('已切换到图文模式');
}

async function uploadImages() {
  await cdp.send('DOM.enable', {}, sessionId);
  const doc = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' }, sessionId);
  const nodeId = q.result?.nodeId;
  if (!nodeId) throw new Error('找不到 file input');

  const absolute = IMAGES.map(f => path.resolve(f));
  const r = await cdp.send('DOM.setFileInputFiles', { files: absolute, nodeId }, sessionId);
  if (r.error) throw new Error('上传失败: ' + JSON.stringify(r.error));
  await sleep(8000);

  const count = await ev(`document.body.innerText.match(/\\d+\\/18/)?.[0] || 'unknown'`);
  log('图片已上传，页面显示:', count);
  if (count === 'unknown') throw new Error('上传后未见图片计数，可能未成功');
}

async function fillTitle() {
  await ev(`document.querySelector('input[placeholder*="标题"]').focus()`);
  await cdp.send('Input.insertText', { text: TITLE }, sessionId);
  await sleep(800);
  const got = await ev(`document.querySelector('input[placeholder*="标题"]').value`);
  if (got !== TITLE) throw new Error(`标题未填入正确，实际: ${got}`);
  log('标题已填:', got);
}

const pressEnter = async () => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  await sleep(120);
};

async function fillBody() {
  if (!BODY) { log('未提供正文，跳过'); return; }
  await ev(`document.querySelector('[contenteditable=true]').focus()`);
  const paras = BODY.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < paras.length; i++) {
    await cdp.send('Input.insertText', { text: paras[i] }, sessionId);
    await sleep(180);
    if (i < paras.length - 1) await pressEnter();
  }
  await sleep(1000);
  const len = await ev(`document.querySelector('[contenteditable=true]').innerText.length`);
  log(`正文已填，${len} 字，${paras.length} 段`);
}

async function addTags() {
  if (!TAGS.length) return;
  // 光标移到末尾
  await ev(`(()=>{const el=document.querySelector('[contenteditable=true]');el.focus();
    const r=document.createRange();r.selectNodeContents(el);r.collapse(false);
    const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  await pressEnter();

  for (const tag of TAGS) {
    await cdp.send('Input.insertText', { text: ' #' }, sessionId);
    await sleep(450);
    await cdp.send('Input.insertText', { text: tag }, sessionId);
    await sleep(2000);
    await pressEnter();          // 回车选中下拉第一项，勿按方向键
    await sleep(1200);
    const tail = (await ev(`document.querySelector('[contenteditable=true]').innerText`)) || '';
    if (tail.includes('[话题]#')) log(`话题 ✅ ${tag}`);
    else log(`话题 ⚠️ ${tag} 可能未选中，请检查预览`);
  }
}

async function takePreview() {
  if (!PREVIEW) return;
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.resolve(PREVIEW), Buffer.from(r.result.data, 'base64'));
  log('预览已保存:', path.resolve(PREVIEW));
}

async function doPublish() {
  const vp = JSON.parse(await ev('JSON.stringify({w:innerWidth,h:innerHeight})'));
  const cands = [];
  for (const xr of [0.55, 0.5, 0.6, 0.45, 0.65]) {
    for (const yr of [0.92, 0.88, 0.95, 0.85]) {
      cands.push([Math.round(vp.w * xr), Math.round(vp.h * yr)]);
    }
  }
  let hit = null;
  for (const [x, y] of cands) {
    const tag = await ev(`(()=>{const e=document.elementFromPoint(${x},${y});return e?e.tagName:'null';})()`);
    if (tag && tag.includes('PUBLISH')) { hit = [x, y]; break; }
  }
  if (!hit) throw new Error('未找到发布按钮（XHS-PUBLISH-BTN）。请手动截图检查页面底部');

  log('发布按钮坐标:', hit);
  const [X, Y] = hit;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y }, sessionId);
  await sleep(300);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 }, sessionId);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1 }, sessionId);
  log('已点击发布，等待跳转...');

  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const url = await ev('location.href');
    if (url.includes('/publish/success')) {
      log('✅ 发布成功');
      return true;
    }
  }
  const url = await ev('location.href');
  const txt = (await ev('document.body.innerText.slice(0,200)')) || '';
  throw new Error(`未检测到发布成功页。当前 URL: ${url}\n页面片段: ${txt.replace(/\n/g,' | ')}`);
}

// ---------- 执行 ----------
try {
  await connect();
  await navigateToPublish();
  await switchToImage();
  await uploadImages();
  await fillTitle();
  await fillBody();
  await addTags();
  await takePreview();

  if (DO_PUBLISH) {
    await doPublish();
  } else {
    log('dry-run 完成，未发布。确认预览后加 --publish 重新执行');
  }
  process.exit(0);
} catch (e) {
  console.error('\n❌', e.message);
  process.exit(1);
}
