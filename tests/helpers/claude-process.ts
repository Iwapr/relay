import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Official CLI stream-json/control protocol fixture. Never contacts Anthropic. */
export async function claudeExecutable(directory: string) {
  const path = join(directory, 'claude-fixture');
  await writeFile(
    path,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CLAUDE_CONFIG_DIR, auth = join(home,'fixture-auth');
if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL) process.exit(10);
const args=process.argv.slice(2);
appendFileSync(join(home,'launches.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='auth' && args[1]==='status') {
 const loggedIn=existsSync(auth);
 console.log(JSON.stringify({loggedIn,authMethod:loggedIn?'claude.ai':'none',apiProvider:'firstParty',email:loggedIn?'claude@example.test':null,subscriptionType:loggedIn?'max':null}));
 process.exit(loggedIn?0:1);
} else if(args[0]==='auth' && args[1]==='login') {
 if(!args.includes('--claudeai')) process.exit(1);
 console.log("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/oauth/authorize?state=fixture\\nPaste code here if prompted > ");
 createInterface({input:process.stdin}).once('line',code=>{
   if(code!=='TEST-CODE') process.exit(1);
   setTimeout(()=>{writeFileSync(auth,'authorized');process.exit(0);},100);
 });
} else {
 const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
 const result=(id,response={})=>send({type:'control_response',response:{subtype:'success',request_id:id,response}});
 const sessionId=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
 let active=false;
 const finish=()=>{if(active){send({type:'result',session_id:sessionId,subtype:'success',is_error:false});active=false;}};
 createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  appendFileSync(join(home,'requests.jsonl'),JSON.stringify(m)+'\\n');
  if(m.type==='control_response') {
   send({type:'assistant',session_id:sessionId,message:{id:'permission-message',content:[{type:'text',text:JSON.stringify(m.response.response)}]}});finish();return;
  }
  if(m.type==='control_request') {
   if(m.request.subtype==='initialize') result(m.request_id,{models:[{value:'default',displayName:'Claude Fixture',supportedEffortLevels:['low','high']},{value:'sonnet',displayName:'Sonnet'}],account:{tokenSource:existsSync(auth)?'claude.ai':'none'}});
   else if(m.request.subtype==='interrupt'){result(m.request_id);finish();}
   else result(m.request_id);
   return;
  }
  if(m.type!=='user')return;
  active=true;
  const text=m.message.content[0].text;
  if(text==='wait')return;
  if(text==='crash')process.exit(1);
  if(text==='deny'){send({type:'result',session_id:sessionId,subtype:'error_during_execution',is_error:true,errors:['private token diagnostic']});active=false;return;}
  if(text==='approve'||text==='question') {
   send({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:text==='question'?'AskUserQuestion':'Bash',input:text==='question'?{questions:[{question:'选择方案',header:'方案',options:[{label:'方案一',description:'first'}],multiSelect:false}]}:{command:'echo hello'},tool_use_id:'tool-1'}});return;
  }
  send({type:'stream_event',session_id:sessionId,event:{type:'message_start',message:{id:'message-1'}}});
  send({type:'stream_event',session_id:sessionId,event:{type:'content_block_delta',delta:{type:'text_delta',text:'Claude hello'}}});
  send({type:'assistant',session_id:sessionId,message:{id:'message-1',content:[{type:'text',text:'Claude hello'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'README.md'}}]}});
  send({type:'user',session_id:sessionId,message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'file contents'}]}});
  send({type:'assistant',session_id:sessionId,parent_tool_use_id:'agent-task',message:{id:'subagent-message',content:[{type:'text',text:'hidden child response'}]}});
  finish();
 });
}
`,
  );
  await chmod(path, 0o700);
  return path;
}
