import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function deepseekExecutable(directory: string) {
  const file = join(directory, 'mock-dsh.cjs');
  await writeFile(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.env.DSH_PERMISSION_MODE !== 'danger-full-access' || !process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.DSH_UNEXPECTED) process.exit(9);
let initialized = false;
const crypto = require('node:crypto');
const send = m => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...m})+'\\n');
const configOptions = [{id:'model',currentValue:'["deepseek-official","deepseek-flash"]',options:[{value:'["deepseek-official","deepseek-flash"]'},{value:'["deepseek-official","deepseek-v4-pro"]'}]}, {id:'reasoning_effort',options:['off','low','high','max'].map(value=>({value}))}];
readline.createInterface({input:process.stdin}).on('close',()=>process.exit(0)).on('line', async line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') { initialized = true; send({id:m.id,result:{protocolVersion:1,agentInfo:{name:'deepseek-harness-acp'}}}); }
 if (m.method === 'session/close') { send({id:m.id,result:{}}); return; }
 if (m.method === 'session/new') { send({id:m.id,result:{sessionId:crypto.randomUUID(),configOptions}}); return; }
 if (m.method === 'session/resume' || m.method === 'session/set_config_option') { send({id:m.id,result:{configOptions}}); return; }
 if (m.method !== 'session/prompt') return;
 if (!initialized) process.exit(10);
 const sessionId = m.params.sessionId;
 const update = u => send({method:'session/update',params:{sessionId,update:u}});
 const text = m.params.prompt[0].text;
 fs.appendFileSync(path.join(process.env.DSH_HOME,'fixture-sessions'),sessionId+'\\n');
 if (text === 'wait') return;
 if (text === 'crash') process.exit(1);
 if (text === 'slow') await new Promise(r=>setTimeout(r,1200));
 update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'read',rawInput:{path:'README.md'}});
 update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',content:[{type:'content',content:{type:'text',text:'fixture read'}}]});
 send({method:'session/update',params:{sessionId:'child',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'child output'}}}});
 update({sessionUpdate:'agent_message_chunk',messageId:'response',content:{type:'text',text:'DeepSeek '+text}});
 if(text==='error') send({id:m.id,error:{code:-32603,message:'QUOTA secret-must-not-leak'}});
 else send({id:m.id,result:{stopReason:'end_turn'}});
});
`,
    { mode: 0o700 },
  );
  return file;
}
export function deepseekApiResponse(url: string, authorization: string) {
  if (!authorization.startsWith('Bearer test-deepseek-')) return new Response('{}', { status: 401 });
  if (url.endsWith('/models'))
    return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
  return Response.json({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' },
    ],
  });
}
