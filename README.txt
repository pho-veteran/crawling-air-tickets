FLIGHT FARE TRACKER v1.6 — Node.js 24+, không cần npm install
SGN ⇄ VCL • 04–13/02/2027 • 1 người lớn • VNA + Vietjet

CHẠY
npm run preflight       Config, history, tests và Telegram getMe; không gửi/crawl
npm run watch           Crawl 25p, bản tin sáng, slash bot
npm run stop            Dừng watcher an toàn sau lượt đang chạy
npm start               Crawl thường, lưu JSONL, dựng HTML, xét alerts
npm run quick           Crawl nhanh, không gửi alert tự động
npm run report          Dựng report/index.html từ history, không gọi hãng
npm run daily:preview   Dựng data/daily-preview.txt
npm run daily           Bản tin hôm nay + HTML nếu đến giờ và chưa gửi
npm run telegram:listen Chỉ chạy slash bot; không chạy listener thứ hai
npm run telegram:status Kiểm tra cấu hình, không in secrets
npm run telegram:test   Gửi tin thử
npm run telegram:smoke -- --send   Gửi mẫu giá mô phỏng có nhãn
node smoke-commands.mjs --send     Crawl thật; thử 4 lệnh + bản tin/HTML
npm test                Tests offline, không cần credentials

PowerShell: cd C:\Users\thanh\Desktop\workspace\crawling-air-tickets
Nếu npm.ps1 bị chặn, dùng npm.cmd. Có thể chạy node <file>.mjs trực tiếp.
Watch phải còn chạy, máy có mạng/không tắt. Không tự cài service Windows.
Không xóa lock trong data khi PID vẫn chạy. Restart khi đổi config/.env.

TELEGRAM VÀ .env
Copy .env.example thành .env nếu chưa có; giữ file đã điền credentials.
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<token từ BotFather>
TELEGRAM_CHAT_ID=<chat ID số của bạn>
DAILY_REPORT_TIME=07:00
DAILY_REPORT_UTC_OFFSET=+07:00

Mở https://t.me/BotFather, /newbot, đặt tên và username kết thúc bằng bot.
Điền token vào .env, không thêm chữ bot trước token. Mở bot mới, /start.
Khi listener chưa chạy, npm run telegram:chat-id để lấy chat_id điền .env.
BotFather cung cấp token, không cung cấp chat ID. Đừng gửi token vào chat/ZIP.
Chạy preflight, telegram:test rồi watch. Một bot chỉ dùng một listener/webhook.

SLASH TRONG CHAT RIÊNG
/price  Lấy giá mới hai hãng, một bản tin chung + file HTML.
        Ngân sách nguồn 8s, tối đa 5 request tuần tự, không retry.
        Mỗi phút tối đa một lượt quick. Lượt nền đang chạy hoặc vừa check thì
        trả giá đã lưu, ghi rõ lý do/thời điểm. Không chạy hai crawl cùng lúc.
        Nguồn chậm/thiếu/giới hạn thì ghi rõ phần chưa cập nhật. Gửi Telegram
        và HTML còn tùy mạng; không cam kết đủ giá dưới 10s.
/report Tạo và gửi HTML từ history; không gọi giá mới.
/status Kiểm tra Telegram trực tiếp, lịch bản tin, trạng thái nguồn đã lưu.
/help   Hướng dẫn; cũng hỗ trợ /start và /connection.
Chỉ nhận đúng private chat đã cấu hình; long polling, không mở server/port.
Lệnh quá 5 phút bỏ qua. Cursor lưu trước xử lý; nếu tiến trình chết giữa chừng,
gửi lại lệnh. Dữ liệu bot/credentials không xuất hiện trong report HTML.

BẢN TIN VÀ ALERT
Giờ gửi trong .env, mặc định 07:00 UTC+7, timer độc lập vòng crawl.
Bản tin chung + HTML; chỉ giá ngày chính: khứ hồi, đi 04/02, về 13/02,
thay đổi so với mốc cuối trước hôm nay, thấp nhất từng thấy kèm thời điểm.
Không có mốc trước thì không bịa %. Giá lân cận CHỈ trong HTML, không alert.
Watch hẹn từ giờ kế tiếp, không gửi bù bản tin sáng khi khởi động tối.
Máy ngủ qua giờ hẹn: gửi hôm nay khi tỉnh, không gửi dồn ngày cũ.
Dùng snapshot gần nhất, không đợi crawl 90s; lỗi/giá quá pollMinutes+5 phút
ghi GIÁ CŨ. Text và HTML cùng snapshot; retry HTML không gửi lại text đã ACK.
Chu kỳ 25p xét riêng khứ hồi, đi, về NGÀY CHÍNH cho cả hai hãng.
Mỗi sự kiện một tin ngắn; cùng giá vừa giảm vừa lập đáy gộp một tin.
Tăng đơn thuần/không đổi im lặng. Chi tiết trong RULES.txt.

NGUỒN GIÁ
VNA: fare-matrix cho khứ hồi; air-best-price không tripDuration cho giá mua
riêng từng chiều. Gồm thuế theo nguồn; cộng vé riêng có thể khác khứ hồi.
Vietjet: lịch công khai vja-ui.useleadr.com, tham khảo trong 24h, chưa xác định
thuế/phí, không gồm hành lý ký gửi. Không đảm bảo bắt kịp sale ngắn hạn.
Không xếp hạng trực tiếp hai hãng khi cơ sở giá khác nhau. Không tự đặt vé.
Lân cận được lưu từ cùng batch để HTML đủ ma trận, không thêm request alert.
Batch thường 90s: tối đa 5 request cách 18s. 403 nghỉ >=6h; 429/503 nghỉ >=1h
hoặc Retry-After dài hơn. Không retry dồn/bypass challenge.

LƯU TRỮ / TRIỂN KHAI
config.json: tuyến/ngày, hành khách, pollMinutes, thresholds, targetVnd.
data/history.jsonl: nối thêm; report/index.html: dashboard offline.
notification-state/daily-state/bot-state.json: chống lặp/cursor.
http-cooldowns.json: cooldown qua restart. Giữ data khi nâng cấp.
ZIP không chứa .env/trạng thái Telegram/logs/locks.
Dockerfile: Node24, CMD watch.mjs; --env-file .env, mount data/report có quyền
user node. Cron ngoài: run.mjs mỗi 25–30p, daily.mjs lúc 00:00 UTC.
Slash vẫn cần bot.mjs thường trực. Chọn watch HOẶC lịch ngoài.
Fixed UTC offset không tự đổi DST.

SMOKE
Giá giả không ghi history/state thật. smoke-commands dùng giá thật, không
đánh dấu bản tin sáng đã gửi. Mẫu dài kiểm tra Unicode; alert thực tế ngắn.
Telegram nhận tin nhưng mất mạng trước ACK: retry vẫn có thể trùng.
Tài liệu: https://core.telegram.org/bots/api
