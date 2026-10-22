# Worker production

Bot chính đã hoạt động trên **Workers Free từ 13/10/2026**, không nâng gói trả phí. Người dùng chọn bot chính, bỏ bot staging riêng/24 giờ và thay timeline bằng giá hiện tại + giá thấp nhất.

- [Worker health](https://crawling-air-tickets.thanhvinhlqt2016.workers.dev/health); [bot Telegram](https://t.me/synapse_vinh_notify_test_bot).
- Phiên bản đang chạy được ghi trong [bằng chứng khôi phục feed](cloudflare-spike/vna-feed-recovery-2026-10-22.json) (22/10/2026).
- D1 `crawling-air-tickets-state`: `aa8be7a3-77e5-4de3-a124-d28b2a056f9d`.
- Hai Queue `crawling-air-tickets-jobs` (crawl) và `crawling-air-tickets-delivery` (Telegram): batch 1, concurrency 2, tối đa 5 retries; lease riêng cho mỗi lane.
- Cron `*/10 * * * *` và `0 0 * * *` (07:00 Việt Nam).
- Webhook `/telegram`, secret header; nhận lệnh trong private chat và group được cấu hình. Một group nhận bản tin tự động, các subscriber private cũ đã ngừng nhận tự động.

Ngày 22/10 đã sửa race giữa cron 10 phút và cron 07:00: job gửi bản tin `daily:<ngày Việt Nam>` được lưu độc lập, chờ refresh hoàn thành rồi mới format/gửi. Nếu cron sáng đến khi poll cùng slot đã xong (kể cả cache đã hết hạn), bản tin vẫn được tạo, không crawl trùng hoặc gửi lại bản tin đã ACK. Nếu nguồn lỗi, giữ giá thành công gần nhất, đánh dấu GIÁ CŨ và không hạ minimum bằng dữ liệu lỗi. Thêm mã lỗi nguồn có allowlist vào log, không ghi session/message thô của nhà cung cấp. **128 tests qua**. [Bằng chứng sự cố và khôi phục](cloudflare-spike/daily-recovery-2026-10-22.json).

## Sự cố nguồn VNA ngày 22/10/2026

Người dùng sau đó chấp nhận **điều chỉnh tạm** và yêu cầu crawl cả BestPrice lẫn ABAY. Nguồn mới `vna-agency-estimates-v1` giữ cả hai báo giá, lấy mức ước tính thấp nhất trong các nguồn thành công, ghi rõ từng nguồn/thời điểm trong `/price` và `/flights`. Với **VCL → SGN, 13/02/2027, 1 người lớn**, BestPrice bỏ phí dịch vụ đọc từ báo giá rồi **trừ 819đ**; ABAY giữ tổng đại lý rồi **cộng 181đ**. Ngoài tuyến/ngày này không áp dụng hai hằng số. Đây là ước tính được chấp nhận tạm, không bảo đảm giá thanh toán VNA về sau luôn khớp. Minimum ước tính dùng định danh nguồn riêng; minimum đã xác minh trước đó được giữ nguyên, không trộn vào.

Phần truy xuất chạy bằng [GitHub Actions](../.github/workflows/vna-agency-feed.yml) trên runner Ubuntu tiêu chuẩn của **repo public**, không dùng watcher local hay Browser Run. Worker vẫn xử lý bot, cron, Queue, D1 và thông báo. Feed đi qua `/sources/vna` với secret riêng chỉ dành cho nhập báo giá; không dùng Telegram token hay admin token trong Actions. Worker kiểm tra lại tuyến/ngày, hành khách, tiền tệ, cấu phần tiền, điều chỉnh, thời điểm; bỏ trường ngoài allowlist và chống ghi đè bằng báo giá cũ. Feed quá **15 phút** bị coi là lỗi nguồn và bản last-good tiếp tục được ghi GIÁ CŨ. Mỗi slot 10 phút chỉ được tạo tối đa một refresh do feed; cơ chế gộp refresh/command vẫn giữ nguyên.

Đã cấu hình lịch **mỗi 10 phút** trên nhánh mặc định. Lúc 14:51 ngày 22/10 kiểm tra thấy **chưa có event schedule nào từ lúc triển khai**, dù workflow active và các lượt chạy tay thành công. Đã khôi phục báo giá bằng lượt chạy tay, đổi lịch sang `5,15,25,35,45,55 * * * *` và disable/enable để đăng ký lại; chỉ riêng các thao tác này chưa chứng minh scheduler đã phục hồi. Workflow checkout nhánh triển khai `codex/cloudflare-workers`; phải giữ nhánh này cho đến khi chuyển cấu hình sang nhánh đã chứa adapter. GitHub có thể trì hoãn lịch khi tải cao và tự tắt schedule của repo public sau 60 ngày không có hoạt động repository. Cần kiểm tra Actions nếu feed cũ. Giới hạn 200 slash requests/ngày và 60 alert parts/ngày vẫn giữ nguyên. Không bật gói trả phí.

`/status` hiện kiểm tra cả tuổi báo giá lẫn `last_attempt_failed`, không hiển thị `ok` từ bản last-good đã quá hạn. Đường khôi phục `vna-feed-dispatch.mjs` đã bật ngày 22/10 bằng secret `GITHUB_ACTIONS_TOKEN`: refresh của Worker gọi workflow khi feed không mới trong 4 phút. Khóa D1 dùng chung giới hạn tối đa một lần gọi trong 10 phút, kể cả cron và slash command chạy đồng thời hoặc API lỗi. Chỉ gọi repo/workflow cố định, không lưu token/phản hồi thô vào D1 hoặc log. Token fine-grained chỉ cấp cho repo này, quyền Actions: Read and write và Metadata: Read-only, hết hạn **14/02/2027**; đã xác nhận binding Cloudflare là `secret_text`. Không dùng OAuth token của CLI. Khi thiếu secret, đường này tắt. Kết quả kiểm chứng cron thực tế nằm trong hồ sơ khôi phục.

**Đã kiểm chứng cron Worker tự chạy lúc 15:40 ngày 22/10**, không gọi workflow thủ công: job `poll:2987764` dispatch thành công HTTP 200, [GitHub run 39749476520](https://github.com/pho-veteran/crawling-air-tickets/actions/runs/39749476520) lấy đủ BestPrice/ABAY trong 10,316 giây với 8 requests, gửi feed HTTP 202. Job `feed:2987764` cập nhật bản giá đang dùng; VNA có timestamp 15:40:34, trạng thái `ok`, `last_attempt_failed=false`, giá ước tính 5.082.181đ. Worker version `71ea0b34-75c0-4673-b330-443989030dce` nhận 100% lưu lượng. Lịch GitHub riêng chưa được chứng minh phục hồi; đường đã kiểm chứng là cron Cloudflare → workflow dispatch → feed → giá hiện tại. GitHub có thể xếp hàng runner nên đây không phải cam kết cập nhật đúng từng giây.

**137 tests qua** ở lần triển khai adapter, sau đó **141 tests qua** với dispatch và trạng thái giá cũ. Đã kiểm tra `/price`, `/flights` trong group chính: cả hai hiện đủ báo giá BestPrice/ABAY, điều chỉnh và nhãn ước tính. [Lượt crawl cloud thành công](https://github.com/pho-veteran/crawling-air-tickets/actions/runs/39718672579) lấy cả hai nguồn trong 6,428 giây, Worker nhận HTTP 202. [Bằng chứng triển khai và delay](cloudflare-spike/vna-agency-deployment-2026-10-22.json), [ảnh kết quả thực tế](cloudflare-spike/vna-web/agency-price-live-2026-10-22.png). Direct fetch từ Worker tới hai đại lý gặp HTTP 530/1016 hoặc 403/1000, vì vậy truy xuất được chuyển sang runner cloud; Worker không dùng Browser Run.

Đã kiểm tra lại bằng trình duyệt trên web VNA chính thức: **VN1469, VCL → SGN ngày 13/02/2027, 17:50–19:10, Thương Gia Linh Hoạt, 1 người lớn, 5.082.181đ**. Giá bằng mức đã lưu; việc giá không đổi không chứng minh crawler đã cập nhật thành công. Chi tiết gồm vé 4.199.000đ, phụ thu hãng 450.000đ, phí hành khách 79.000đ, soi chiếu 18.181đ và VAT 336.000đ.

`0001` là phản hồi thất bại của kênh Flynow EVN (HTTP 200, `Status:false`, không có danh sách giá), **chưa xác định được nguyên nhân nội bộ của mã này**. Truy vấn đối chứng một chiều, khứ hồi và ngày gần cũng gặp phản hồi rỗng. VietnamBooking báo lỗi VNA nhận HTTP 503, trong khi trả được Vietjet; đây là dấu hiệu lỗi nguồn cung cấp nhưng chưa chứng minh dùng chung backend với Flynow. Kiểm tra sau đó từ Worker còn gặp HTTP 530 và production gặp HTTP 403 ở cả hai hãng; truy cập trang tìm kiếm Flynow tại máy local chuyển tới `/BlackListPage.aspx`. Đây là các lỗi truy cập xuất hiện sau lỗi `0001`, không đánh đồng nguyên nhân. API VNA trực tiếp vẫn trả 403; trang booking qua HTTP yêu cầu xác minh bảo mật.

Trong bước điều tra ban đầu, BestPrice có đúng chuyến/hạng nhưng giá sau bỏ phí đại lý là 5.083.000đ (**+819đ**); ABAY là 5.082.000đ (**−181đ**). VietnamBooking, Gotadi, Goyolo và TripWise chưa trả được báo giá VNA phù hợp; iVIVU yêu cầu token xác minh. Khi còn yêu cầu khớp chính xác, chưa có adapter thay thế đạt tiêu chí nên production giữ last-good và cảnh báo GIÁ CŨ. Sau khi người dùng chấp nhận điều chỉnh tạm, hai nguồn được triển khai theo cơ chế ước tính ở trên. Timestamp vẫn là thời điểm crawl thực; không ghi báo giá thủ công như lượt crawl tự động thành công.

[Bằng chứng điều tra và giá chính thức](cloudflare-spike/vna-source-incident-2026-10-22.json), [chi tiết giá VNA](cloudflare-spike/vna-web/official-inbound-2026-10-22.png), [chuyến VN1469 và tổng tiền](cloudflare-spike/vna-web/official-inbound-cart-2026-10-22.png). Không tạo booking hay gửi thông tin hành khách. Hồ sơ điều tra này được ghi trước khi triển khai nguồn ước tính.

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

D1 sau đổi nguồn ngày 22/10 giữ **2 observations đang dùng + 1 observation nguồn VNA cũ, 0 price_quotes, 7 price_minima**, cùng **1 bản feed hiện tại**. Minimum mới của nguồn ước tính tách khỏi 6 minimum cũ. Mỗi lượt thay bản hiện tại, chỉ hạ minimum khi có giá thấp hơn. Lỗi toàn bộ giữ bản có giá gần nhất với `last_attempt_failed`, hiển thị “GIÁ CŨ”; partial ghi rõ nguồn/chiều thiếu. `/flights` đọc các chuyến có báo giá của bản hiện tại trong ngày đang theo dõi, không lưu lịch sử giờ bay.

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
