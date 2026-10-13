# Cloudflare migration audit

Cập nhật **13/10/2026, UTC+7**. Bot chính đã chạy trên Workers Free. Người dùng cho phép nguồn đại lý, bỏ bảng 49 ô, yêu cầu `/flights` ở commit riêng, bỏ staging bot riêng/24 giờ và chuyển lưu trữ sang giá hiện tại + một mức thấp nhất.

| Hạng mục | Kết quả |
| --- | --- |
| Nguồn VNA/Vietjet từ Worker | Hai ngày chính, HTTP 200, một request mỗi hãng |
| Giá VNA so với web chính thức | Đúng chuyến/hạng/ngày/1 người lớn; tổng 10.184.362đ, chênh lệch 0đ ở mẫu kiểm tra |
| VNA endpoint chính thức 403 | Local 200/Worker 403; chưa xác định rule cụ thể khi không có log phía VNA |
| Webhook secret/private chat/durable ACK/dedupe | Implemented; tests và `/price`, `/flights` live đã qua |
| Cron 10 phút/07:00 Việt Nam | Hai triggers deployed; cron live ok; daily cùng ngày không gửi trùng ACK cũ |
| Queue/outbox/429/opt-out/retry/fencing | Implemented; tests expiry, replay, opt-out ordering và shared cooldown đã qua |
| Import dữ liệu riêng | Đối chiếu 240 observations, 12.885 quotes, 258 minima, 2 subscribers, 4 legacy documents; import lặp không thêm observation |
| Compact giá | Backup verified; 2 current records, 0 timeline quote rows, 6 minima; commands không tăng số dòng |
| Capacity Free | HTTP ≤7ms, cron ≤4ms, Queue ≤45ms CPU, D1 ≤45 statements/job; giới hạn/dự phóng trong runbook |
| Heap/load/stability dài hạn | Heap chưa đo; không benchmark tải dài hoặc staging 24 giờ; người dùng đã bỏ gate 24 giờ |
| Backup/rollback | Local/remote pricing backup verified, helper rollback khi cutover thất bại; chưa diễn tập chuyển production qua lại toàn bộ |
| Active Worker/dừng local | Worker active, webhook pending 0 ở lần xác nhận; watcher/listener cũ đã kết thúc |

100 tests đã qua. [Runbook](cloudflare-production.md), [production evidence](cloudflare-spike/production-evidence.json), [đối chiếu nguồn](cloudflare-selected-dates.md). Không coi smoke samples là chứng minh ổn định 24 giờ hoặc tải không giới hạn. Không nâng gói trả phí.
