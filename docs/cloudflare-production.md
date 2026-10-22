# Worker production

Bot chính đã hoạt động trên **Workers Free từ 13/10/2026**, không nâng gói trả phí. Người dùng chọn bot chính, bỏ bot staging riêng/24 giờ và thay timeline bằng giá hiện tại + giá thấp nhất.

- [Worker health](https://crawling-air-tickets.thanhvinhlqt2016.workers.dev/health); [bot Telegram](https://t.me/synapse_vinh_notify_test_bot).
- Phiên bản `b46dcc71-f2c3-479e-9541-067a2df12148` (22/10/2026).
- D1 `crawling-air-tickets-state`: `aa8be7a3-77e5-4de3-a124-d28b2a056f9d`.
- Hai Queue `crawling-air-tickets-jobs` (crawl) và `crawling-air-tickets-delivery` (Telegram): batch 1, concurrency 2, tối đa 5 retries; lease riêng cho mỗi lane.
- Cron `*/10 * * * *` và `0 0 * * *` (07:00 Việt Nam).
- Webhook `/telegram`, secret header; nhận lệnh trong private chat và group được cấu hình. Một group nhận bản tin tự động, các subscriber private cũ đã ngừng nhận tự động.

Ngày 22/10 đã sửa race giữa cron 10 phút và cron 07:00: job gửi bản tin `daily:<ngày Việt Nam>` được lưu độc lập, chờ refresh hoàn thành rồi mới format/gửi. Nếu cron sáng đến khi poll cùng slot đã xong (kể cả cache đã hết hạn), bản tin vẫn được tạo, không crawl trùng hoặc gửi lại bản tin đã ACK. Nếu nguồn lỗi, giữ giá thành công gần nhất, đánh dấu GIÁ CŨ và không hạ minimum bằng dữ liệu lỗi. Thêm mã lỗi nguồn có allowlist vào log, không ghi session/message thô của nhà cung cấp. **128 tests qua**. [Bằng chứng sự cố và khôi phục](cloudflare-spike/daily-recovery-2026-10-22.json).

## Group dùng chung

Group **Theo dõi giá vé SGN–VCL** được tạo ngày 13/10/2026. Mọi thành viên có thể dùng `/price`, `/flights`, `/status`, `/help`; bot bỏ qua hội thoại thường và lệnh gửi cho bot khác. Chỉ group trong `runtime_state['shared-chat'].chatId` được xử lý. `/start` và `/stop` không đổi đăng ký của cả nhóm; mỗi người tự mute hoặc rời nhóm trong Telegram. Private chat vẫn tra cứu được nhưng không đăng ký nhận bản tin riêng khi shared mode bật.

Menu command riêng cho group chỉ gồm các lệnh tra cứu. Bot là thành viên thường, không cần quyền admin. Nếu có thêm bot khác, dùng `/price@synapse_vinh_notify_test_bot` hoặc chọn lệnh từ menu để Telegram định tuyến đúng. Tin migration chính thức từ Telegram cập nhật destination khi basic group được nâng thành supergroup.

Kiểm tra group live ngày 13/10/2026: `/price` và `/flights` đều nhận loading rồi kết quả; bản tin daily thử nghiệm có Telegram ACK trong group. D1 xác nhận một group active và hai subscriber private inactive. **105 tests** qua, thêm kiểm tra shared fanout, chặn bản tin private đã xếp hàng, `/stop` không tắt cả nhóm và migration basic group. Command menu đã đăng ký cho cả ngôn ngữ mặc định và tiếng Việt.

Sau deploy, cấu hình/chuyển destination bằng `node --dns-result-order=ipv4first scripts/cloudflare-shared-group.mjs <negative-chat-id>`. Script xác minh group và membership qua Telegram, backup subscribers/shared state vào ignored `data/shared-group-backup-*.json`, rồi cập nhật D1 trong một batch và đặt command menu. Link mời lấy trong Group Info; không commit link mời riêng tư vào Git. Fanout và bước gửi đều chặn bản tin tự động tới private chat cũ.

`/price` gửi “⏳ Đang kiểm tra giá mới hai hãng, xong mình gửi ngay nhé...”; `/flights` gửi “⏳ Đang kiểm tra giờ bay và giá hai hãng, xong mình gửi ngay nhé...”. Crawl chỉ được tạo sau ACK của tin loading. ACK đã lưu được dùng để phục hồi follow-up khi retry, không gửi lại loading. 429 của loading giữ crawl chờ thay vì lấy giá trước. [Bằng chứng hai lệnh live](cloudflare-spike/loading-evidence.json).

## Giá hiện tại và mức thấp nhất

Từ 21/10/2026, `monitoring.trackingMode` hỗ trợ `outbound` (vé đi), `inbound` (vé về), `roundtrip` (hai chiều; mặc định khi không cấu hình). Production đang chọn **inbound: VCL → SGN ngày 13/02/2027** vì đã mua vé đi. Đổi cờ trong `config.json` rồi deploy lại để chuyển chế độ. Cron, `/price`, `/flights`, daily, cảnh báo và link tìm vé dùng chiều đã chọn; truy vấn một chiều gửi một chặng Leg 0 tới Flynow và ánh xạ kết quả về đúng chiều của hành trình.

Không đổi định danh các chiều giá đã xác minh: minimum vé về cũ vẫn dùng được; giá một chiều không được ghi vào minimum khứ hồi. Cache của chế độ cũ không được dùng cho chế độ mới. Alert chờ của tổng/chiều đã tắt bị loại khi gửi. Live Worker đã crawl một lần thành công cả hai hãng, chỉ lưu legs.inbound; VNA có 1 chuyến, Vietjet có 4 chuyến ở mẫu kiểm tra. **125 tests qua**, gồm ba chế độ, wire Leg 0 cho vé về, giữ minima khi chuyển chế độ và chặn cảnh báo chiều đã tắt. Xem [bằng chứng triển khai](cloudflare-spike/tracking-mode-evidence.json).

`/price` và bản tin sáng hiển thị giá hiện tại, một mức thấp nhất từng ghi nhận cho tổng/đi/về mỗi hãng, và thời điểm cập nhật giá hiện tại. Không còn timeline, mốc hôm qua, phần trăm thay đổi hoặc mức thấp nhất trong cửa sổ 7 ngày. Tổng thấp nhất là tổng đã được báo giá trong cùng một lượt, không cộng hai minima từng chiều ở các lượt khác nhau để tạo tổng giả.

D1 giữ **2 observations hiện tại, 0 price_quotes, 6 price_minima**. Mỗi lượt thay bản hiện tại, chỉ hạ minimum khi có giá thấp hơn. Lỗi toàn bộ giữ bản có giá gần nhất với `last_attempt_failed`, hiển thị “GIÁ CŨ”; partial ghi rõ chiều thiếu. `/flights` đọc các chuyến có báo giá của bản hiện tại trong đúng hai ngày, không lưu lịch sử giờ bay.

Minimum Vietjet Flynow v1 chuyển sang v2 sau khi kiểm tra cùng tuyến/ngày/hành khách/tiền tệ/cơ sở giá đã xác minh: tổng **7.255.962đ**, đi **2.385.181đ**, về **4.870.781đ**. Không lấy giá thấp của ngày lân cận/calendar chưa xác minh thuế; không trộn VNA matrix vào cơ sở Flynow mới.

Log production mới không ghi giá mỗi lượt. Job chờ giữ dữ liệu so sánh tạm thời để retry; khi hoàn thành payload được xóa. Outbox đã gửi bỏ nội dung giá, giữ ACK/id chống lặp. Timestamps của ACK, opt-out, cooldown/retry là trạng thái vận hành, không phải timeline giá. Retention trạng thái vận hành 30 ngày; minimum không bị xóa theo tuổi.

Cảnh báo vẫn so với giá hiện tại trước khi thay và minimum. Baseline chốt trong job trước fetch để retry không tạo giảm giả. Opt-out có thứ tự update ID. Lease owner/epoch/expiry kiểm tra trong mỗi transaction; gửi Telegram renew lease trước request. ACK ngăn lặp khi đã xác nhận thành công; timeout không xác định được Telegram đã nhận hay chưa vẫn có thể gửi lặp khi retry, không cam kết exactly-once.

## Bằng chứng và quota

Bản tối ưu ngày 13/10/2026: **116 tests qua**. Xem [đo delay và dự toán Free](cloudflare-optimization.md) và [số liệu tổng hợp](cloudflare-spike/optimization-evidence.json). Cache dùng chung 30 giây, một refresh đang chạy cho cả cron và slash command; lệnh giống nhau trong cùng chat được gộp. HTTP chỉ nhận/enqueue; loading và trả lời chạy ở consumer. Hai lane dùng lease độc lập; crawl thả lease trước khi thử gửi ngay kết quả để giảm một lần chờ Queue.

Cron vẫn mỗi 10 phút. Hạn mức mặc định **200 yêu cầu được nhận/ngày**, **1.000 update được lưu/ngày**, **60 phần tin cảnh báo/ngày**, reset 00:00 UTC (07:00 Việt Nam). Khi hết hạn mức, lệnh mới bị bỏ qua, cron vẫn chạy. Cache hit vẫn tính một yêu cầu; lệnh đã gộp không tính thêm yêu cầu. Đây là giới hạn chung của bot, không phải mỗi thành viên.

Riêng ngày UTC 13/10/2026, policy tạm giới hạn 60 yêu cầu để dành D1 quota còn lại sau migration/thử nghiệm; ngày UTC tiếp theo tự trở về 200. Không nâng gói. Quota là của toàn account; dự toán không bao gồm lưu lượng vô hạn hoặc ứng dụng khác. Watcher/listener local vẫn dừng.

## Vận hành

```powershell
npm ci
cf auth whoami
npm test
npm run cf:deploy
npm run cf:status
node --dns-result-order=ipv4first scripts/cloudflare-runtime-report.mjs
```

OAuth đã cấu hình; khi cần đăng nhập lại dùng `cf auth login`. Secrets nằm trong ignored `.env.worker.json`, không gửi vào chat/Git. Deploy giữ D1, subscribers và cooldown. `cf` có thể báo Docker Desktop không chạy khi dò công cụ; build/upload Worker đã thành công mà không cần container.

Helper runtime: `--preflight` chỉ dùng destination inactive/rỗng trước import; `--import <backup>` chỉ dùng snapshot đã kiểm checksum vào destination mới; `--pause` giữ webhook để Telegram retry; `--activate` đăng ký commands/webhook; `--inspect` chỉ đọc. Admin API dùng bearer secret, không nhúng token vào URL.

## Backup và rollback

Import trước compact đã đối chiếu **240 observations, 12.885 quotes, 258 minima, 2 subscribers, 4 legacy documents**; import lặp không thêm observation. Cursor Telegram, ACK daily/alerts và cooldown map sang runtime. Compact chỉ chạy khi Worker paused, hết pending jobs và đã lấy lease.

Các backup riêng trong ignored `data/`:

- `cloudflare-import-2026-10-13T01-17-39-726Z-3739acc6-3e06-4250-a9d6-c0945c350e60/`: raw local files, SQLite mirror và manifest verified.
- `worker-pricing-backup-1791855667233.json` + `.manifest.json`: đầy đủ observations, quotes, minima, legacy documents trước compact, gồm dữ liệu sau cutover; SHA-256 verified.
- `worker-cutover-result.json`, `worker-pricing-compact-result.json`: kết quả và đường dẫn backup.

Backup không bị xóa khi compact. Script compact từ chối chạy trên Worker active, khi có pending jobs hoặc không lấy được lease; backup/verify trước mutation. Không import đầy đủ lại vào DB production đã compact.

Rollback về local: pause Worker, đợi job/lease đang chạy kết thúc, xác nhận webhook đúng URL app rồi gọi `deleteWebhook` với `drop_pending_updates:false`, sau đó `npm start` trên dữ liệu local vẫn nguyên vẹn. Không chạy hai nơi cùng lúc. Quay lại Worker: dừng local trước và đối chiếu ACK/subscribers/cooldown mới rồi activate. Helper cutover có rollback tự động nếu import/activation thất bại; test mô phỏng import lỗi xác nhận pause, gỡ đúng webhook, giữ pending updates và restart local trên dữ liệu không đổi. Chưa diễn tập chuyển bot production qua lại đầy đủ trong phiên này.

[Báo cáo nguồn](cloudflare-selected-dates.md) chứa đối chiếu web VNA và giới hạn kết luận 403. Mẫu VNA **10.184.362đ** khớp web tại thời điểm kiểm tra, không bảo đảm tồn chỗ/giá tương lai luôn khớp.
