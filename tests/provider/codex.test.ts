import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter, normalizeQuota, sandboxPolicy } from '../../packages/provider-codex/src/index.ts';
import { validateSchema } from '../../packages/provider-codex/src/protocol.ts';
import type { ProviderEvent } from '../../packages/provider-core/src/index.ts';

async function fixture(mode = 'normal', taskUmask?: '0022' | '0002', isolated = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-codex-'));
  const executable = join(cwd, 'codex-fixture.mjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)}, cwd=${JSON.stringify(cwd)};
if(process.argv.includes('--version')){console.log('codex-cli 0.154.0-alpha.6.2');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let initialized=false, handshake=false, answers=0, turns=0, currentSandbox=null,currentApproval='on-request';
const thread={id:'session-1',sessionId:'session-1',forkedFromId:null,parentThreadId:null,section:null,sectionEnteredAt:null,projectId:null,historyMode:'legacy',model:'actual-model',reasoningEffort:'medium',recencyAt:null,originator:null,preview:'',ephemeral:false,modelProvider:'openai',createdAt:1,updatedAt:1,status:{type:'idle'},path:null,cwd,cliVersion:'0.154.0-alpha.6.2',source:'appServer',threadSource:null,agentNickname:null,agentRole:null,gitInfo:null,name:null,turns:[]};
const turn={id:'turn-1',items:[],itemsView:'full',status:'inProgress',error:null,startedAt:1,completedAt:null,durationMs:null};
const model={id:'catalog-id',model:'actual-model',upgrade:null,upgradeInfo:null,availabilityNux:null,displayName:'Actual Model',description:'fixture',modelSpecialty:null,multiAgentVersion:null,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Normal'}],defaultReasoningEffort:'medium',inputModalities:mode==='image-input'?['text','image']:['text'],supportsPersonality:false,additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,isDefault:true};
const bucket={limitId:'codex',limitName:null,normalModelSlug:null,individualLimit:null,spendControlReached:null,primary:{usedPercent:37,windowDurationMins:60,resetsAt:2000000000},secondary:null,credits:null,planType:'pro',rateLimitReachedType:null};
const settingsNotification=(overrides={},threadId=thread.id)=>({method:'thread/settings/updated',params:{threadId,threadSettings:{cwd,approvalPolicy:currentApproval,approvalsReviewer:'user',sandboxPolicy:currentSandbox,activePermissionProfile:null,model:'actual-model',modelProvider:'openai',serviceTier:null,effort:'medium',summary:null,collaborationMode:{mode:'default',settings:{model:'actual-model',reasoning_effort:'medium',developer_instructions:null}},personality:null,...overrides}}});
function notifySettings(){
 if(!mode.startsWith('settings-')||mode==='settings-missing'||(mode==='settings-stale'&&turns>1))return;
 if(mode==='settings-other-thread'){send(settingsNotification({},'another-session'));return;}
 if(['settings-invalid','settings-safe-then-invalid','settings-invalid-then-safe','settings-foreign-invalid'].includes(mode)){
  if(mode==='settings-safe-then-invalid'||mode==='settings-foreign-invalid')send(settingsNotification());
  const event=settingsNotification({},mode==='settings-foreign-invalid'?'another-session':thread.id);delete event.params.threadSettings.modelProvider;send(event);
  if(mode==='settings-invalid-then-safe')send(settingsNotification());
  return;
 }
 if(mode==='settings-safe-then-unsafe')send(settingsNotification());
 const overrides=mode.includes('unsafe')?{sandboxPolicy:{type:'dangerFullAccess'}}:mode==='settings-wrong-provider'?{modelProvider:'other'}:mode==='settings-wrong-cwd'?{cwd:'/'}:mode==='settings-wrong-approval'?{approvalPolicy:'never'}:mode==='settings-wrong-reviewer'?{approvalsReviewer:'auto_review'}:{};
 send(settingsNotification(overrides));
 if(mode==='settings-unsafe-then-safe')send(settingsNotification());
}
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='initialized'){initialized=true;return;}
 if(!q.method){answers++;if(mode==='approval'||mode==='input'){send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'completed'}}});}return;}
 const response=result=>send({id:q.id,result});
 if(q.method!=='initialize'&&!initialized){send({id:q.id,error:{code:-1,message:'initialize order violation'}});return;}
 switch(q.method){
 case 'initialize': if(mode==='isolated-home')writeFileSync(cwd+'/environment.json',JSON.stringify({home:process.env.CODEX_HOME,args:process.argv,token:process.env.CODEX_ACCESS_TOKEN}));handshake=true;response({userAgent:'fixture',codexHome:cwd,platformFamily:'unix',platformOs:'linux'});break;
 case 'account/read':response({account:mode==='unauthenticated'?null:mode==='apikey'?{type:'apiKey'}:{type:'chatgpt',email:'fixture@example.test',planType:'pro'},requiresOpenaiAuth:true});break;
 case 'account/login/cancel':response({status:'canceled'});break;
 case 'account/login/start':response({type:'chatgptDeviceCode',loginId:'login-1',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'});break;
 case 'config/read':response({config:{model_provider:mode==='provider'?'custom':null,chatgpt_base_url:mode==='custom-url'?'https://example.invalid/backend-api/':'https://chatgpt.com/backend-api/'},origins:{},layers:null});break;
 case 'model/list':response({data:[model],nextCursor:mode==='pagination'?'same':null});break;
 case 'account/rateLimits/read':if(mode==='quota-fail'){send({id:q.id,error:{code:-1,message:'unavailable'}});}else response({rateLimits:bucket,rateLimitsByLimitId:{codex:bucket}});break;
 case 'thread/start':case 'thread/resume':
  if(q.method==='thread/start'&&q.params.historyMode!=='legacy'){send({id:q.id,error:{code:-32600,message:'thread/start must explicitly request legacy history'}});break;}
  if(mode==='history-mode-ignored'&&q.method==='thread/start')thread.historyMode='paginated';
  if(mode.startsWith('settings-')&&q.method==='thread/resume'){send({id:q.id,error:{code:-32601,message:'list_turns is not supported yet'}});break;}if(mode==='native-busy'&&q.method==='thread/resume'){send({id:q.id,error:{code:-32000,message:'thread session-1 already has an active writer'}});break;}currentSandbox ??= q.params.sandbox==='workspace-write'?{type:'workspaceWrite',writableRoots:[cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false};response({thread,model:'actual-model',modelProvider:'openai',serviceTier:null,cwd,instructionSources:[],approvalPolicy:currentApproval,approvalsReviewer:'user',sandbox:mode==='sandbox'||(mode==='effective-sandbox'&&turns>0)?{type:'dangerFullAccess'}:currentSandbox,reasoningEffort:'medium'});break;
 case 'thread/fork':if(q.params.lastTurnId!=='newer-turn'||q.params.sandbox!=='read-only'||q.params.approvalPolicy!=='on-request'||q.params.approvalsReviewer!=='user'){send({id:q.id,error:{code:-1,message:'unsafe fork parameters'}});break;}response({thread:{...thread,id:'fork-1',forkedFromId:thread.id},model:'actual-model',modelProvider:'openai',serviceTier:null,cwd,instructionSources:[],approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:mode==='fork-unsafe'?{type:'dangerFullAccess'}:{type:'readOnly',networkAccess:false},reasoningEffort:'medium'});break;
 case 'thread/read':response({thread:mode.startsWith('native-status-')&&mode!=='native-status-loaded-interrupted'?{...thread,status:{type:'notLoaded'}}:mode==='native-wrong-workspace'?{...thread,cwd:'/'}:mode==='native-wrong-provider'?{...thread,modelProvider:'other'}:mode==='native-subagent'?{...thread,parentThreadId:'parent'}:thread});break;
 case 'thread/list':if((q.params.cwd!==undefined&&q.params.cwd!==cwd)||!q.params.sourceKinds.includes('vscode')||!q.params.modelProviders.includes('openai')){send({id:q.id,error:{code:-1,message:'unsafe discovery filter'}});break;}response({data:[{...thread,source:'vscode',name:'IDE conversation'},{...thread,id:'wrong-cwd',cwd:'/'},{...thread,id:'wrong-provider',modelProvider:'other'},{...thread,id:'child',parentThreadId:'parent'},{...thread,id:'legacy-child',source:{subAgent:'review'}}],nextCursor:q.params.cursor?null:'next-page'});break;
 case 'thread/turns/list':{const status=mode==='native-status-running'?'inProgress':mode==='native-status-failed'?'failed':['native-status-unknown','native-status-interrupted','native-status-loaded-interrupted'].includes(mode)?'interrupted':'completed';const historyTurn={...turn,id:q.params.cursor?'older-turn':'newer-turn',status,completedAt:mode==='native-status-interrupted'?30:null,items:[{type:'userMessage',id:'user',clientId:null,content:[{type:'text',text:mode==='native-large'?'x'.repeat(300000):'hello',text_elements:[]}]},{type:'agentMessage',id:'answer',text:'Safe answer sk-testsecret',phase:null,memoryCitation:null,delivery:null,questions:mode==='async-question'?[{title:'Which approach?',options:['A','B']}]:null},{type:'reasoning',id:'hidden',summary:['do not expose'],content:['private reasoning']}],startedAt:q.params.cursor?10:20};response({data:mode==='native-large'?Array.from({length:20},(_,i)=>({...historyTurn,id:'large-'+i})): [historyTurn],nextCursor:q.params.cursor?null:'older-page',backwardsCursor:null});break;}
 case 'thread/unsubscribe':currentSandbox=null;response({status:'unsubscribed'});break;
 case 'turn/start':
  if(mode==='image-input')writeFileSync(cwd+'/turn-input.json',JSON.stringify(q.params.input));
  turns++;turn.id='turn-'+turns;if(mode==='timeout'){send({method:'turn/started',params:{threadId:thread.id,turn}});break;}currentSandbox=q.params.sandboxPolicy;currentApproval=mode==='full-wrong-approval'?'on-request':q.params.approvalPolicy;if(mode==='umask')writeFileSync(cwd+'/created.txt','task file');notifySettings();response({turn});send({method:'turn/started',params:{threadId:thread.id,turn}});
  if(mode==='exit'){setTimeout(()=>process.exit(7),20);break;}
  if(mode==='approval'){send({method:'item/commandExecution/requestApproval',id:'approval-1',params:{threadId:thread.id,turnId:turn.id,itemId:'command-1',startedAtMs:1,command:'printf hello',cwd}});break;}
  if(mode==='async-question'){send({method:'item/started',params:{startedAtMs:1,threadId:thread.id,turnId:turn.id,item:{type:'agentMessage',id:'async-question',text:'Choose a path',phase:null,memoryCitation:null,delivery:'async',questions:[{title:'Which approach?',options:['A','B']}]}}});break;}
  if(mode==='input'){send({method:'item/tool/requestUserInput',id:2,params:{threadId:thread.id,turnId:turn.id,itemId:'question-1',isBlocking:true,autoResolutionMs:null,questions:[{id:'choice',header:'Choice',question:'Which one?',isOther:true,isSecret:false,options:[{label:'A',description:'Choice A'}]}]}});break;}
  if(mode==='unknown'){send({method:'unrecognized/execute',id:7,params:{threadId:thread.id}});setTimeout(()=>send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:'message-1',delta:'rejected='+answers}}),20);}
  else send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:'message-1',delta:'你好'}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'completed'}}}),50);break;
 case 'turn/steer':if(q.params.expectedTurnId!==turn.id||!q.params.clientUserMessageId){send({id:q.id,error:{code:-1,message:'bad steer'}});break;}response({turnId:turn.id});send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:'steered-answer',delta:q.params.input[0].text}});break;
 case 'turn/interrupt':response({});send({method:'turn/completed',params:{threadId:thread.id,turn:{...turn,status:'interrupted'}}});break;
 default:send({id:q.id,error:{code:-32601,message:'unsupported fixture request'}});
 }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const adapter = new CodexAdapter({
    cwd,
    executable,
    timeoutMs: mode === 'timeout' ? 200 : 2000,
    taskUmask,
    ...(isolated ? { codexHome: join(cwd, 'separate-home'), credentialStore: 'file' as const } : {}),
  });
  return {
    cwd,
    adapter,
    close: async () => {
      await adapter.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
function nextEvent(adapter: CodexAdapter, type: string): Promise<ProviderEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Missing ${type}`));
    }, 3000);
    const off = adapter.subscribeEvents((event) => {
      if (event.type === type) {
        clearTimeout(timer);
        off();
        resolve(event);
      }
    });
  });
}
const input = (cwd: string) => ({ cwd, model: 'actual-model', permissionMode: 'read-only' as const });

test('generated schemas reject invalid approval and sandbox variants', () => {
  assert.throws(
    () => validateSchema('CommandExecutionRequestApprovalResponse', { decision: 'always' }),
    /protocol mismatch/,
  );
  assert.deepEqual(sandboxPolicy('read-only', '/project'), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(sandboxPolicy('workspace-write', '/project'), {
    type: 'workspaceWrite',
    writableRoots: ['/project'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
});
test('native discovery includes IDE sessions and filters mismatched workspaces, providers and subagents', async () => {
  const f = await fixture();
  try {
    const first = await f.adapter.listNativeSessions();
    assert.equal(first.sessions.length, 1);
    assert.equal(first.sessions[0]?.source, 'vscode');
    assert.equal(first.sessions[0]?.title, 'IDE conversation');
    assert.equal(first.nextCursor, 'next-page');
    assert.equal((await f.adapter.listNativeSessions(first.nextCursor!)).nextCursor, null);
  } finally {
    await f.close();
  }
});
test('native history is chronological and excludes reasoning while redacting credentials', async () => {
  const f = await fixture();
  try {
    const history = await f.adapter.readNativeSession('session-1');
    assert.deepEqual(
      history.turns.map((turn) => turn.id),
      ['older-turn', 'newer-turn'],
    );
    assert.equal(history.turns[0]?.createdAt, '1970-01-01T00:00:10.000Z');
    assert.equal(history.turns[0]?.userText, 'hello');
    assert.equal(history.turns[0]?.messages.length, 1);
    assert.equal(history.turns[0]?.messages[0]?.text, 'Safe answer [redacted]');
    assert.equal(history.truncated, false);
  } finally {
    await f.close();
  }
});
for (const [mode, expected] of [
  ['native-status-unknown', 'unknown'],
  ['native-status-interrupted', 'interrupted'],
  ['native-status-loaded-interrupted', 'interrupted'],
  ['native-status-running', 'running'],
  ['native-status-failed', 'failed'],
  ['native-status-completed', 'completed'],
])
  test(`native history preserves evidence for ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      const history = await f.adapter.readNativeSession('session-1');
      assert.equal(history.turns.length, 2);
      assert.deepEqual(
        history.turns.map((turn) => turn.state),
        [expected, expected],
      );
    } finally {
      await f.close();
    }
  });
