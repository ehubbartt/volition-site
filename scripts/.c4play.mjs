// Verify: (1) first load settles with no animation, (2) a refresh after new claims
// animates only the new ones in order, (3) the replay button walks the whole board,
// (4) hovering a piece names the item.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
const PORT=5199, origin=`http://127.0.0.1:${PORT}`;
const OUT='/home/user/volition-site/preview-shots/connect4';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function cp(){const b=process.env.PLAYWRIGHT_BROWSERS_PATH;if(!b||!existsSync(b))return undefined;for(const d of readdirSync(b).filter(x=>/^chromium-\d+$/.test(x))){const e=join(b,d,'chrome-linux','chrome');if(existsSync(e))return e;}return undefined;}
await mkdir(OUT,{recursive:true});
spawnSync('pkill',['-f',`vite dev --port ${PORT}`]); await sleep(800);
const vite=spawn('npx',['vite','dev','--port',String(PORT),'--strictPort'],{cwd:'/home/user/volition-site',env:{...process.env,PUBLIC_SITE_URL:origin,DEV_LOGIN:'1',NODE_ENV:'development'},stdio:['ignore','pipe','pipe']});
process.on('exit',()=>{try{vite.kill('SIGTERM')}catch{}});
for(let i=0;i<180;i++){try{if((await fetch(`${origin}/health`)).ok)break}catch{}await sleep(500)}
const br=await chromium.launch({executablePath:cp(),args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await br.newPage({viewport:{width:1600,height:1000}});
const cache=new Map();
await p.route('**oldschool.runescape.wiki/**', async route=>{
  const url=route.request().url();
  try{ if(!cache.has(url)){const r=await fetch(url); cache.set(url, r.ok?Buffer.from(await r.arrayBuffer()):null);}
    const b=cache.get(url); if(!b) return route.fulfill({status:404,body:''});
    await route.fulfill({status:200,contentType:'image/png',body:b});
  }catch{ await route.fulfill({status:404,body:''}); }
});
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(`${origin}/auth/dev-login?next=/`,{waitUntil:'domcontentloaded'}); await sleep(1200);

const filled = () => p.locator('.board .hole.filled').count();
const URL_ = `${origin}/admin/connect4/test-connect4`;

// (1) first load — no run, everything on the board
await p.goto(URL_,{waitUntil:'domcontentloaded'}); await sleep(5000);
const base = await filled();
const playingAtStart = await p.locator('.playbar button', {hasText:'Skip'}).count();
console.log(`1) first load: ${base} pieces shown, replay-in-progress=${playingAtStart>0?'yes (BAD)':'no (good)'}`);

// (2) claim three tiles, then refresh and watch only those animate in
for (const col of [1,2,3]) {
  await p.locator('.rail .tile').nth(col).click(); await sleep(400);
  const r = p.waitForResponse(x=>x.url().includes('/admin/connect4/')&&x.request().method()==='POST',{timeout:15000}).catch(()=>null);
  await p.locator('.tile-detail button',{hasText:'Credit'}).first().click();
  await r; await sleep(500);
}
const afterClaims = await filled();
console.log(`2) after 3 manual credits: ${afterClaims} pieces (expected ${base+3})`);

// Wipe only the LAST 3 from the seen list to simulate "someone else claimed these while
// I was away", then reload.
await p.evaluate(() => {
  const k='vs_c4_seen:test-connect4';
  const ids=JSON.parse(localStorage.getItem(k)||'[]');
  localStorage.setItem(k, JSON.stringify(ids.slice(0, Math.max(0, ids.length-3))));
});
const before = await p.evaluate(() => JSON.parse(localStorage.getItem('vs_c4_seen:test-connect4')||'[]').length);
console.log('   seen ids in storage before reload:', before);
await p.goto(URL_,{waitUntil:'domcontentloaded'});
for (const t of [300,600,900,1400]) {
  await sleep(t===300?300:t- (t===600?300:t===900?600:900));
  const st = await p.evaluate(() => ({
    filled: document.querySelectorAll('.board .hole.filled').length,
    bar: document.querySelector('.playbar')?.textContent?.replace(/\s+/g,' ').trim().slice(0,60),
    seen: JSON.parse(localStorage.getItem('vs_c4_seen:test-connect4')||'[]').length
  }));
  console.log(`   t=${t}ms filled=${st.filled} seen=${st.seen} bar="${st.bar}"`);
}
const midRun = await filled();
const runLabel = await p.locator('.playbar .muted').first().textContent().catch(()=>null);
await p.screenshot({path:join(OUT,'replay-catchup.png'), fullPage:false});
console.log(`3) on refresh mid-run: ${midRun} shown (should be < ${afterClaims}), label="${(runLabel||'').trim()}"`);
await sleep(3000);
console.log(`   after the run: ${await filled()} shown (should be ${afterClaims})`);

// (3) replay the whole event
await p.locator('.playbar button',{hasText:'Replay'}).click();
await sleep(700);
const early = await filled();
await p.screenshot({path:join(OUT,'replay-running.png'), fullPage:false});
console.log(`4) replay from empty: ${early} shown shortly after start (should be small)`);
await p.locator('.playbar button',{hasText:'Skip'}).click(); await sleep(600);
console.log(`   after skip: ${await filled()} shown (should be ${afterClaims})`);

// (4) hover a piece
const piece = p.locator('.board .hole.filled').first();
await piece.hover(); await sleep(600);
const card = await p.locator('.hovercard').textContent().catch(()=>null);
console.log('5) hover card:', card ? card.replace(/\s+/g,' ').trim().slice(0,90) : 'NOT SHOWN');
await p.screenshot({path:join(OUT,'hover-card.png'), fullPage:false});
const box = await p.locator('.hovercard').boundingBox().catch(()=>null);
if (box) await p.screenshot({path:join(OUT,'hover-card-crop.png'), clip:{x:Math.max(0,box.x-260),y:Math.max(0,box.y-40),width:660,height:box.height+220}});

console.log(errs.length?('PAGE ERRORS: '+errs.join(' | ')):'no page errors');
await br.close(); vite.kill('SIGTERM'); process.exit(0);
