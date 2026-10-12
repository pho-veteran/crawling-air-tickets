import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {cliPath} from '../shared/paths.mjs';
import {sendTelegram,sendDocument,telegramCall} from './client.mjs';
import {loadContext,makeReport} from '../reporting/context.mjs';
import {formatDaily,when} from '../monitoring/messages.mjs';
export const commandMenu=[{command:'start',description:'Đăng ký hoặc nhận lại cảnh báo và bản tin'},{command:'stop',description:'Ngừng nhận cảnh báo và bản tin tự động'},{command:'price',description:'Xem giá mới của cả hai hãng + HTML'},{command:'report',description:'Gửi biểu đồ và bảng giá đã lưu'},{command:'status',description:'Kiểm tra kết nối và lần cập nhật gần nhất'},{command:'help',description:'Hướng dẫn dùng bot săn vé'}];
export const helpText='👋 Mình đang canh vé cho bạn!\n\n/price — Kiểm tra giá hai hãng ngay, kèm báo cáo HTML. Mình dành tối đa 8 giây gọi nguồn; nếu nguồn chậm, sẽ nói rõ phần chưa cập nhật.\n\n/report — Gửi biểu đồ lịch sử và bảng giá ngày lân cận từ dữ liệu đã lưu, không cần chờ lấy giá mới.\n\n/status — Kiểm tra Telegram, lịch bản tin và lần lấy giá gần nhất.\n\n🔔 Có giá tốt đáng chú ý, mình sẽ chủ động nhắn. Bản tin sáng cũng kèm HTML để bạn xem kỹ hơn nhé!';
export const quickRun=root=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cliPath('run.mjs',root),'--quick','--no-notify'],{cwd:root,stdio:'ignore',windowsHide:true});p.once('error',reject);p.once('exit',code=>resolve(code??1));});
const exists=async file=>{try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export async function handleCommand({root,update,creds,state,save=async()=>{},username='',send=sendTelegram,attach=sendDocument,call=telegramCall,context=loadContext,report=makeReport,quick=quickRun,now=Date.now,busy=()=>exists(path.join(root,'data','run.lock'))}){
  const m=update.message;
  if(m?.chat?.type!=='private'||String(m.chat.id)!==String(creds.chatId))return {status:'ignored'};
  const match=m.text?.trim().match(/^\/(\w+)(?:@(\w+))?(?:\s|$)/);if(!match||match[2]&&match[2].toLowerCase()!==username.toLowerCase())return {status:'ignored'};
  const command=match[1].toLowerCase();
  if(!['price','report','status','connection','help','start','stop'].includes(command)){await send(creds,'🤔 Mình chưa có lệnh này. Gõ /help để xem những gì mình có thể giúp nhé.');return {status:'unknown'};}
  if(command==='stop'){await send(creds,'🔕 Đã ngừng gửi cảnh báo và bản tin tự động cho bạn. Bạn vẫn dùng được /price và /report; gửi /start để nhận lại.');return {status:'unsubscribed'};}
  if(['help','start'].includes(command)){await send(creds,(command==='start'?'🔔 Đã đăng ký nhận cảnh báo giá và bản tin sáng.\n\n':'')+helpText+'\n\n/stop — Ngừng nhận tin tự động. /start — Đăng ký nhận lại.');return {status:'help'};}
  if(command==='status'||command==='connection'){
    const began=now();let connected=false;try{connected=(await call(creds.token,'getMe')).is_bot===true;}catch{}
    const c=await context(root),lines=[connected?'🟢 Kết nối Telegram ổn rồi!':'⚠️ Chưa xác nhận được kết nối Telegram.',connected?'Phản hồi trong '+(now()-began)+' ms.':'Mình sẽ thử lại ở lượt sau.','☀️ Bản tin hằng ngày: '+c.settings.dailyTime+' UTC'+c.settings.dailyUtcOffset+(c.settings.dailyReport?' · kèm HTML.':' · đang tắt.'),''];
    for(const p of c.providers){const last=p.history.at(-1);lines.push((p.id==='vna'?'🟦 ':'🟥 ')+p.name+': '+(!last?'chưa có lần lấy giá nào.':last.status==='error'?'lượt gần nhất chưa lấy được giá ('+when(last.observed_at)+').':'lần lấy giá gần nhất '+when(last.observed_at)+(last.status==='partial'?' · còn thiếu một phần.':'.')));}
    lines.push('\nĐây là trạng thái đã lưu của nguồn vé. Muốn kiểm tra giá mới, gửi /price nhé.');await send(creds,lines.join('\n'));return {status:'status'};
  }
  let note='',elapsed=null,code=null;
  if(command==='price'){
    if(await busy())note='⏳ Mình đang lấy giá ở lượt tự động. Gửi bạn giá đã lưu gần nhất trước nhé; thời gian cập nhật nằm dưới mỗi hãng.';
    else if(now()-(state.lastQuickAt||0)<60000)note='🕒 Mình vừa kiểm tra giá trong phút này. Đây là kết quả đã lưu gần nhất; thử lại sau một phút nếu bạn muốn kiểm tra tiếp nhé.';
    else{state.lastQuickAt=now();await save();const began=now();code=await quick(root);elapsed=now()-began;
      note=code===0?'✅ Vừa kiểm tra xong hai hãng trong '+(elapsed/1000).toFixed(1)+' giây.':code===3?'⏳ Lượt tự động đang chạy. Mình gửi giá đã lưu gần nhất trước nhé.':'⚠️ Lần này chưa cập nhật đủ giá. Mình gửi những giá đã có và ghi rõ thời gian bên dưới nhé.';}
  }
  const c=await context(root);
  if(command==='price')await send(creds,formatDaily({...c,now:now(),pollMinutes:c.settings.pollMinutes,onDemand:true})+'\n\n'+note);
  const file=await report(root,c);await attach(creds,file,command==='report'?'📊 Báo cáo của bạn đây! Biểu đồ và bảng giá từ lịch sử đã lưu; mở HTML để xem nhé.':'📊 Xem kỹ hơn nhé: biểu đồ giá, vé từng chiều và các ngày lân cận trong file HTML này.');
  return {status:command,elapsed_ms:elapsed,crawl_code:code};
}
