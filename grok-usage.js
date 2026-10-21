// Grok Bot's own weekly allowance. No window observation, token export or token refresh.
// Cursor owns the login refresh; only use it when Grok's active account is identical.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { readAccessToken } = require('./cursor-usage');
const ENDPOINT = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const failure = status => Object.assign(new Error('Grok Bot usage unavailable'), { status });
function accountMatches(token, scope) {
  try {
    const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
    return typeof sub === 'string' && typeof scope === 'string' &&
      crypto.createHash('sha256').update(sub).digest('hex') === scope;
  } catch (_) { return false; }
}
function activeScope() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grokbot/settings.json'), 'utf8')).activeAccountScope; }
  catch (_) { throw failure('missing'); }
}
function grokWindows(data) {
  if (data?.usesPooledEnterpriseAllowance || data?.isTeamSeat) return [];
  const n = data?.usagePercent;
  if (typeof n !== 'number' || !Number.isFinite(n)) return [];
  const reset = typeof data.nextResetTimestampUtc === 'string' ? Date.parse(data.nextResetTimestampUtc) : NaN;
  return [{ label: 'Weekly', usedPercent: Math.min(100, Math.max(0, n)), resetsAt: Number.isFinite(reset) && reset > 0 ? Math.floor(reset / 1000) : null }];
}
function requestUsage(token) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = https.request(ENDPOINT, {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Connect-Protocol-Version':'1','Content-Length':2}}, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(failure([401,403].includes(res.statusCode)?'missing':res.statusCode===429?'rate_limited':'error')); }
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; if(raw.length > 1e6) { reject(failure('error')); req.destroy(); } });
      res.on('error', () => reject(failure('error')));
      res.on('end', () => { try { resolve(grokWindows(JSON.parse(raw))); } catch (_) { reject(failure('error')); } });
    });
    timer=setTimeout(()=>{reject(failure('timeout'));req.destroy();},15000);
    req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(failure('error')));
    // Redirects are rejected; credentials never leave the fixed provider endpoint.
    req.end('{}');
  });
}
async function readGrokUsage({readToken=readAccessToken,readScope=activeScope,request=requestUsage}={}) {
  const token=await readToken(),scope=readScope();
  if(!accountMatches(token,scope))throw failure('account_mismatch');
  const windows=await request(token);
  if(readScope()!==scope)throw failure('account_mismatch');
  return windows;
}
function createGrokPoller({onUsage,onStatus,readUsage=readGrokUsage}) {
  let busy=false;
  return async function pollGrok(){
    if(busy||process.env.GROK_USAGE==='off')return;
    busy=true;
    try { const windows=await readUsage();if(windows.length){onUsage(windows);onStatus('ok');}else onStatus('nodata'); }
    catch(e){onStatus(['missing','account_mismatch','timeout','rate_limited'].includes(e.status)?e.status:'error');}
    finally{busy=false;}
  };
}
module.exports={activeScope,accountMatches,grokWindows,readGrokUsage,createGrokPoller};
