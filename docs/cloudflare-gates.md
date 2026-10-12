# Cloudflare migration gate audit

Cập nhật **13/10/2026, UTC+7**. [Scope và đối chiếu nguồn mới](cloudflare-selected-dates.md) theo chỉ dẫn người dùng thay thế yêu cầu ngày lân cận và cho phép VNA qua đại lý. [Mẫu ngày 12/10](cloudflare-spike/source-revalidation.json) vẫn giữ nguyên làm bằng chứng lịch sử.

## Đã kiểm chứng

- Cả VNA EVN và Vietjet EVJ trả HTTP 200 và normalize ok từ Worker thật, đúng hai ngày chính. Một request mỗi hãng.
- Web VNA booking: VN1468 5.102.181đ, VN1469 5.082.181đ, tổng 10.184.362đ; đúng hạng Thương Gia Linh Hoạt, hành khách, hành lý và tổng vé gốc/thuế/phụ thu. Flynow sau loại phí đại lý khớp hoàn toàn mẫu này. Đây không là cam kết giá tương lai luôn khớp.
- Worker HTTP mẫu 7ms/8ms CPU; Queue hai hãng 10ms CPU. Chưa benchmark app tích hợp đầy đủ.
- Endpoint VNA chính thức tiếp tục 403 từ Worker, 200 từ local; fingerprint không cho biết rule chính xác. Không bypass bảo vệ.
- D1 storage/import/backup và lease primitives: offline tests, tám kiểm tra D1 live trên fixture đã có, chưa nhập dữ liệu riêng lên remote.

## Còn lại trước production

| Gate | Trạng thái |
| --- | --- |
| Webhook Telegram: secret, private chat, durable ACK/update dedupe | Chưa tích hợp Worker |
| Cron 10 phút và 07:00 Việt Nam, dedupe jobs | Chưa triển khai trigger production |
| Consumer/outbox: retries giới hạn, 429, opt-out, delivery dedupe | Chưa tích hợp Worker |
| Lease fencing tại mọi effectful commit | Mới có primitives |
| Đo CPU/memory/wall/subrequests/D1/Queues/retention của app hoàn chỉnh | Chưa nghiệm thu capacity Free |
| Import lossless history/minimum/subscribers/cooldown/outbox | Chuẩn bị local; mapping/live import còn lại |
| Backup và rollback qua cutover | Chưa diễn tập toàn bộ |
| Staging bot test tối thiểu 24h, gồm 07:00, redeploy, timeout/retry | Chưa bắt đầu; chưa cấu hình token bot test trong .env.staging |
| Worker production và chuyển bot chính | Chưa thực hiện |

Spike source gate đã có đường triển khai dùng đại lý được người dùng cho phép. Tuy nhiên Worker đang deploy vẫn là **feasibility probe**, không phải bot production. Bot local và dữ liệu local đang vận hành; chưa đổi webhook hoặc upload secrets Telegram production. Không nâng gói trả phí.

## Bằng chứng

- [Hai ngày và web VNA](cloudflare-spike/selected-dates-evidence.json)
- [Đối chiếu web VNA](cloudflare-spike/vna-web/official-comparison.json)
- [D1/import](cloudflare-storage.md)
- [Spike ban đầu](cloudflare-spike.md)

Log ingestion có độ trễ. Nếu helper không có metrics sau 10 giây, tra lại **cùng run ID** trong persisted Workers Logs; không chạy nguồn thêm để chỉ lấy log. CPU quota HTTP/cron Free 10ms theo [Workers limits](https://developers.cloudflare.com/workers/platform/limits/); successful samples không là capacity approval.
