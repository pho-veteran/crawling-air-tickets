# Tối ưu Worker Free — 13/10/2026

## Cập nhật nguồn đại lý ngày 22/10/2026

BestPrice và ABAY được crawl bằng GitHub Actions trên runner Ubuntu tiêu chuẩn của repo public, mỗi 10 phút. Worker chỉ xác thực/kiểm tra feed và dùng báo giá hiện tại; không tiêu thụ Browser Run, không có watcher local. Mỗi slot có tối đa một refresh do feed ngoài cron, tức tối đa 144 refresh nền bổ sung/ngày; refresh trùng đang chạy vẫn được gộp.

Với cùng giới hạn 200 commands và 60 alert parts/ngày, dự toán cập nhật làm tròn lên **8.500 Queue operations/ngày** và **90.000 D1 rows written/ngày**, dưới mức Free 10.000/100.000. Phần tăng so với bảng gốc bên dưới dành cho 144 lượt nhận feed và refresh/broadcast: mẫu đo 36 writes/refresh + 15/broadcast, cùng intake. Queue bổ sung khoảng 864 operations cơ sở/ngày, cộng dự phòng. Đây là ngân sách có giả định tải/retry như bản gốc, không phải giới hạn cứng cho mọi lỗi kéo dài hay ứng dụng khác trong account.

**137 tests qua**. Lượt runner thực lấy cả hai nguồn bằng 8 requests trong 6,428 giây, feed nhận HTTP 202. Đo từ webhook nhận lệnh tới ACK: `/price` loading **4,281 giây**, hoàn tất **9,357 giây**; `/flights` loading **8,705 giây**, hoàn tất **33,561 giây**. Queue và nguồn Vietjet vẫn gây dao động; đây không phải SLA. [Bằng chứng](cloudflare-spike/vna-agency-deployment-2026-10-22.json).

GitHub miễn phí standard hosted runners cho repo public theo [chính sách Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions). [Schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) có thể bị trễ và tự tắt sau 60 ngày repo public không hoạt động. Feed quá 15 phút bị từ chối và bot ghi GIÁ CŨ; kiểm tra tab Actions khi gặp tình trạng này. Không bật gói trả phí.

## Cách chạy

- Cache kết quả thành công 30 giây. /price và /flights dùng cùng bản giá; chỉ một refresh pending/running trên toàn bot. Cron có thể nhập vào refresh đó.
- Gộp cùng command/chat khi đang chờ hoặc trong 30 giây. Một lượt nhóm chỉ có một loading và một kết quả; không crawl lại theo từng người.
- Hai Queue, hai lease riêng cho crawl và delivery. Gửi kết quả ngay khi có thể, với outbox/ACK bền vững; Queue phục hồi khi gửi bị trì hoãn. Thả crawl lease trước khi gửi Telegram.
- Cron vẫn 10 phút, 144 lượt/ngày; daily 07:00 Việt Nam. Chỉ giữ bản giá hiện tại và minima; số bản sau đổi nguồn được ghi trong tài liệu production.
- Webhook có secret, giới hạn body 64KB và enqueue sau khi lưu D1. Loading chạy ở consumer để tránh tăng CPU HTTP. Loading chưa tức thì: Queue và Telegram vẫn có độ trễ.

## Ngân sách mỗi ngày

Giới hạn chung: 200 yêu cầu mới được nhận (gồm các slash command), 1.000 update được lưu để chống lặp và 60 phần tin cảnh báo. Lệnh gộp không tạo thêm yêu cầu. Reset 00:00 UTC = 07:00 Việt Nam. Khi hết ngân sách, bỏ qua lệnh mới; cron tiếp tục. Cache hit cũng tính yêu cầu. Giới hạn này không phải quota riêng mỗi thành viên.

| Tài nguyên | Dự toán bảo thủ | Free |
| --- | ---: | ---: |
| Queue operations | 7.200/ngày, đã dự phòng 20% | 10.000/ngày |
| D1 rows written | 78.000/ngày, đã dự phòng 20% | 100.000/ngày |
| D1 rows read | Theo dõi riêng; snapshot account khoảng 213 nghìn | 5 triệu/ngày |
| Worker requests | Snapshot account 942 lượt, 0 lỗi | 100.000/ngày |

