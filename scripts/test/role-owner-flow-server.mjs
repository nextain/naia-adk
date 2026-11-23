// Model-free owner endpoint. Only temporary fixture processes use this server.
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const [stateFile,audit]=process.argv.slice(2);
const initial=JSON.parse(fs.readFileSync(stateFile,'utf8'));
const root=fs.openSync(initial.thread.path,'r');
const server=http.createServer(),wss=new WebSocketServer({server});
wss.on('connection',socket=>socket.on('message',bytes=>{
  const request=JSON.parse(bytes),state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={};
  else if(request.method==='thread/read')result={thread:{...state.thread,status:{type:state.status}}};
  else if(request.method==='thread/turns/list')result={data:[{id:state.turn,status:'inProgress'}]};
  else if(request.method==='turn/steer'){
    if(request.params.expectedTurnId!==state.turn){socket.send(JSON.stringify({id:request.id,error:{code:-1}}));return;}
    const text=request.params.input[0].text;
    fs.appendFileSync(audit,JSON.stringify({operation:request.method,turn:state.turn,
      sha256:createHash('sha256').update(text).digest('hex')})+'\n');
    if(state.ack)fs.appendFileSync(state.thread.path,JSON.stringify({type:'event_msg',payload:{type:'item_completed',
      thread_id:state.thread.id,turn_id:state.turn,item:{id:'fixture-user',type:'UserMessage',content:text}}})+'\n');
    if(state.dropReply){socket.close();return;}
    result={turnId:state.turn};
  }else throw new Error('unexpected fixture method');
  socket.send(JSON.stringify({id:request.id,result}));
}));
server.listen(initial.socket,()=>console.log('READY'));
process.stdin.resume();
process.stdin.on('end',()=>{
  for(const client of wss.clients)client.terminate();
  wss.close();server.close(()=>fs.closeSync(root));
});