test('global discovery preserves original cwd while history stays bound to its project', async () => {
  const f = await fixture('native-wrong-workspace');
  try {
    const page = await f.adapter.listNativeSessions(undefined, 'all');
    assert.deepEqual(
      page.sessions.map((session) => session.id),
      ['session-1', 'wrong-cwd'],
    );
    assert.equal(page.sessions[1]?.cwd, '/');
    const metadata = await f.adapter.readNativeSessionMetadata('session-1');
    assert.equal(metadata.cwd, '/');
    assert.ok(!('turns' in metadata));
    await assert.rejects(f.adapter.readNativeSession('session-1'), /another workspace/);
  } finally {
    await f.close();
  }
});
for (const mode of ['native-wrong-workspace', 'native-wrong-provider', 'native-subagent'])
  test(`native history and resume block ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        f.adapter.readNativeSession('session-1'),
        /another workspace, provider, or a subagent/,
      );
      await assert.rejects(
        f.adapter.resumeSession({ id: 'session-1' }, input(f.cwd)),
        /another workspace, provider, or a subagent/,
      );
    } finally {
      await f.close();
    }
  });
test('native history bounds text and records truncation', async () => {
  const f = await fixture('native-large');
  try {
    const history = await f.adapter.readNativeSession('session-1');
    assert.equal(history.truncated, true);
    assert.ok(history.turns.length <= 100);
    assert.ok(
      history.turns.reduce(
        (sum, turn) =>
          sum + turn.userText.length + turn.messages.reduce((n, message) => n + message.text.length, 0),
        0,
      ) <=
        256 * 1024,
    );
  } finally {
    await f.close();
  }
});
test('a conversation held by another app returns a clear conflict without takeover', async () => {
  const f = await fixture('native-busy');
  try {
    await assert.rejects(f.adapter.resumeSession({ id: 'session-1' }, input(f.cwd)), /正在其他窗口中使用/);
  } finally {
    await f.close();
  }
});
test('release removes local ownership and requires a fresh resume', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    await f.adapter.releaseSession(session.id);
    await assert.rejects(
      f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' }),
      /Resume the owned session/,
    );
    assert.equal((await f.adapter.resumeSession(session, input(f.cwd))).id, session.id);
  } finally {
    await f.close();
  }
});
test('session creation rejects a server that ignores the requested legacy history format', async () => {
  const f = await fixture('history-mode-ignored');
  try {
    await assert.rejects(f.adapter.createSession(input(f.cwd)), { code: 'unsupported_feature' });
    await assert.rejects(
      f.adapter.startRun({ ...input(f.cwd), sessionId: 'session-1', text: 'Must not start' }),
      { code: 'SESSION_NOT_RESUMED' },
    );
  } finally {
    await f.close();
  }
});
test('quota windows retain real variable durations and scope, without invented missing windows', () => {
  const quota = normalizeQuota(
    {
      custom: {
        limitId: 'custom',
        limitName: null,
        normalModelSlug: null,
        individualLimit: null,
        spendControlReached: null,
        primary: { usedPercent: 28, windowDurationMins: 123, resetsAt: null },
        secondary: null,
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
    },
    'now',
  );
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0]?.windowDurationMins, 123);
  assert.equal(quota.windows[0]?.scope, 'custom');
  assert.equal(quota.updatedAt, 'now');
});
test('initialize ordering, model identifier, streaming, completion and native history', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.adapter.getAccount()).authMode, 'chatgpt');
    assert.equal((await f.adapter.listModels())[0]?.id, 'actual-model');
    const session = await f.adapter.createSession(input(f.cwd));
    const delta = nextEvent(f.adapter, 'message.delta'),
      complete = nextEvent(f.adapter, 'run.completed');
    const run = await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    assert.equal(run.turnId, 'turn-1');
    assert.equal((await delta).payload.delta, '你好');
    assert.equal((await complete).payload.state, 'completed');
    assert.ok(await f.adapter.readSession(session.id));
  } finally {
    await f.close();
  }
});
for (const mode of ['apikey', 'provider', 'sandbox', 'custom-url'])
  test(`blocks unsafe ${mode} mode before a turn`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.adapter.createSession(input(f.cwd)), /ChatGPT|provider|sandbox|override/);
    } finally {
      await f.close();
    }
  });
test('model pagination rejects cycles', async () => {
  const f = await fixture('pagination');
  try {
    await assert.rejects(f.adapter.listModels(), /repeated cursor/);
  } finally {
    await f.close();
  }
});
test('quota failure reports stale unknown data instead of fabricated zero', async () => {
  const f = await fixture('quota-fail');
  try {
    const quota = await f.adapter.getQuota();
    assert.equal(quota?.stale, true);
    assert.deepEqual(quota?.windows, []);
    assert.match(quota?.unavailableReason ?? '', /unavailable/);
  } finally {
    await f.close();
  }
});
test('approval waits, rejects old generation and accepts one response', async () => {
  const f = await fixture('approval');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const required = nextEvent(f.adapter, 'interaction.required');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    const event = await required;
    assert.equal(event.payload.kind, 'approval');
    assert.equal(event.payload.command, 'printf hello');
    const answer = {
      requestId: event.payload.requestId as string,
      generation: 'stale',
      decision: 'decline' as const,
    };
    await assert.rejects(f.adapter.answerInteraction(answer), /expired/);
    const completed = nextEvent(f.adapter, 'run.completed');
    await f.adapter.answerInteraction({ ...answer, generation: event.generation });
    await f.adapter.answerInteraction({ ...answer, generation: event.generation });
    assert.equal((await completed).payload.state, 'completed');
  } finally {
    await f.close();
  }
});
test('structured user input maps answers and rejects incomplete answers', async () => {
  const f = await fixture('input');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const required = nextEvent(f.adapter, 'interaction.required');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    const event = await required;
    assert.equal(event.payload.kind, 'input');
    const answer = { requestId: event.payload.requestId as number, generation: event.generation };
    await assert.rejects(f.adapter.answerInteraction({ ...answer, answers: {} }), /each requested/);
    const complete = nextEvent(f.adapter, 'run.completed');
    await f.adapter.answerInteraction({ ...answer, answers: { choice: ['A'] } });
    await complete;
  } finally {
    await f.close();
  }
});
test('unknown execution request fails closed', async () => {
  const f = await fixture('unknown');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const warning = nextEvent(f.adapter, 'provider.warning'),
      delta = nextEvent(f.adapter, 'message.delta');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    assert.match(String((await warning).payload.message), /Unsupported/);
    assert.equal((await delta).payload.delta, 'rejected=1');
  } finally {
    await f.close();
  }
});
test('Codex process exit marks running turn interrupted', async () => {
  const f = await fixture('exit');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const failed = nextEvent(f.adapter, 'run.failed');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    assert.equal((await failed).payload.state, 'interrupted');
  } finally {
    await f.close();
  }
});

test('loaded sessions continue with explicit next-turn sandbox instead of ignored resume overrides', async () => {
  const f = await fixture();
  try {
    const options = { ...input(f.cwd), permissionMode: 'workspace-write' as const };
    const session = await f.adapter.createSession(options);
    let finished = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...options, sessionId: session.id, text: 'first' });
    await finished;
    await f.adapter.resumeSession(session, input(f.cwd));
    finished = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'second' });
    assert.equal((await finished).payload.state, 'completed');
  } finally {
    await f.close();
  }
});
test('effective turn policy widening stops process and reports uncertain', async () => {
  const f = await fixture('effective-sandbox');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const failed = nextEvent(f.adapter, 'run.failed');
    await assert.rejects(
      f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' }),
      /could not be verified/,
    );
    assert.equal((await failed).payload.state, 'uncertain');
  } finally {
    await f.close();
  }
});
for (const mode of ['settings-safe', 'settings-foreign-invalid'])
  test(`fresh verified settings confirm changing turn policies despite unsupported resume: ${mode}`, async () => {
    const f = await fixture(mode);
    const settings: ProviderEvent[] = [];
    const unsubscribe = f.adapter.subscribeEvents((event) => {
      if (event.type === 'run.settings') settings.push(event);
    });
    try {
      const session = await f.adapter.createSession(input(f.cwd));
      for (const permissionMode of ['read-only', 'workspace-write', 'full-access', 'read-only'] as const) {
        const finished = nextEvent(f.adapter, 'run.completed');
        const run = await f.adapter.startRun({
          ...input(f.cwd),
          permissionMode,
          sessionId: session.id,
          text: `Verify ${permissionMode}`,
        });
        assert.equal(run.sessionId, session.id);
        assert.equal((await finished).payload.state, 'completed');
        assert.equal(settings.at(-1)?.payload.permissionMode, permissionMode);
        assert.deepEqual(settings.at(-1)?.payload.sandbox, sandboxPolicy(permissionMode, f.cwd));
      }
    } finally {
      unsubscribe();
      await f.close();
    }
  });
for (const mode of [
  'settings-missing',
  'settings-other-thread',
  'settings-invalid',
  'settings-safe-then-invalid',
  'settings-invalid-then-safe',
  'settings-unsafe',
  'settings-safe-then-unsafe',
  'settings-unsafe-then-safe',
  'settings-wrong-provider',
  'settings-wrong-cwd',
  'settings-wrong-approval',
  'settings-wrong-reviewer',
])
  test(`unverifiable turn policy stops the process for ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      const session = await f.adapter.createSession(input(f.cwd));
      const failed = nextEvent(f.adapter, 'run.failed');
      await assert.rejects(
        f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'Verify safe settings' }),
        { code: 'uncertain_operation' },
      );
      assert.equal((await failed).payload.state, 'uncertain');
      await assert.rejects(f.adapter.getAccount(), /unavailable/);
    } finally {
      await f.close();
    }
  });
