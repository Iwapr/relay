import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Fixture follows the documented agy 1.2.13 NDJSON protocol and observed login TUI. */
export async function geminiExecutable(directory: string) {
  const path = join(directory, 'gemini-fixture');
  await writeFile(
    path,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const home = process.env.HOME, auth = join(home, 'fixture-auth');
if (process.env.GEMINI_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.ANTIGRAVITY_LS_ADDRESS || !process.env.DBUS_SESSION_BUS_ADDRESS.endsWith('/no-session-bus')) process.exit(10);
const args = process.argv.slice(2);
appendFileSync(join(home, 'launches.jsonl'), JSON.stringify(args)+'\\n');
if (args[0] === 'models') {
 if (!existsSync(auth)) { console.error('Error: Please sign in to view available models.'); process.exit(1); }
 console.error('Fetching available models...');
 console.log('gemini-3.1-pro-high  Gemini 3.1 Pro (High)\\ngemini-3.1-pro-low  Gemini 3.1 Pro (Low)\\ngemini-3.8-flash-medium  Gemini 3.8 Flash (Medium)\\nclaude-sonnet-4-6  Claude Sonnet 4.6');
 process.exit(0);
}
if (args[0] === '-p' && args[1] === '/usage') {
 console.log('Gemini Models\\tWeekly Limit Remaining\\t75%\\t2030-01-01T00:00:00Z\\nGemini Models\\tFive Hour Limit Remaining\\t50%\\t2030-01-01T01:00:00Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t0%\\t2030-01-01T00:00:00Z');process.exit(0);
}
if (!args.length) {
 console.log('Select login method:\\n > 1. Google OAuth');
 let selected = false;
 createInterface({input:process.stdin}).on('line', code => {
  if (!selected) {
   selected = true;
   const url = 'https://accounts.google.com/o/oauth2/auth?state=fixture&code_challenge=fixture';
   process.stdout.write('\\x1b]8;;'+url+'\\x07Click here\\x1b]8;;\\x07');
  } else if (code === 'TEST-CODE') { writeFileSync(auth, 'authorized'); }
 });
} else {
 const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
 const native = args.includes('--conversation') ? args[args.indexOf('--conversation')+1] : randomUUID();
 const step = data => send({event:'step_update',step_update:{conversation_id:native,...data}});
 createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line), text=m.message.content;
  appendFileSync(join(home, 'requests.jsonl'), line+'\\n');
  send({event:'init',conversation_id:native,init:{permission_mode:'request-review'}});
  if(text==='wait') { setInterval(()=>{},1000); return; }
  if(text==='slow') { setTimeout(()=>send({event:'result',result:{conversation_id:native,status:'SUCCESS',response:'slow done'}}),1200); return; }
  if(text==='edit')writeFileSync(join(process.cwd(),'gemini-edited.txt'),'changed');
  if(text==='crash')process.exit(1);
  if(text==='malformed') { console.log('invalid json'); return; }
  step({step_index:0,step_type:'agent_response',state:'ACTIVE',text_delta:'Gemini '});
  step({step_index:0,step_type:'agent_response',state:'DONE',text_delta:'hello'});
  step({step_index:1,step_type:'tool',state:text==='denied'?'ACTIVE':'DONE',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'npm test'},output:'tests passed'}});
  if(text==='denied')console.error('Print mode: soft-denying tool confirmation "RunCommand" at step 1');
  send({event:'result',result:{conversation_id:native,status:text==='error'?'ERROR':'SUCCESS',response:'Gemini hello',...(text==='error'?{error:'private token diagnostic'}:{})}});
 });
}
`,
  );
  await chmod(path, 0o700);
  return path;
}
