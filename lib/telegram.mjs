import {loadEnvFile} from 'node:process';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {messageEntities} from './messages.mjs';
import {readFile,stat} from 'node:fs/promises';

export function loadEnv(root){
  try{loadEnvFile(path.join(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw new Error('Không đọc được .env; kiểm tra định dạng.');}
}
export function credentials(root) {
  loadEnv(root);
  const token=process.env.TELEGRAM_BOT_TOKEN?.trim(),chatId=process.env.TELEGRAM_CHAT_ID?.trim();
  return {token,chatId,enabled:process.env.TELEGRAM_ENABLED!=='false',configured:!!(token&&chatId)};
}
export async function telegramCall(token,method,body={},fetchImpl=fetch) {
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token||''))throw new Error('TELEGRAM_TOKEN_INVALID: kiểm tra token trong .env.');
  if(!['sendMessage','sendDocument','getMe','getUpdates','setMyCommands'].includes(method))throw new Error('Telegram method không được hỗ trợ.');
  let response,data;
  try {
    const multipart=body instanceof FormData;
    response=await fetchImpl('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',
      ...multipart?{body}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},signal:AbortSignal.timeout(method==='sendDocument'?60000:20000),redirect:'error'});
    data=await response.json();
  }catch{throw new Error('TELEGRAM_NETWORK: chưa xác nhận gửi thành công; sẽ thử lại sau.');}
  if(!response.ok||data.ok!==true){const error=new Error('TELEGRAM_HTTP_'+response.status+' (API '+(Number(data.error_code)||'unknown')+').');
    error.retryAfter=Math.max(0,Math.min(86400,Number(data.parameters?.retry_after)||0));throw error;}
  return data.result;
}
export async function sendDocument(creds,file,caption='📎 Báo cáo giá vé · HTML mở offline',fetchImpl=fetch){
  if(!creds.configured||!creds.enabled)throw new Error('Telegram chưa được cấu hình/bật.');
  const info=await stat(file);if(info.size>40*1024*1024)throw new Error('REPORT_TOO_LARGE: HTML vượt 40 MiB.');
  const form=new FormData();form.set('chat_id',creds.chatId);form.set('caption',caption);form.set('caption_entities',JSON.stringify(messageEntities(caption)));
  form.set('document',new Blob([await readFile(file)],{type:'text/html'}),'flight-fare-report.html');
  const result=await telegramCall(creds.token,'sendDocument',form,fetchImpl);
  if(!Number.isSafeInteger(result?.message_id))throw new Error('TELEGRAM_RESPONSE: thiếu xác nhận document.');return result.message_id;
}
export function messageParts(text){
  const parts=[];let rest=text;
  while(rest.length>3500){let cut=rest.lastIndexOf('\n',3500);if(cut<1750)cut=3500;else cut++;
    if(/[\uD800-\uDBFF]/.test(rest[cut-1]))cut--;parts.push(rest.slice(0,cut));rest=rest.slice(cut);}
  if(rest)parts.push(rest);return parts;
}
export async function sendTelegram(creds,text,fetchImpl=fetch) {
  if(!creds.configured||!creds.enabled)throw new Error('Telegram chưa được cấu hình/bật.');
  let messageId;
  for(const part of messageParts(text)){
  if(messageId!==undefined)await delay(1100);
  const result=await telegramCall(creds.token,'sendMessage',{chat_id:creds.chatId,text:part,entities:messageEntities(part),
    link_preview_options:{is_disabled:true},disable_notification:false},fetchImpl);
  if(!Number.isSafeInteger(result?.message_id))throw new Error('TELEGRAM_RESPONSE: thiếu xác nhận message_id.');
  messageId=result.message_id;
  }
  if(messageId===undefined)throw new Error('TELEGRAM_RESPONSE: nội dung trống.');
  return messageId;
}