Phép tính Queue: dành 3.000 operations cho cron/daily/retention/alerts, cộng 200 × 15 cho commands, nhân 1,2. Một refresh ổn định chỉ cần refresh+broadcast, khoảng 864 operations/ngày cho cron; dư ngân sách cho gửi cảnh báo và phục hồi. Gửi inline thường giảm số message thực tế. Message dưới 64KB tính ba operations (write/read/delete); retry thêm read.

Phép tính D1: dành 25.000 writes cho công việc nền, cộng 200 × 200 cho requests, nhân 1,2. Metadata đo được ở consumer cho refresh mới: command 25 + refresh 35 + reply 39 + broadcast 14 = 113 writes, chưa gồm intake HTTP; cache hit 54 writes ở consumer. Dự toán 200/request có khoảng dư nhưng không phải trần cưỡng chế cho mọi chuỗi retry. Indexed writes đã được tính trong metadata Cloudflare.

Ngày triển khai đã tiêu thụ khoảng 67.288 D1 writes, gồm migration/thử nghiệm trước tối ưu. Policy riêng ngày UTC 13/10/2026 hạ giới hạn xuống 60 yêu cầu để giữ dư phần còn lại; tự trở về 200 vào ngày UTC tiếp theo.

Đây là dự toán cho một group nhận thông báo và workload đã giới hạn, không phải cam kết tải vô hạn. Quota dùng chung toàn account; ứng dụng khác, lỗi nguồn/Telegram kéo dài và traffic webhook bất thường có thể tiêu thụ phần dự phòng. Admission không ngăn được chi phí đọc/request của mọi traffic bị từ chối. Không bật gói trả phí.

## Kiểm chứng

Bản cuối đã chạy cron tự nhiên lúc 00:00 Việt Nam ngày 14/10, refresh hoàn tất sau khoảng 9,7 giây, một attempt. Tail thu được HTTP 3–5 ms CPU, cron 8 ms, Queue tối đa 87 ms, tất cả outcome ok. Tail không thu được HTTP đầu tiên của /price nên chưa xác nhận CPU cold start bản cuối; bản trước có mẫu 11 ms (outcome ok). Không xem smoke test là bảo đảm mọi invocation đều dưới 10 ms.

116 tests qua: gộp lệnh, cache hit/expiry, cron join, race lúc refresh hoàn thành, replay, 429, lease độc lập, enqueue thất bại, 200 requests/ngày, 60 alert parts/ngày, inline reply sau khi thả crawl lease. Smoke test production dùng chính group và bot đang chạy; không phải load test/soak test 24 giờ.

Đo trực tiếp bản cuối: /price loading 7,55 giây, kết quả 21,33 giây; /flights dùng cache loading 8,07 giây, kết quả 12,31 giây. Cặp đo ở bản trước là 4,86/20,78 giây và 5,38/9,61 giây; độ trễ Queue dao động nên không lấy mẫu tốt nhất làm SLA.

Số đo cụ thể, phiên bản deploy và giới hạn CPU ghi trong [optimization-evidence.json](cloudflare-spike/optimization-evidence.json). Thời gian UI đo từ lúc bắt đầu nhập lệnh tới khi nội dung mới xuất hiện, polling 500 ms. D1 đo từ lúc nhận request tới ACK/lưu completion, có thể hoàn tất sau khi UI đã hiển thị.

## Theo dõi

~~~powershell
npm run cf:status
node --dns-result-order=ipv4first scripts/cloudflare-runtime-tail.mjs --seconds=60
~~~

Tail lưu file ignored data/worker-tail-*.json; đọc cron_enqueued, crawl_complete, loading_complete, interactive_complete, job_retry và job_resources. Cloudflare Dashboard → Workers & Pages → crawling-air-tickets → Observability xem log lâu dài. Không chạy --preflight trên bot production chỉ để xem log.

Nguồn: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). HTTP/Cron Free 10 ms CPU; Queue consumer mặc định 30 giây CPU. Chờ network không đồng nghĩa CPU.
