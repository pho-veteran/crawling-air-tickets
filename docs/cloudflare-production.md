# Worker production

Bot chính đã hoạt động trên **Workers Free từ 13/10/2026**, không nâng gói trả phí. Người dùng chọn bot chính, bỏ bot staging riêng/24 giờ và thay timeline bằng giá hiện tại + giá thấp nhất.

- [Worker health](https://crawling-air-tickets.thanhvinhlqt2016.workers.dev/health); [bot Telegram](https://t.me/synapse_vinh_notify_test_bot).
- Phiên bản `893cc543-a5f7-47f3-8c2c-256879e27881`.
- D1 `crawling-air-tickets-state`: `aa8be7a3-77e5-4de3-a124-d28b2a056f9d`.
- Queue `crawling-air-tickets-jobs`: batch 1, concurrency 1, tối đa 5 retries.
- Cron `*/10 * * * *` và `0 0 * * *` (07:00 Việt Nam).
- Webhook `/telegram`, secret header, private chat; 2 người đăng ký active.

## Giá hiện tại và mức thấp nhất

`/price` và bản tin sáng hiển thị giá hiện tại, một mức thấp nhất từng ghi nhận cho tổng/đi/về mỗi hãng, và thời điểm cập nhật giá hiện tại. Không còn timeline, mốc hôm qua, phần trăm thay đổi hoặc mức thấp nhất trong cửa sổ 7 ngày. Tổng thấp nhất là tổng đã được báo giá trong cùng một lượt, không cộng hai minima từng chiều ở các lượt khác nhau để tạo tổng giả.

D1 giữ **2 observations hiện tại, 0 price_quotes, 6 price_minima**. Mỗi lượt thay bản hiện tại, chỉ hạ minimum khi có giá thấp hơn. Lỗi toàn bộ giữ bản có giá gần nhất với `last_attempt_failed`, hiển thị “GIÁ CŨ”; partial ghi rõ chiều thiếu. `/flights` đọc các chuyến có báo giá của bản hiện tại trong đúng hai ngày, không lưu lịch sử giờ bay.

Minimum Vietjet Flynow v1 chuyển sang v2 sau khi kiểm tra cùng tuyến/ngày/hành khách/tiền tệ/cơ sở giá đã xác minh: tổng **7.255.962đ**, đi **2.385.181đ**, về **4.870.781đ**. Không lấy giá thấp của ngày lân cận/calendar chưa xác minh thuế; không trộn VNA matrix vào cơ sở Flynow mới.

Log production mới không ghi giá mỗi lượt. Job chờ giữ dữ liệu so sánh tạm thời để retry; khi hoàn thành payload được xóa. Outbox đã gửi bỏ nội dung giá, giữ ACK/id chống lặp. Timestamps của ACK, opt-out, cooldown/retry là trạng thái vận hành, không phải timeline giá. Retention trạng thái vận hành 30 ngày; minimum không bị xóa theo tuổi.

Cảnh báo vẫn so với giá hiện tại trước khi thay và minimum. Baseline chốt trong job trước fetch để retry không tạo giảm giả. Opt-out có thứ tự update ID. Lease owner/epoch/expiry kiểm tra trong mỗi transaction; gửi Telegram renew lease trước request. ACK ngăn lặp khi đã xác nhận thành công; timeout không xác định được Telegram đã nhận hay chưa vẫn có thể gửi lặp khi retry, không cam kết exactly-once.

## Bằng chứng và quota

[Production evidence](cloudflare-spike/production-evidence.json) chỉ chứa số liệu tổng hợp, không có token/chat ID. `/price` và `/flights` đã thử trực tiếp từ Telegram Web và nhận phản hồi Worker; chạy daily lại cùng ngày không gửi trùng bản tin local đã ACK. **100 tests** qua, gồm webhook replay, opt-out ordering, fencing, 429 và current/minimum. Watcher PID 19688 và listener PID 25780 đã kết thúc, không còn lock local; watcher từ chối chạy khi bot có webhook.

Mẫu production trong giờ kiểm tra: HTTP tối đa **7ms CPU**, cron **4ms**, Queue **45ms**, tất cả outcome `ok`; D1 tối đa **45 statements/job**. Lượt `/price` minimal: 39 statements crawl, 23 reply, 18 send. D1 sau compact khoảng **213KB**. Heap thực tế chưa đo được. Webhook cap 64KB, nguồn cap 2MiB, tối đa hai source fetch đồng thời, fan-out tối đa 15 người/job.

HTTP/cron Free có 10ms CPU, isolate 128MB theo [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). Queue consumer mặc định 30 giây CPU theo [Queues limits](https://developers.cloudflare.com/queues/platform/limits/); crawl/format chạy ở consumer, HTTP/cron chỉ ghi job/enqueue. Đây là smoke test ngắn, không phải benchmark tải dài.

Với 2 subscribers, giá ổn định và 144 polls/ngày, một poll dùng 7 jobs: khoảng **3.100 Queue operations/ngày**, gồm daily/retention, trước commands/retry/cảnh báo. Free có 10.000 operations/ngày; message thường dùng 3 operations, retry thêm read theo [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/). Dựa trên mức ghi cao nhất đã đo, poll khoảng 18.500 D1 writes/ngày trước retention/commands/cảnh báo; Free có 100.000 writes và 5 triệu reads/ngày theo [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Đây là dự phóng cho 2 người nhận, không cam kết tải không giới hạn.

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
