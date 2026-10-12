import {readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
// Dừng ngay lập tức: kill tiến trình rồi dọn lock, không chờ lượt đang chạy.
const root=projectRoot;
const exec=promisify(execFile);
const pids=new Set();
for(const file of ['watch.lock','bot.lock','run.lock']){
  try{const pid=JSON.parse(await readFile(path.join(root,'data',file),'utf8')).pid;if(Number.isInteger(pid))pids.add(pid);}catch{}
}
if(process.platform==='win32'){
  try{
    const {stdout}=await exec('powershell',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {\"$($_.ProcessId)|$($_.CommandLine)\"}"],{windowsHide:true});
    for(const line of stdout.split('\n')){const cut=line.indexOf('|');if(cut<0)continue;
      if(/src[\\/]cli[\\/](watch|bot|run|daily)\.mjs/.test(line.slice(cut+1)))pids.add(Number(line.slice(0,cut)));}
  }catch{}
}
const killed=[];
for(const pid of pids){
  if(!Number.isInteger(pid))continue;
  try{
    if(process.platform==='win32')await exec('taskkill',['/F','/T','/PID',String(pid)]);
    else process.kill(pid,'SIGKILL');
    killed.push(pid);
  }catch{}
}
for(const file of ['watch.lock','bot.lock','run.lock','watch.stop'])await rm(path.join(root,'data',file),{force:true});
console.log(killed.length?'Đã dừng ngay tiến trình: '+killed.join(', '):'Không thấy tiến trình nào đang chạy.');