test('a previous turn settings notification cannot verify the next turn', async () => {
  const f = await fixture('settings-stale');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const finished = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'First turn' });
    await finished;
    const failed = nextEvent(f.adapter, 'run.failed');
    await assert.rejects(
      f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'Second turn' }),
      { code: 'uncertain_operation' },
    );
    assert.equal((await failed).payload.state, 'uncertain');
    await assert.rejects(f.adapter.getAccount(), /unavailable/);
  } finally {
    await f.close();
  }
});
test('child task umask permits configured group writes without changing Agent umask', async () => {
  const before = process.umask();
  const f = await fixture('umask', '0002');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const done = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    await done;
    assert.equal((await stat(join(f.cwd, 'created.txt'))).mode & 0o777, 0o664);
    assert.equal(process.umask(), before);
  } finally {
    await f.close();
  }
});

test('device login uses official challenge only and reuses one pending login', async () => {
  const f = await fixture('unauthenticated');
  try {
    const [first, second] = await Promise.all([f.adapter.beginLogin(), f.adapter.beginLogin()]);
    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first).sort(), ['loginId', 'userCode', 'verificationUrl']);
    assert.equal(first.userCode, 'TEST-1234');
  } finally {
    await f.close();
  }
});
test('existing login is preserved instead of silently switching accounts', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.adapter.beginLogin(), /already has an account/);
  } finally {
    await f.close();
  }
});
test('cancel is final only after upstream interruption and pending approvals expire', async () => {
  const f = await fixture('approval');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const pending = nextEvent(f.adapter, 'interaction.required');
    const run = await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' });
    const approval = await pending;
    const done = nextEvent(f.adapter, 'run.completed');
    await f.adapter.interruptRun(run);
    assert.equal((await done).payload.state, 'cancelled');
    await assert.rejects(
      f.adapter.answerInteraction({
        requestId: approval.payload.requestId as string,
        generation: approval.generation,
        decision: 'accept',
      }),
      /no longer pending/,
    );
  } finally {
    await f.close();
  }
});

