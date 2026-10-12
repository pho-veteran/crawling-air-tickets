import {spawn} from 'node:child_process';
import {access,readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {cliPath} from '../shared/paths.mjs';
import {sendTelegram,sendDocument,telegramCall} from './client.mjs';
import {recipientState} from './subscribers.mjs';
import {loadContext,makeReport} from '../reporting/context.mjs';
import {formatDaily,nextMorning,routeLine,when} from '../monitoring/messages.mjs';
export const commandMenu=[{command:'start',description:'Đăng ký hoặc nhận lại cảnh báo và bản tin'},{command:'stop',description:'Ngừng nhận cảnh báo và bản tin tự động'},{command:'price',description:'Xem giá mới của cả hai hãng + HTML'},{command:'report',description:'Gửi biểu đồ và bảng giá đã lưu'},{command:'status',description:'Kiểm tra kết nối và lần cập nhật gần nhất'},{command:'help',description:'Hướng dẫn dùng bot săn vé'}];
export const helpText='👋 Mình đang canh vé cho bạn!\n\n/price — Kiểm tra giá mới hai hãng ngay, kèm báo cáo HTML. Mình gọi tất cả nguồn cùng lúc để có giá nhanh nhất; nếu lượt tự động đang chạy, mình chờ xong rồi kiểm tra mới; nếu nguồn lỗi, sẽ nói rõ phần chưa cập nhật.\n\n/report — Gửi biểu đồ lịch sử và bảng giá ngày lân cận từ dữ liệu đã lưu, không cần chờ lấy giá mới.\n\n/status — Kiểm tra kết nối, bản tin và vòng lấy giá tiếp theo, watcher, cấu hình và lần lấy giá gần nhất.\n\n🔔 Có giá tốt đáng chú ý, mình sẽ chủ động nhắn. Bản tin sáng cũng kèm HTML để bạn xem kỹ hơn nhé!';
export const quickRun=root=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cliPath('run.mjs',root),'--quick','--no-notify'],{cwd:root,stdio:'ignore',windowsHide:true});p.once('error',reject);p.once('exit',code=>resolve(code??1));});
const watcherLine=async root=>{
  try{
    const lock=JSON.parse(await readFile(path.join(root,'data','watch.lock'),'utf8'));
    let alive=false;try{process.kill(lock.pid,0);alive=true;}catch(e){alive=e.code==='EPERM';}
    if(alive)return '🛰 Watcher: đang chạy (PID '+lock.pid+(lock.started_at?' · từ '+when(lock.started_at):'')+').';
    return '⚠️ Watcher: còn lock PID '+lock.pid+' nhưng tiến trình không còn chạy (lock cũ).';
  }catch{return '⚠️ Watcher: không thấy tiến trình (chưa chạy `watch`).';}
};
const exists=async file=>{try{await access(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export async function handleCommand({root,update,creds,state,save=async()=>{},username='',send=sendTelegram,attach=sendDocument,call=telegramCall,context=loadContext,report=makeReport,quick=quickRun,now=Date.now,busy=()=>exists(path.join(root,'data','run.lock')),sleep=delay,waitBudgetMs=100000}){
  const m=update.message;
  if(m?.chat?.type!=='private'||String(m.chat.id)!==String(creds.chatId))return {status:'ignored'};
  const match=m.text?.trim().match(/^\/(\w+)(?:@(\w+))?(?:\s|$)/);if(!match||match[2]&&match[2].toLowerCase()!==username.toLowerCase())return {status:'ignored'};
  const command=match[1].toLowerCase();
  if(!['price','report','status','connection','help','start','stop'].includes(command)){await send(creds,'🤔 Mình chưa có lệnh này. Gõ /help để xem những gì mình có thể giúp nhé.');return {status:'unknown'};}
  if(command==='stop'){await send(creds,'🔕 Đã ngừng gửi cảnh báo và bản tin tự động cho bạn. Bạn vẫn dùng được /price và /report; gửi /start để nhận lại.');return {status:'unsubscribed'};}
  if(['help','start'].includes(command)){await send(creds,(command==='start'?'🔔 Đã đăng ký nhận cảnh báo giá và bản tin sáng.\n\n':'')+helpText+'\n\n/stop — Ngừng nhận tin tự động. /start — Đăng ký nhận lại.');return {status:'help'};}
  if(command==='status'||command==='connection'){
    const began=now();let connected=false;try{connected=(await call(creds.token,'getMe')).is_bot===true;}catch{}
    const c=await context(root),s=c.settings;
    const dur=ms=>{ms=Math.max(0,ms);const m=Math.floor(ms/60000);if(m<1)return 'vài giây nữa';if(m<60)return m+' phút nữa';return Math.floor(m/60)+' giờ '+(m%60)+' phút nữa';};
    const lines=[connected?'🟢 Kết nối Telegram ổn rồi!':'⚠️ Chưa xác nhận được kết nối Telegram.',connected?'Phản hồi trong '+(now()-began)+' ms.':'Mình sẽ thử lại ở lượt sau.',
      '☀️ Bản tin hằng ngày: '+s.dailyTime+' UTC'+s.dailyUtcOffset+(s.dailyReport?' · kèm HTML.':' · đang tắt.')];
    if(s.dailyReport)lines.push('📅 Bản tin tiếp theo: '+when(new Date(nextMorning(now(),s)).toISOString())+' (còn '+dur(nextMorning(now(),s)-now())+').');
    const crawling=await busy();
    const lastObs=Math.max(0,...c.providers.flatMap(p=>p.history.map(r=>Date.parse(r.observed_at)||0)));
    if(crawling)lines.push('🔄 Vòng lấy giá: đang chạy...');
    else if(lastObs){const next=lastObs+s.pollMinutes*60000;lines.push('🔄 Vòng lấy giá: mỗi '+s.pollMinutes+' phút · tiếp theo ~'+when(new Date(next).toISOString())+(next>now()?' (còn '+dur(next-now())+')':' (đến giờ chạy)'));}
    else lines.push('🔄 Vòng lấy giá: mỗi '+s.pollMinutes+' phút · chưa có lượt nào.');
    lines.push(await watcherLine(root));
    try{lines.push('👥 Người đăng ký nhận tin: '+(await recipientState(root,creds)).chatIds.length+'.');}catch{}
    lines.push('⚙️ Theo dõi: '+routeLine(c.query)+' · priceOnly '+(s.priceOnly?'bật':'tắt')+' · mục tiêu VNA/Vietjet: '+[s.targetVnd.vna,s.targetVnd.vietjet].map(v=>v===null?'chưa đặt':new Intl.NumberFormat('vi-VN').format(v)+'đ').join('/')+'.');
    lines.push('⚡ Lần /price gần nhất: '+(state.lastQuickAt?when(new Date(state.lastQuickAt).toISOString()):'chưa có')+'.');
    lines.push('');
    for(const p of c.providers){const last=p.history.at(-1);lines.push((p.id==='vna'?'🟦 ':'🟥 ')+p.name+': '+(!last?'chưa có lần lấy giá nào.':last.status==='error'?'lượt gần nhất chưa lấy được giá ('+when(last.observed_at)+').':'lần lấy giá gần nhất '+when(last.observed_at)+(last.status==='partial'?' · còn thiếu một phần.':'.'))+' ('+p.history.length+' snapshot đã lưu)');}
    lines.push('\nĐây là trạng thái đã lưu của nguồn vé. Muốn kiểm tra giá mới, gửi /price nhé.');await send(creds,lines.join('\n'));return {status:'status'};
  }
  let note='',elapsed=null,code=null;
  if(command==='price'){
    // /price luôn lấy giá mới nhất: chờ lượt tự động nhả lock rồi chạy quick mới.
    // Chỉ dùng giá đã lưu khi lượt nền kẹt quá lâu (mặc định ~100s) hoặc quick va phải lock.
    if(await busy()){
      await send(creds,'⏳ Lượt tự động đang chạy, mình chờ xong rồi kiểm tra giá mới cho bạn nhé...');
      const maxWaits=Math.max(0,Math.floor(waitBudgetMs/1000));
      for(let waited=0;await busy();waited++){
        if(waited>=maxWaits)break;
        await sleep(1000);
      }
    }
    if(await busy())note='⏳ Lượt tự động chạy khá lâu. Mình gửi giá đã lưu gần nhất trước nhé; thời gian cập nhật nằm dưới mỗi hãng.';
    else{state.lastQuickAt=now();await save();
      await send(creds,'⏳ Đang kiểm tra giá mới hai hãng, xong mình gửi ngay nhé...');
      const began=now();code=await quick(root);elapsed=now()-began;
      note=code===0?'✅ Vừa kiểm tra xong hai hãng trong '+(elapsed/1000).toFixed(1)+' giây.':code===3?'⏳ Lượt tự động vừa bắt đầu. Mình gửi giá đã lưu gần nhất trước nhé.':'⚠️ Lần này chưa cập nhật đủ giá. Mình gửi những giá đã có và ghi rõ thời gian bên dưới nhé.';}
  }
  const c=await context(root);
  if(command==='price')await send(creds,formatDaily({...c,now:now(),pollMinutes:c.settings.pollMinutes,onDemand:true})+'\n\n'+note);
  const file=await report(root,c);await attach(creds,file,command==='report'?'📊 Báo cáo của bạn đây! Biểu đồ và bảng giá từ lịch sử đã lưu; mở HTML để xem nhé.':'📊 Xem kỹ hơn nhé: biểu đồ giá, vé từng chiều và các ngày lân cận trong file HTML này.');
  return {status:command,elapsed_ms:elapsed,crawl_code:code};
}
