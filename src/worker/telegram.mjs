import {messageEntities} from '../monitoring/messages.mjs';
export async function telegram(env,method,body,fetchImpl=fetch){
  let r,p;
  try{r=await fetchImpl('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'manual'});p=await r.json();}
  catch{throw Object.assign(new Error('Telegram transport response uncertain'),{uncertain:true});}
  if(!r.ok||!p.ok)throw Object.assign(new Error('Telegram API failed'),{apiCode:Number(p.error_code)||r.status,retryAfter:Math.min(86400,Math.max(1,Number(p.parameters?.retry_after)||60))});
  return p.result;
}
export const sendMessage=(env,chatId,text,fetchImpl)=>telegram(env,'sendMessage',{
  chat_id:chatId,text,entities:messageEntities(text),link_preview_options:{is_disabled:true}},fetchImpl);