test('unconfirmed turn start stops native process before returning uncertain', async () => {
  const f = await fixture('timeout');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    await assert.rejects(f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'hello' }), {
      code: 'uncertain_operation',
    });
    await assert.rejects(f.adapter.getAccount(), /unavailable/);
  } finally {
    await f.close();
  }
});

test('fork passes an inclusive turn boundary and validates effective sandbox and source workspace', async () => {
  for (const mode of ['normal', 'fork-unsafe', 'native-wrong-workspace']) {
    const f = await fixture(mode);
    try {
      const fork = f.adapter.forkSession('session-1', 'newer-turn', input(f.cwd));
      if (mode === 'normal') assert.equal((await fork).id, 'fork-1');
      else await assert.rejects(fork);
    } finally {
      await f.close();
    }
  }
});

test('full access uses dangerFullAccess with never approvals and can switch back to read-only', async () => {
  const f = await fixture();
  try {
    const full = { ...input(f.cwd), permissionMode: 'full-access' as const };
    const session = await f.adapter.createSession(full);
    let done = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...full, sessionId: session.id, text: 'fixture full access' });
    await done;
    done = nextEvent(f.adapter, 'run.completed');
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: 'fixture read only again' });
    await done;
    assert.deepEqual(sandboxPolicy('full-access', f.cwd), { type: 'dangerFullAccess' });
  } finally {
    await f.close();
  }
  const wrong = await fixture('full-wrong-approval');
  try {
    const session = await wrong.adapter.createSession(input(wrong.cwd));
    await assert.rejects(
      wrong.adapter.startRun({
        ...input(wrong.cwd),
        permissionMode: 'full-access',
        sessionId: session.id,
        text: 'fixture',
      }),
      /policy|uncertain/i,
    );
  } finally {
    await wrong.close();
  }
});

