import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot} from '../shared/paths.mjs';
const root=projectRoot;
await mkdir(path.join(root,'data'),{recursive:true});
await writeFile(path.join(root,'data','watch.stop'),'stop');
console.log('Đã yêu cầu watcher dừng an toàn. Lượt đang gửi/lấy giá sẽ hoàn tất rồi nhả lock.');
