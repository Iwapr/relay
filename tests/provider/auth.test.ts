import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAuthBroker } from '../../packages/provider-codex/src/auth.ts';
import { CodexAdapter } from '../../packages/provider-codex/src/index.ts';
import { redactText } from '../../packages/provider-codex/src/protocol.ts';

function token(id: string, version = 0, expires = Date.now() / 1000 + 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return (
    encode({ alg: 'none' }) +
    '.' +
    encode({
      exp: expires,
      version,
      'https://api.openai.com/auth': { chatgpt_account_id: id, chatgpt_plan_type: 'pro' },
      'https://api.openai.com/profile': { email: id + '@example.test' },
    }) +
    '.invalid'
  );
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-auth-test-'));
  const shared = join(dir, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, 'auth.json'), 'disk credential baseline', { mode: 0o600 });
  const executable = join(dir, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('codex-cli 0.154.0-alpha.6.2'); process.exit(); }
const home=process.env.CODEX_HOME, ephemeral=process.argv.includes('cli_auth_credentials_store="ephemeral"');
let auth=null, pending=null, refreshed=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const account=()=>ephemeral?auth:JSON.parse(readFileSync(home+'/auth.json','utf8')).tokens;
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line), response=result=>send({id:q.id,result});
 if(q.id==='refresh') {
   if(q.error){send({id:pending,error:{code:-1,message:'refresh refused'}});return;}
   auth={access_token:q.result.accessToken,account_id:q.result.chatgptAccountId};refreshed=true;
   send({id:pending,result:{rateLimits:{limitId:'codex',limitName:'Codex',primary:null,secondary:null,credits:null,planType:'pro'},rateLimitsByLimitId:null}});return;
 }
 if(!q.method || q.method==='initialized')return;
 appendFileSync(${JSON.stringify(join(dir, 'calls'))},JSON.stringify({home,method:q.method,ephemeral,accountId:q.params?.chatgptAccountId,refresh:q.params?.refreshToken})+'\\n');
 switch(q.method){
 case 'initialize':response({userAgent:'fixture',codexHome:home,platformFamily:'unix',platformOs:'linux'});break;
 case 'account/read':{
   if(q.params.refreshToken&&!ephemeral){const d=JSON.parse(readFileSync(home+'/auth.json','utf8'));const c=JSON.parse(Buffer.from(d.tokens.access_token.split('.')[1],'base64url'));c.version++;c.exp=Date.now()/1000+3600;d.tokens.access_token=d.tokens.access_token.split('.')[0]+'.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.invalid';writeFileSync(home+'/auth.json',JSON.stringify(d),{mode:0o600});}
   const a=account();response({account:a?{type:'chatgpt',email:a.account_id+'@example.test',planType:'pro'}:null,requiresOpenaiAuth:true});break;}
 case 'account/login/start':if(q.params.type==='chatgptDeviceCode'){response({type:'chatgptDeviceCode',loginId:'login-fixture',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'});send({method:'account/login/completed',params:{loginId:'login-fixture',success:true,error:null}});break;}auth={access_token:q.params.accessToken,account_id:q.params.chatgptAccountId};response({type:'chatgptAuthTokens'});break;
 case 'account/rateLimits/read':pending=q.id;send({id:'refresh',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:auth.account_id}});break;
 default:send({id:q.id,error:{code:-1,message:'unsupported fixture method'}});
 }
});
`,
    { mode: 0o700 },
  );
  const brokers: CodexAuthBroker[] = [];
  const workers: CodexAdapter[] = [];
  async function profile(id: string) {
    const home = join(dir, id);
    await mkdir(home, { mode: 0o700 });
    const file = join(home, 'auth.json');
    const cache = {
      auth_mode: 'chatgpt',
      tokens: { access_token: token(id), account_id: id, refresh_token: 'fixture-only' },
    };
    await writeFile(file, JSON.stringify(cache), { mode: 0o600 });
    const broker = new CodexAuthBroker({ home, executable });
    brokers.push(broker);
    const worker = () => {
      const adapter = new CodexAdapter({ cwd: dir, codexHome: shared, executable, authBroker: broker });
      workers.push(adapter);
      return adapter;
    };
    return { broker, file, cache, worker };
  }
  return {
    dir,
    shared,
    profile,
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(brokers.map((b) => b.close()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('shared-home workers use separate accounts, refresh only the requesting profile and restore after restart', async () => {
  const f = await fixture();
  try {
    const a = await f.profile('A'),
      b = await f.profile('B');
    const beforeB = await readFile(b.file, 'utf8');
    const workerA = a.worker(),
      workerB = b.worker();
    assert.equal((await workerA.getAccount()).identifier, 'A@example.test');
    assert.equal((await workerB.getAccount()).identifier, 'B@example.test');
    assert.equal((await workerA.getQuota())?.stale, false);
    assert.notEqual(
      JSON.parse(await readFile(a.file, 'utf8')).tokens.access_token,
      a.cache.tokens.access_token,
    );
    assert.equal(await readFile(b.file, 'utf8'), beforeB);
    assert.equal((await workerB.getQuota())?.stale, false);
    await workerA.close();
    assert.equal((await a.worker().getQuota())?.stale, false);
    assert.equal(await readFile(join(f.shared, 'auth.json'), 'utf8'), 'disk credential baseline');
    const calls = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const injections = calls.filter((c) => c.method === 'account/login/start');
    assert.deepEqual(
      injections.map((c) => c.accountId),
      ['A', 'B', 'A'],
    );
    assert.ok(injections.every((c) => c.ephemeral && c.home === f.shared));
    assert.ok(calls.filter((c) => c.refresh).every((c) => c.home !== f.shared && !c.ephemeral));
  } finally {
    await f.close();
  }
});

test('credential broker rejects account substitution, public caches, symlinks, and redacts JWTs', async () => {
  const f = await fixture();
  try {
    const a = await f.profile('A');
    await assert.rejects(a.broker.tokens(true, 'B'), /身份已变化/);
    await chmod(a.file, 0o644);
    await assert.rejects(a.broker.tokens(), /授权不可用/);
    await chmod(a.file, 0o600);
    const b = await f.profile('B');
    const other = join(f.dir, 'secret.json');
    await writeFile(other, JSON.stringify(a.cache), { mode: 0o600 });
    await rm(b.file);
    await symlink(other, b.file);
    await assert.rejects(b.broker.tokens(), /授权不可用/);
    assert.equal(redactText(token('A')), '[redacted]');
  } finally {
    await f.close();
  }
});

test('expired authorization exposes a login flow and successful device login restores the profile', async () => {
  const f = await fixture();
  try {
    const a = await f.profile('A');
    const worker = a.worker();
    assert.equal((await worker.getQuota())?.stale, false);
    await chmod(a.file, 0o644);
    await assert.rejects(a.broker.tokens(true, 'A'), /授权不可用/);
    assert.equal((await worker.getAccount()).authenticated, false);
    await chmod(a.file, 0o600);
    const completed = new Promise<void>((resolve) =>
      worker.subscribeEvents((event) => {
        if (event.type === 'account.updated' && event.payload.loginCompleted && event.payload.success)
          resolve();
      }),
    );
    assert.equal((await worker.beginLogin()).loginId, 'login-fixture');
    await completed;
    assert.equal((await worker.getAccount()).authenticated, true);
    assert.equal((await worker.getQuota())?.stale, false);
    const calls = (await readFile(join(f.dir, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((c) => c.method === 'account/login/start' && c.ephemeral).length, 2);
  } finally {
    await f.close();
  }
});