test('asynchronous questions are emitted, retained in native history, and steer the exact running turn', async () => {
  const f = await fixture('async-question');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const question = nextEvent(f.adapter, 'message.completed');
    const ref = await f.adapter.startRun({
      ...input(f.cwd),
      sessionId: session.id,
      text: 'fixture question',
    });
    assert.deepEqual((await question).payload.questions, [{ title: 'Which approach?', options: ['A', 'B'] }]);
    const delta = nextEvent(f.adapter, 'message.delta');
    await f.adapter.steerRun(ref, 'My answer is B', 'client-answer-id');
    assert.equal((await delta).payload.delta, 'My answer is B');
    const history = await f.adapter.readNativeSession(session.id);
    assert.deepEqual(history.turns[0].messages[0].questions, [
      { title: 'Which approach?', options: ['A', 'B'] },
    ]);
    await assert.rejects(f.adapter.steerRun({ ...ref, turnId: 'wrong-turn' }, 'answer', 'another-id'), {
      code: 'run_conflict',
    });
  } finally {
    await f.close();
  }
});

test('takeover impact inspection includes subagents without making them importable or resumable', async () => {
  const f = await fixture('native-subagent');
  try {
    const metadata = await f.adapter.readSessionOwnerMetadata('session-1');
    assert.equal(metadata.id, 'session-1');
    assert.equal(metadata.source, 'subagent');
    await assert.rejects(f.adapter.readNativeSessionMetadata('session-1'), {
      code: 'SESSION_WORKSPACE_MISMATCH',
    });
    await assert.rejects(f.adapter.resumeSession({ id: 'session-1' }, input(f.cwd)), {
      code: 'SESSION_WORKSPACE_MISMATCH',
    });
  } finally {
    await f.close();
  }
});

