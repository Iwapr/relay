import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Exercises the real Factory SDK against its documented JSON-RPC CLI protocol. */
export async function factoryFixtureExecutable(root: string) {
  const file = join(root, 'fixture-droid.cjs');
  await writeFile(
    file,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const readline=require('node:readline');
const envelope={jsonrpc:'2.0',factoryApiVersion:'1.0.0',factoryProtocolVersion:'1.201.1'};
const send=x=>process.stdout.write(JSON.stringify({...envelope,...x})+'\\n');
const reply=(m,result)=>send({type:'response',id:m.id,result});
let sessionId,settings,cwd,turn;
const home=process.env.HOME;
if(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || !process.env.FACTORY_API_KEY) process.exit(2);
const notify=notification=>send({type:'notification',method:'droid.session_notification',params:{sessionId,notification}});
const usage={inputTokens:1,outputTokens:2,cacheCreationTokens:0,cacheReadTokens:0,thinkingTokens:0,factoryCredits:12.5};
const finish=(text,reason='completed')=>{
 const id=crypto.randomUUID();
 notify({type:'assistant_text_delta',messageId:id,blockIndex:0,textDelta:'Droid '+text});
 notify({type:'create_message',message:{id,role:'assistant',content:[{type:'text',text:'Droid '+text}],createdAt:Date.now(),updatedAt:Date.now()}});
 notify({type:'agent_turn_completed',reason,turnId:turn,tokenUsage:usage});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(m.type==='response') { finish('approved '+JSON.stringify(m.result)); return; }
 switch(m.method){
 case 'droid.list_models': return reply(m,{models:[{id:'fixture-opus',displayName:'Opus (fixture)',shortDisplayName:'Opus',modelProvider:'anthropic',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'high',noImageSupport:false,isCustom:false}]});
 case 'droid.initialize_session':
  sessionId=crypto.randomUUID();cwd=p.cwd;settings={modelId:p.modelId||'fixture-opus',reasoningEffort:p.reasoningEffort||'high',interactionMode:p.interactionMode,autonomyLevel:p.autonomyLevel};
  fs.writeFileSync(path.join(home,sessionId+'.fixture'),JSON.stringify({cwd,settings}));
  return reply(m,{sessionId,session:{messages:[]},settings});
 case 'droid.load_session':
  sessionId=p.sessionId;({cwd,settings}=JSON.parse(fs.readFileSync(path.join(home,sessionId+'.fixture'))));
  return reply(m,{session:{messages:[]},settings,cwd});
 case 'droid.update_session_settings': settings={...settings,...p}; return reply(m,{});
 case 'droid.add_user_message':
  turn=p.messageId;fs.appendFileSync(path.join(home,'fixture-sessions'),sessionId+'\\n'); reply(m,{});
  const text=p.text||p.content?.find?.(b=>b.type==='text')?.text||'';
  if(text==='wait') return;
  if(text==='approval') return send({type:'request',id:'approval',method:'droid.request_permission',params:{toolUses:[{toolUse:{id:'tool-1',type:'tool_use',name:'Execute',input:{command:'echo hello'}},confirmationType:'exec',details:{type:'exec',fullCommand:'echo hello',command:'echo'}}],options:[{label:'Allow',value:'proceed_once'},{label:'Cancel',value:'cancel'}]}});
  if(text==='question') return send({type:'request',id:'question',method:'droid.ask_user',params:{toolCallId:'ask-1',questions:[{index:4,topic:'Style',question:'Choose style',options:['simple','detailed'],multiSelect:true}]}});
  return setTimeout(()=>finish(text),10);
 case 'droid.interrupt_session': reply(m,{});return finish('cancelled','cancelled');
 case 'droid.close_session': reply(m,{}); return setTimeout(()=>process.exit(0),10);
 default: return reply(m,{});
 }
});
`,
    { mode: 0o700 },
  );
  return file;
}
