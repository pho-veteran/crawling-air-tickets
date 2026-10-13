import {writeFile,mkdir} from 'node:fs/promises';
import {secrets,RemoteD1} from './lib/worker-api.mjs';
const chatId=process.argv[2];
if(!/^-[1-9]\d*$/.test(chatId||''))throw new Error('Usage: node scripts/cloudflare-shared-group.mjs <negative group chat ID>');
const s=await secrets(),botId=s.TELEGRAM_BOT_TOKEN.split(':')[0];
async function telegram(method,body){
  const r=await fetch('https://api.telegram.org/bot'+s.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const p=await r.json();if(!p.ok)throw new Error('Telegram '+method+' failed: '+p.error_code);return p.result;
}
const chat=await telegram('getChat',{chat_id:chatId}),member=await telegram('getChatMember',{chat_id:chatId,user_id:Number(botId)});
if(!['group','supergroup'].includes(chat.type)||!['member','administrator','creator'].includes(member.status))throw new Error('Expected group with the bot as a member');
const db=new RemoteD1('aa8be7a3-77e5-4de3-a124-d28b2a056f9d');
const backup={subscribers:(await db.prepare('SELECT * FROM subscribers WHERE bot_id=?').bind(botId).all()).results,
  shared:await db.prepare("SELECT * FROM runtime_state WHERE key='shared-chat'").first()};
await mkdir('data',{recursive:true});await writeFile('data/shared-group-backup-'+Date.now()+'.json',JSON.stringify(backup));
const record=JSON.stringify({active:true,subscribedAt:Date.now(),lastSeenAt:Date.now()});
await db.batch([
  db.prepare("INSERT INTO runtime_state(key,document_json) VALUES('shared-chat',?) ON CONFLICT(key) DO UPDATE SET document_json=excluded.document_json").bind(JSON.stringify({chatId,title:chat.title})),
  db.prepare("UPDATE subscribers SET active=0,record_json=json_set(record_json,'$.active',json('false')) WHERE bot_id=? AND chat_id<>?").bind(botId,chatId),
  db.prepare('INSERT INTO subscribers(bot_id,chat_id,active,record_json) VALUES(?,?,1,?) ON CONFLICT(bot_id,chat_id) DO UPDATE SET active=1,record_json=excluded.record_json').bind(botId,chatId,record),
]);
const commands=[
  {command:'price',description:'Kiểm tra giá mới và giá thấp nhất hai hãng'},
  {command:'flights',description:'Xem giờ bay và giá trong hai ngày chính'},
  {command:'status',description:'Kiểm tra bot và lần cập nhật gần nhất'},
  {command:'help',description:'Hướng dẫn dùng nhóm theo dõi vé'},
];
for(const language_code of ['', 'vi'])await telegram('setMyCommands',{scope:{type:'chat',chat_id:chatId},language_code,commands});
console.log(JSON.stringify({configured:true,title:chat.title,type:chat.type,bot_status:member.status,automatic_destination:'shared group'}));