test('takeover impact metadata still rejects a foreign model provider', async () => {
  const f = await fixture('native-wrong-provider');
  try {
    await assert.rejects(f.adapter.readSessionOwnerMetadata('session-1'), {
      code: 'SESSION_WORKSPACE_MISMATCH',
    });
  } finally {
    await f.close();
  }
});

test('native image inputs reach turn/start as image parts with original detail', async () => {
  const f = await fixture('image-input');
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    const url =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=';
    await f.adapter.startRun({ ...input(f.cwd), sessionId: session.id, text: '查看截图', images: [{ url }] });
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, 'turn-input.json'), 'utf8')), [
      { type: 'text', text: '查看截图', text_elements: [] },
      { type: 'image', url, detail: 'original' },
    ]);
  } finally {
    await f.close();
  }
});

test('images cannot silently fall back to a text-only model', async () => {
  const f = await fixture();
  try {
    const session = await f.adapter.createSession(input(f.cwd));
    await assert.rejects(
      f.adapter.startRun({
        ...input(f.cwd),
        sessionId: session.id,
        text: 'image',
        images: [{ url: 'data:image/png;base64,AAAA' }],
      }),
      { code: 'MODEL_IMAGE_UNSUPPORTED' },
    );
  } finally {
    await f.close();
  }
});

