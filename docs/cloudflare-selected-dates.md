# Hai ngày chính và kiểm chứng VNA qua đại lý

Scope người dùng cập nhật ngày **13/10/2026 (UTC+7)**:

- Chỉ ngày đi 04/02/2027 và ngày về 13/02/2027, SGN ⇄ VCL, 1 người lớn.
- Mỗi hãng lấy giá thấp nhất có báo giá phù hợp cho mỗi chiều, rồi cộng tổng.
- Không lấy ngày lân cận hoặc bảng 49 ô. Tính năng nhiều giờ bay tách riêng qua `/flights` trong commit sau phần simplify, theo yêu cầu tiếp theo của người dùng. `/price` vẫn ngắn, có một dòng reminder cuối.
- Người dùng cho phép lấy Vietnam Airlines qua đại lý khi endpoint chính thức không dùng được từ Worker, và yêu cầu đối chiếu với web VNA chính thức.

## Giá VNA đã đối chiếu trên web chính thức

Mở form tại [Vietnam Airlines](https://www.vietnamairlines.com/vn/vi?from=SGN&to=VCL&departureDate=2027-02-04&returnDate=2027-02-13), xác nhận đúng tuyến/ngày, chọn giá trên booking.vietnamairlines.com, rồi xem giỏ hàng và chi tiết giá cho **1 người lớn**. Trang kiểm tra truy cập ban đầu tự hoàn thành; không giải CAPTCHA hay thay đổi cơ chế bảo vệ. Không nhập thông tin hành khách, đăng nhập mua vé hoặc thanh toán.

[Đối chiếu đọc trực tiếp trên UI](cloudflare-spike/vna-web/official-comparison.json) và [kết quả Worker](cloudflare-spike/selected-dates-evidence.json):

| Giá gồm thuế/phí hãng | Web VNA | Flynow EVN sau loại phí đại lý | Chênh lệch |
| --- | ---: | ---: | ---: |
| VN1468, 04/02, 15:50–17:15 | 5.102.181đ | 5.102.181đ | 0đ |
| VN1469, 13/02, 17:50–19:10 | 5.082.181đ | 5.082.181đ | 0đ |
| Tổng hai chiều | 10.184.362đ | 10.184.362đ | 0đ |

Cùng hạng Thương Gia Linh Hoạt trên web, cabin BUSINESS / booking class J / fare basis JHVNF trong Flynow. Cùng hành lý 1 kiện 32kg và xách tay 18kg. Đây là hạng còn được nguồn báo giá ở thời điểm đối chiếu, không phải suy diễn giá phổ thông.

Vé gốc web VNA **8.398.000đ** = hai `TotalFare` 4.199.000đ. Phụ thu quản trị hãng **900.000đ** + thuế/dịch vụ sân bay/chính phủ **886.362đ** = hai `TotalTax` **1.786.362đ**. Chi tiết chính phủ: dịch vụ hành khách 178.000đ, soi chiếu an ninh 36.362đ, VAT 672.000đ. Tất cả cộng **10.184.362đ**.

Flynow `TotalPrice` hai chiều **10.284.362đ**, vì thêm `TotalServiceFee` 50.000đ mỗi chiều. Adapter tính `TotalFare + TotalTax`, đồng thời lưu giá OTA/phí đại lý riêng. Không trừ phụ thu hãng. Chiết khấu khác 0 hoặc tổng không khớp bị từ chối.

Ảnh chứng minh: [chiều đi](cloudflare-spike/vna-web/outbound.jpg), [chiều về](cloudflare-spike/vna-web/inbound.jpg), [giỏ hàng](cloudflare-spike/vna-web/cart-total.jpg), [thuế/phí](cloudflare-spike/vna-web/tax-breakdown.jpg). Không xuất HTML report.

Các giá trên là mẫu đồng thời, không bảo đảm giá không thay đổi hoặc mọi loại tồn chỗ đại lý luôn bằng tồn chỗ web. Giá mới phải đáp ứng cùng hợp đồng tiền/tuyến/ngày/hành khách; không gắn nhãn mọi lần crawl là đã được web xác minh. Nếu đối chiếu tương lai lệch, ghi rõ chênh lệch và không coi là giá chính thức. Scope đã xác minh hiện tại là chuyến bay thẳng, không gồm nối chuyến.

## Nguyên nhân 403 xác định được đến đâu

Cùng ba request chính thức (fare matrix, air-best-price đi và về), local Node nhận JSON HTTP 200. Worker nhận HTTP 403, `text/html`, body 118 byte với title `403 Forbidden`; cả ba body cùng SHA-256. Không có JSON báo lỗi payload, mã 1020/1005, dấu hiệu challenge hoặc `Retry-After`. TLS đã hoàn thành trước HTTP 403. Tài khoản Cloudflare có quyền deploy và Worker gọi Flynow thành công.

Kết luận từ đối chứng: **đường gọi từ Worker bị hệ thống phía nguồn từ chối**; lỗi không phải thiếu quyền Cloudflare, thất bại TLS hay payload không hợp lệ trong cả hai môi trường. Chưa có log firewall/origin của VNA nên không xác định được chính xác rule IP/ASN, địa lý, nhận diện Worker hay policy khác. Header `server: cloudflare` không đủ để quy kết một rule WAF. [Tài liệu Cloudflare về 403](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-403/) cũng phân biệt phản hồi origin và phản hồi bảo vệ ở edge.

Giữ request IDs/CF Ray và timestamp trong bằng chứng để phía VNA tra log nếu cần. Không đổi IP/proxy, giả mạo browser headers hoặc vượt bảo vệ. Không retry source trong một lượt.

## Luồng đơn giản đang dùng

Hai POST đồng thời tới endpoint tìm vé công khai Flynow: `system=EVN` cho VNA, `system=EVJ` cho Vietjet. Các mã này được đọc từ form/script tìm kiếm công khai của Flynow; `system=VNA` có trên UI nhưng thử nghiệm không trả báo giá thành công cho query này, không được dùng làm fallback.

Chỉ một báo giá ngày ở mỗi `legs.outbound` / `legs.inbound`. `main_price` là tổng hai chiều khi đủ cả hai; thiếu một chiều thì `partial` và tổng `null`, lỗi toàn bộ là error. Snapshot còn một `cells` cho cặp ngày chính để tương thích storage. Không lưu session/token/FlightValue của nhà cung cấp. `/flights` đọc danh sách `flights` đã có trong báo giá, không tăng requests hoặc lấy thêm ngày, và không tự gửi schedule dài trong `/price`/daily.

Nguồn `vna-flynow-selected-flight-fares-v1`, `vietjet-flynow-selected-flight-fares-v2` và query `nearbyDays: 0` tách lịch sử/minimum/cooldown khỏi VNA matrix và lịch ngày lân cận trước đây. Giữ nguyên dữ liệu lịch sử để import, không gán đổi nguồn hoặc dùng mốc cũ làm giảm giá giả. Tổng báo giá chiều đi/về của đại lý được ghi đúng cơ sở này; dù mẫu hiện tại khớp tổng khứ hồi VNA, không coi hai cơ sở giá luôn tương đương.

## Worker và giới hạn Free

Worker spike đã deploy tại [health](https://crawling-air-tickets-spike.thanhvinhlqt2016.workers.dev/health), account Free. Kết quả live hai hãng đều `ok`, VNA 10.184.362đ, Vietjet 9.761.562đ, hai source requests tổng cộng.

- HTTP mẫu đầu: 7ms CPU / 1.655ms wall; HTTP mẫu sau: 8ms CPU / 1.561ms wall.
- Consumer Queue hai hãng: 10ms CPU / 1.695ms wall, outcome `ok`.
- Đây là kiểm chứng nguồn, chưa là benchmark D1/outbox/Telegram/cron tích hợp hoặc chạy ổn định 24 giờ. HTTP/cron Free có giới hạn 10ms CPU theo [Workers limits](https://developers.cloudflare.com/workers/platform/limits/); cần đo ứng dụng cuối và chừa margin. Queue producer phải nhẹ, việc crawl/storage/fan-out nên chạy trong consumer, theo [Queues limits](https://developers.cloudflare.com/queues/platform/limits/).

Manual revalidation (không gửi Telegram): `cf auth whoami`, rồi `node --dns-result-order=ipv4first scripts/cloudflare-source-check.mjs`; thêm `--official` khi cần chẩn đoán ba endpoint chính thức. Kết quả lưu JSON trong ignored `data/`. Nếu log ingestion chưa kịp, tra lại cùng run ID trong Workers Logs; không chạy nguồn thêm chỉ để lấy metrics.

## Mục tiêu triển khai cập nhật

Deploy bot lên Workers Free với **giá hai ngày chính** cho VNA/Vietjet qua Flynow, giá VNA phải được đối chiếu đúng tuyến/ngày/hành khách/hạng vé với web chính thức trước nghiệm thu. Tiếp tục webhook Telegram, cron 10 phút, bản tin 07:00 Việt Nam, D1/Queues, history/subscribers/alerts, import/rollback và staging bot test tối thiểu 24 giờ. Nhiều giờ bay là commit riêng sau. Chỉ chuyển bot chính khi các gate tích hợp và staging đạt; không nâng gói trả phí.
