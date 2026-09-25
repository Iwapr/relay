import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** ACP subprocess fixture: exercises framing and lifecycle, never calls a model. */
export async function kimiExecutable(directory: string) {
  const path = join(directory, 'kimi-fixture');
  await writeFile(
    path,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const home = process.env.KIMI_CODE_HOME;
const auth = join(home, 'fixture-auth');
if (process.argv[2] === 'login') {
  process.stderr.write('Opening browser for Kimi device login: https://www.kimi.com/device\\n');
  setTimeout(() => process.stderr.write('If the browser did not open, paste the URL above and enter code: TEST-1234\\n'), 20);
  setTimeout(() => { writeFileSync(auth, 'authorized'); process.exit(0); }, 500);
} else if (process.argv[2] === 'web') {
  const token = 'fixture-local-secret';
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token || req.url !== '/api/v1/oauth/usage?provider=managed%3Akimi-code') {
      res.writeHead(403); res.end(); return;
    }
    writeFileSync(join(home, 'fixture-quota-pid'), String(process.pid));
    if (existsSync(join(home, 'fixture-quota-hang'))) return;
    const path = join(home, 'fixture-quota.json');
    const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : existsSync(auth) ? {
      kind:'ok', quota:{usages:{limit5h:{usedRatio:0.25,resetAt:'2099-09-21T10:00:00Z'},monthTotal:{usedRatio:0.4}},
      extraUsage:{balanceCents:1234,totalCents:2000,monthlyChargeLimitEnabled:true,monthlyChargeLimitCents:5000,monthlyUsedCents:766,currency:'CNY'}}
    } : {kind:'error',status:401,message:'No token for kimi-code'};
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({code:0,data}));
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('Kimi server: http://127.0.0.1:' + server.address().port + '/#token=' + token + '\\n');
  });
} else {
  const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
  const result = (id, value = {}) => send({id, result:value});
  const error = id => send({id, error:{code:-32000,message:'fixture auth required'}});
  let active, model = 'kimi-fixture', mode;
  const options = () => [{id:'model',currentValue:model,options:[{value:'kimi-fixture',name:'Kimi Fixture'},{value:'kimi-second',name:'Second'}]},
    {id:'thinking',currentValue:'on',options:[{value:'on',name:'On'},{value:'off',name:'Off'}]}];
  const update = value => send({method:'session/update',params:{sessionId:active.sessionId,update:value}});
  const done = reason => { if (!active) return; result(active.id,{stopReason:reason}); active = null; };
  createInterface({input:process.stdin}).on('line', line => {
    const msg = JSON.parse(line), p = msg.params ?? {};
    appendFileSync(join(home,'requests.jsonl'), JSON.stringify(msg) + '\\n');
    if (msg.id === 'approval' && !msg.method) {
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:msg.result.outcome.optionId ?? 'cancelled'}});
      done('end_turn'); return;
    }
    switch(msg.method) {
      case 'initialize': result(msg.id,{protocolVersion:1,agentCapabilities:{loadSession:true}}); break;
      case 'authenticate': existsSync(auth) ? result(msg.id) : error(msg.id); break;
      case 'session/new': existsSync(auth) ? result(msg.id,{sessionId:'fixture-session',configOptions:options()}) : error(msg.id); break;
      case 'session/load': result(msg.id,{configOptions:options()}); break;
      case 'session/set_config_option': if(p.configId === 'model') model=p.value; result(msg.id,{configOptions:options()}); break;
      case 'session/set_mode': mode=p.modeId; result(msg.id); break;
      case 'session/close': case 'session/delete': result(msg.id); break;
      case 'session/cancel': done('cancelled'); break;
      case 'session/prompt': {
        active = {id:msg.id,sessionId:p.sessionId};
        const text=p.prompt[0].text;
        if(text === 'access-denied') { error(msg.id); active = null; break; }
        if(text === 'crash') { process.exit(12); break; }
        if(text === 'wait') break;
        if(text === 'approve' || text === 'question') {
          const question=text === 'question';
          send({id:'approval',method:'session/request_permission',params:{sessionId:p.sessionId,
            toolCall:{toolCallId:'tool',title:question?'选择方案':'运行命令',rawInput:{command:'echo test'}},
            options:question ? [{optionId:'q0_opt_0',name:'方案一',kind:'allow_once'},{optionId:'q0_skip',name:'Skip',kind:'reject_once'}] :
              [{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
          break;
        }
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好 '}});
        update({sessionUpdate:'tool_call',toolCallId:'tool',title:'Read',status:'pending'});
        update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',content:[{type:'content',content:{type:'text',text:'file contents'}}]});
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Kimi '+mode}});
        done('end_turn'); break;
      }
    }
  });
}
`,
  );
  await chmod(path, 0o700);
  return path;
}