test('account-specific Codex environment and device login cancellation use official protocol', async () => {
  const f = await fixture('isolated-home', undefined, true);
  try {
    await f.adapter.getAccount();
    const environment = JSON.parse(await readFile(join(f.cwd, 'environment.json'), 'utf8'));
    assert.equal(environment.home, join(f.cwd, 'separate-home'));
    assert.ok(environment.args.includes('cli_auth_credentials_store="file"'));
    assert.equal(environment.token, undefined);
  } finally {
    await f.close();
  }
  const login = await fixture('unauthenticated');
  try {
    const first = await login.adapter.beginLogin();
    assert.equal((await login.adapter.beginLogin()).loginId, first.loginId);
    await login.adapter.cancelLogin();
    assert.equal((await login.adapter.beginLogin()).userCode, 'TEST-1234');
  } finally {
    await login.close();
  }
});

test('native history can fetch only recent turns and marks older history as available', async () => {
  const f = await fixture('async-question');
  try {
    const recent = await f.adapter.readNativeSession('session-1', { limit: 1 });
    assert.equal(recent.turns.length, 1);
    assert.equal(recent.turns[0].id, 'newer-turn');
    assert.equal(recent.truncated, true);
    const expanded = await f.adapter.readNativeSession('session-1', { limit: 2 });
    assert.deepEqual(
      expanded.turns.map((turn) => turn.id),
      ['older-turn', 'newer-turn'],
    );
    assert.equal(expanded.truncated, false);
  } finally {
    await f.close();
  }
});
