# Air Ticket Price Tracker

Theo dõi giá vé Vietnam Airlines và Vietjet qua Flynow, gửi cảnh báo và trả lời slash command qua Telegram. **Bot chính đã chạy trên Cloudflare Workers Free**, dùng D1 và Queues; watcher local đã dừng.

- `/price`: giá hiện tại và mức thấp nhất của chiều đang theo dõi, kèm nhắc `/flights`.
- `/flights`: các chuyến có báo giá trong ngày và chiều đang theo dõi của cả hai hãng.
- Cache chung 30 giây, gộp lệnh trùng và tách queue crawl/Telegram. Giới hạn chung 200 yêu cầu/ngày, 60 phần tin cảnh báo/ngày để dự trù Free; [số đo và quota](docs/cloudflare-optimization.md).
- Cron mỗi 10 phút; bản tin 07:00 Việt Nam. Không cần máy local chạy liên tục.
- Group **Theo dõi giá vé SGN–VCL** nhận thông báo chung; mọi thành viên dùng được `/price` và `/flights` ngay trong nhóm. Chat riêng chỉ tra cứu, không nhận bản tin tự động riêng.
- D1 chỉ giữ hai bản giá hiện tại và sáu giá thấp nhất, không lưu timeline. Lượt lỗi giữ giá gần nhất và đánh dấu giá cũ. Backup lịch sử cũ nằm trong ignored `data/`.

[Vận hành, deploy và backup](docs/cloudflare-production.md), [đối chiếu giá web VNA](docs/cloudflare-selected-dates.md), [audit nghiệm thu](docs/cloudflare-gates.md). Người dùng đã bỏ yêu cầu bot staging riêng và 24 giờ, chọn triển khai bằng bot chính.

Cấu hình đang bật: **chỉ vé về VCL → SGN ngày 13/02/2027**, **1 người lớn**, kiểm tra mỗi **10 phút**. Vé đi SGN → VCL ngày 04/02/2027 đã mua; ngày đi vẫn được giữ trong cấu hình để có thể bật lại.

Đổi `monitoring.trackingMode` trong [`config.json`](config.json) thành `outbound` (vé đi), `inbound` (vé về), hoặc `roundtrip` (hai chiều), rồi deploy lại. Cờ áp dụng cho truy vấn nguồn, cảnh báo, bản tin sáng, `/price`, `/flights` và link tìm vé. Mức thấp nhất đã ghi nhận của từng chiều được giữ nguyên; giá một chiều không ghi vào minimum khứ hồi.

## Yêu cầu

- Node.js **24 trở lên** (có npm).
- Kết nối mạng để lấy giá và sử dụng Telegram.
- Khi dùng CLI local để rollback, máy cần tiếp tục chạy và có mạng. `watch` không tự cài service Windows.

Chạy các lệnh bên dưới tại thư mục project. Trên PowerShell, nếu `npm.ps1` bị chặn, dùng `npm.cmd` thay cho `npm`.

## Kiểm tra và deploy Worker

```sh
node --version
npm test
```

Cài công cụ phát triển bằng `npm ci`. OAuth Cloudflare đã được cấu hình; đăng nhập lại khi cần bằng `cf auth login`.

```sh
npm run cf:status
npm run cf:deploy
```

Secrets ở `.env.worker.json` đã được Git ignore. Không gửi token vào chat hoặc commit vào Git.

## CLI local để chẩn đoán hoặc rollback

Các lệnh local:

| Lệnh | Chức năng |
| --- | --- |
| `npm start` | Bật bot: vòng lấy giá mỗi 10 phút, bản tin sáng 07:00 và lệnh Telegram |
| `npm stop` | Dừng ngay tiến trình bot |
| `npm run telegram` | Kiểm tra kết nối Telegram (cấu hình, bot, webhook, người đăng ký) |

### Bật chế độ local sau khi rollback

Watcher từ chối khởi động khi Telegram vẫn có webhook. Phải pause Worker và gỡ webhook thuộc app theo runbook trước khi chạy local.

1. Copy [`.env.example`](.env.example) thành `.env` nếu chưa có. Giữ nguyên `.env` đã điền trước đó.
2. Tạo bot qua [BotFather](https://t.me/BotFather), điền token vào `.env`. Không cần cấu hình `TELEGRAM_CHAT_ID`.
3. Kiểm tra rồi khởi động:

```sh
npm run telegram
npm start
```

`npm start` chạy vòng lấy giá, lịch bản tin sáng và listener Telegram. Dừng bằng `Ctrl+C` hoặc chạy lệnh sau trong terminal khác:

```sh
npm stop
```

`npm stop` dừng ngay lập tức. Khởi động lại `npm start` sau khi sửa `config.json` hoặc `.env`.

Mỗi người mở bot và gửi `/start` để đăng ký nhận bản tin/cảnh báo. Bot cũng tự ghi nhận private chat lần đầu nhắn tin.

## Cấu trúc project

```text
.
├── src/
│   ├── cli/              # Các điểm vào: run, watch, daily, bot, stop, telegram
│   ├── providers/        # Lấy và chuẩn hóa giá VNA, VNA một chiều, Vietjet
│   ├── monitoring/       # Quy tắc cảnh báo, outbox, bản tin và định dạng tin
│   ├── telegram/         # Telegram API client và xử lý slash command
│   ├── worker/           # Webhook, cron, Queues, D1, outbox và lease fencing
│   ├── reporting/        # Đọc lịch sử và tạo context
│   └── shared/           # Đường dẫn project, HTTP fetch song song và TLS
├── scripts/              # Preflight và các công cụ smoke
│   └── fixtures/         # Dữ liệu giá mô phỏng cho smoke/test
├── tests/                # Regression tests offline bằng node:test
├── docs/
│   └── alerts.md         # Chi tiết quy tắc cảnh báo và chống lặp
├── config.json           # Tuyến, ngày, hành khách và thiết lập theo dõi
├── .env.example          # Mẫu cấu hình Telegram và giờ bản tin
├── package.json          # Các lệnh npm; công cụ cf/wrangler cho phát triển
├── Dockerfile
└── data/                 # Sinh khi chạy: lịch sử, trạng thái, preview, lock
```

`src/cli/` điều phối các module nghiệp vụ. `src/shared/paths.mjs` xác định thư mục gốc từ vị trí mã nguồn, nên chạy file bằng đường dẫn tuyệt đối từ thư mục khác vẫn đọc đúng config và ghi đúng dữ liệu.

## Các lệnh bổ sung (chạy trực tiếp bằng node)

Muốn lấy giá một lần hoặc chạy test mô phỏng, gọi trực tiếp file trong `src/cli/` và `scripts/`:

```sh
node src/cli/run.mjs                  # lấy giá một lần, lưu lịch sử
node src/cli/run.mjs --airline vna # ví dụ: chỉ lấy Vietnam Airlines
node src/cli/daily.mjs --preview      # xem trước bản tin sáng, không gửi
node scripts/preflight.mjs            # kiểm tra toàn diện (config, tests, Telegram)
```

CLI lấy giá hỗ trợ `--airline all|vna|vietjet`, `--quick` và `--no-notify`.

## Cấu hình tuyến và theo dõi

Sửa [`config.json`](config.json); ngày dùng định dạng `YYYY-MM-DD`, ngày về phải sau ngày đi, mã sân bay gồm 3 chữ hoa.

| Trường | Giá trị hiện tại | Ý nghĩa |
| --- | --- | --- |
| `origin` / `destination` | `SGN` / `VCL` | Sân bay đi và đến |
| `departureDate` / `returnDate` | `2027-02-04` / `2027-02-13` | Ngày đi và về chính |
| `adults` | `1` | Số người lớn, từ 1 đến 9 |
| `monitoring.pollMinutes` | `10` | Chu kỳ kiểm tra, từ 10 đến 30 phút |
| `monitoring.dailyReport` | `true` | Bật bản tin hằng ngày |
| `monitoring.priceOnly` | `true` | Vòng kiểm tra chỉ báo sự kiện giá; tắt tin baseline, Eco và sức khỏe nguồn |
| `monitoring.mainDropMinVnd` | `1` | Mức giảm tối thiểu của giá khứ hồi, tính bằng VND |
| `monitoring.legDropMinVnd` | `1` | Mức giảm tối thiểu của vé riêng từng chiều, tính bằng VND |
| `monitoring.rollingWindowDays` | `7` | Cửa sổ tính đáy gần đây |
| `monitoring.repeatCooldownHours` | `24` | Thời gian chống lặp cảnh báo cùng mức giá |
| `monitoring.errorAfterConsecutive` | `3` | Số lượt lỗi liên tiếp trước cảnh báo nguồn khi tắt `priceOnly` |
| `monitoring.targetVnd.vna` / `.vietjet` | `null` / `null` | Ngân sách khứ hồi từng hãng; `null` nghĩa là chưa đặt |

Cả hai adapter đang dùng **Flynow**, chỉ xác minh **SGN ⇄ VCL, 1 người lớn**. Tuyến hoặc hành khách khác trả lỗi nguồn. Chỉ lấy giá thấp nhất ngày đi/ngày về chính; không lấy lịch ±3 ngày.

## Cấu hình Telegram

Trong [BotFather](https://t.me/BotFather), gửi `/newbot`, đặt tên và username kết thúc bằng `bot`. Copy token vào `.env`, không thêm chữ `bot` trước token. Mở bot vừa tạo và gửi `/start`.

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<token từ BotFather>
DAILY_REPORT_TIME=07:00
DAILY_REPORT_UTC_OFFSET=+07:00
```

Token là thông tin bí mật duy nhất cần cho Telegram. Chat ID được bot ghi nhận tự động từ private chat vào `data/telegram-subscribers.json`, không cần điền vào `.env`. Bot chỉ lưu ID, trạng thái nhận tin và thời điểm; không lưu tên, username hoặc nội dung chat vào danh sách này. Không commit hoặc chia sẻ `.env`; file này đã được bỏ qua trong Git và Docker build context.

`TELEGRAM_ENABLED=false` tắt gửi tin và listener. Các biến môi trường đã có của tiến trình được ưu tiên hơn giá trị trong `.env`. Giờ bản tin dùng UTC offset cố định, không tự đổi theo DST.

### Lệnh trong private chat

| Lệnh | Kết quả |
| --- | --- |
| `/start` | Đăng ký hoặc nhận lại cảnh báo và bản tin tự động |
| `/stop` | Ngừng nhận tin tự động; vẫn dùng được `/price` |
| `/price` | Kiểm tra giá hai hãng, gửi giá, chuyến được chọn và link đặt vé |
| `/flights` | Kiểm tra mới các chuyến có giá trong hai ngày chính của VNA/Vietjet, giờ đi/đến Việt Nam, giá và phí đại lý |
| `/status` | Kiểm tra kết nối, bản tin tiếp theo, vòng poll tiếp theo, watcher, subscriber, cấu hình và trạng thái nguồn đã lưu |
| `/help` | Hướng dẫn sử dụng |
| `/connection` | Tương đương `/status` |

Bot nhận lệnh từ mọi private chat, tự đăng ký người lần đầu nhắn và broadcast cho những người chưa hủy nhận tin. Không nhận lệnh hoặc đăng ký group/channel. Sau `/stop`, các lệnh khác không tự đăng ký lại; cần `/start`. Người chặn bot sẽ được ngừng gửi sau khi Telegram trả lỗi 403. Tất cả người dùng theo dõi cùng tuyến/ngày trong `config.json`.

Bot dùng long polling, không mở server/port. Mỗi bot chỉ nên có một listener và không dùng webhook đồng thời. Khi khởi động, bot kiểm tra webhook và giữ nguyên nếu đang có webhook, rồi báo cần xử lý xung đột.

Tin `/price`, bản tin sáng và cảnh báo giá có link đặt vé. Vietjet mở tìm kiếm cả hành trình đúng tuyến, ngày và số người; cảnh báo từng chiều vẫn ghi rõ link tìm cả hành trình. Vé Vietjet kèm số hiệu chuyến, giờ và hạng khi nguồn cung cấp để chọn đúng báo giá. VNA mở trang chính thức với tuyến/ngày được điền sẵn từ truy vấn hiện tại; kiểm tra số hành khách rồi bấm Tìm chuyến bay. Link không mang phiên đặt vé. Flynow mở URL kết quả chứa đúng tuyến/ngày/số người; form phía trên có thể hiện hành trình cũ hoặc mặc định nên nhãn link nhắc kiểm tra form. Các link không giữ chỗ hoặc khóa giá; cần kiểm tra lại trước thanh toán.

`/price` luôn lấy giá mới: gọi tất cả nguồn cùng lúc để có kết quả nhanh nhất, không giãn cách, không ngân sách chờ, không retry. Nếu lượt nền đang chạy, bot chờ nhả lock (tối đa ~100 giây) rồi kiểm tra mới thay vì trả cache; chỉ khi lượt nền kẹt quá lâu mới gửi dữ liệu đã lưu kèm lý do và thời điểm. Thời gian gửi Telegram còn tùy mạng.

`/price` giữ bản giá ngắn và có một dòng nhắc `/flights` ở cuối. `/flights` lấy mới bằng cùng lượt tìm kiếm hai ngày, không gọi thêm ngày lân cận; hiển thị mỗi số chuyến/giờ bay một lần với giá thấp nhất có báo giá, giữ rõ thời điểm, dữ liệu cũ/thiếu và phí đại lý. Không cam kết đủ toàn bộ lịch bay hoặc giữ chỗ. Menu `/flights` được đăng ký khi listener khởi động, nên listener đã chạy từ trước cần khởi động lại để nhận mã lệnh mới.

Lệnh quá 5 phút không được thực hiện, nhưng private chat vẫn được ghi nhận và yêu cầu hủy nhận tin vẫn có hiệu lực. Cursor lưu trước khi xử lý; nếu tiến trình chết giữa chừng, gửi lại lệnh cần thực hiện. Bot chỉ có thể ghi nhận người từ update còn trên Telegram hoặc danh sách đã lưu; người dùng cũ chưa có trong danh sách cần nhắn lại `/start`.

## Bản tin và cảnh báo

- Mặc định gửi bản tin chung lúc **07:00 UTC+7**, độc lập vòng lấy giá.
- Bản tin và cảnh báo được broadcast cho danh sách đang đăng ký; chống lặp, ACK và retry tách riêng từng người. Một người lỗi mạng không khiến người đã nhận bị gửi lại. `Retry-After` khi bị giới hạn Telegram tạm dừng toàn bộ broadcast.
- Bản tin gồm tổng giá đi/về của hai ngày chính và từng chiều, thay đổi so với mốc trước hôm nay và giá thấp nhất từng quan sát. Không có mốc thì không tính phần trăm.
- `watch` hẹn từ giờ gửi kế tiếp, không gửi bù bản tin sáng khi khởi động vào buổi tối. Máy ngủ qua giờ hẹn thì khi tỉnh chỉ xét bản tin hôm nay.
- Bản tin dùng snapshot gần nhất, không đợi batch lấy giá. Lượt lỗi hoặc dữ liệu quá `pollMinutes + 5` phút được ghi rõ là giá cũ.
- Với `priceOnly=true`, chỉ báo sự kiện giá ngày chính: giảm giá, đáy mới, đạt ngân sách hoặc có giá trở lại. Giá tăng đơn thuần và giá không đổi không phát tin; lịch sử vẫn được lưu. Khi một lượt kiểm tra phát hiện giá giảm, bot gửi ngay trong lượt đó; độ trễ phát hiện có thể tới khoảng 10 phút cộng thời gian lấy giá/gửi tin.
- Không lấy thêm ngày lân cận. Lịch sử cũ được giữ nguyên; nguồn và query mới tách mốc so sánh.

Chi tiết gộp sự kiện, chống lặp và retry: [`docs/alerts.md`](docs/alerts.md).

## Nguồn giá và giới hạn

| Nguồn | Cách hiểu giá |
| --- | --- |
| Vietnam Airlines | Flynow EVN: giá chuyến bay từng chiều đúng ngày, gồm thuế/phí hãng; tổng cộng hai chiều, loại phí đại lý theo báo giá. Không dùng giá fare matrix VNA làm cùng mốc so sánh. |
| Vietjet | API tìm vé Flynow (`EVJ`): giá gồm thuế/phí hãng = `TotalFare + TotalTax`, đối chiếu `TotalPrice - TotalServiceFee`. Không trừ phí cố định. Hành lý tùy hạng vé. |

Hai nguồn có cơ sở giá khác nhau nên không xếp hạng trực tiếp như cùng một loại giá. Project không tự đặt vé/giữ chỗ và không đảm bảo bắt kịp sale ngắn hạn.

Mỗi lượt gọi hai request song song: một tìm kiếm Flynow EVN cho VNA và một EVJ cho Vietjet, cùng hai ngày chính. Không retry trong lượt; HTTP 403/429/503 là lỗi nguồn, không là giá 0.

## Dữ liệu và trạng thái

| Đường dẫn | Nội dung |
| --- | --- |
| `data/history.jsonl` | Lịch sử nối thêm, mỗi dòng là một snapshot |
| `data/crawl-YYYY-MM-DD.jsonl` | Log từng request: run ID, hãng, endpoint, kết nối/gửi/chờ headers/đọc body, HTTP status, thời gian và mã lỗi/cause; ngày file theo UTC |
| `data/notification-state.json` | Outbox, xác nhận và chống lặp cảnh báo |
| `data/daily-state.json` | Trạng thái bản tin, tin đã gửi |
| `data/bot-state.json` | Cursor Telegram và thời điểm `/price` |
| `data/telegram-subscribers.json` | Private chat ID, đăng ký/hủy nhận tin và cooldown broadcast từng bot |
| `data/*preview*.txt`, `data/*smoke*.json` | Bản xem trước và kết quả smoke |
| `data/*.lock`, `data/watch.stop` | Lock tiến trình và yêu cầu dừng watcher |

Giữ `data/` khi nâng cấp để bảo toàn lịch sử và chống lặp. Không xóa lock khi PID ghi trong file vẫn còn chạy. Khi chia sẻ mã nguồn/ZIP, bỏ `.env`, dữ liệu trạng thái Telegram, log và lock. Không xuất hoặc đính kèm HTML.

## Docker và lịch chạy ngoài

Image dùng Node.js 24 và user `node`, mặc định chạy watcher:

```sh
docker build -t air-ticket-tracker .
docker run -d --name air-ticket-tracker --env-file .env -v fares-data:/app/data air-ticket-tracker
docker logs -f air-ticket-tracker
docker exec air-ticket-tracker node src/cli/stop.mjs
```

Named volume giữ lịch sử và trạng thái qua việc tạo lại container. Nếu dùng bind mount, thư mục `data/` cần cho user `node` quyền ghi.

Nếu dùng cron/Task Scheduler, chạy `node src/cli/run.mjs` mỗi 10 phút và `node src/cli/daily.mjs` lúc giờ bản tin (mặc định 00:00 UTC). Slash command vẫn cần `node src/cli/bot.mjs` thường trực. Chọn watcher hoặc scheduler ngoài để tránh chạy lịch trùng nhau.

## Phát triển và xử lý lỗi

```sh
npm test
node src/cli/daily.mjs --preview
node scripts/smoke.mjs
```

Các lệnh trên không gửi Telegram (trừ smoke có `--send`). Test dùng `node:test`, mock nguồn/Telegram và thư mục tạm. Khi thêm module, đặt theo nhóm chức năng trong `src/`, thêm test trong `tests/`; công cụ kiểm tra và dữ liệu mô phỏng nằm trong `scripts/`.

| Tình huống | Cách xử lý |
| --- | --- |
| `npm.ps1` bị chặn | Dùng `npm.cmd` hoặc chạy trực tiếp file bằng Node.js |
| Lock còn tồn tại | Kiểm tra PID; chỉ xóa lock cũ sau khi xác nhận tiến trình đã dừng |
| Telegram chưa đủ cấu hình | Kiểm tra `.env`, chạy `npm run telegram` |
| Listener/webhook xung đột | Dừng listener khác; `watch` đã bao gồm slash bot |
| Nguồn lỗi hoặc thiếu giá | Xem log và `/status`, gửi `/price` để thử lại ngay |

Khi `/price` chậm, tra `run_id` trong log tiến trình rồi đối chiếu file `data/crawl-YYYY-MM-DD.jsonl`. `request_sent` nhưng chưa có `response_headers` nghĩa là đang chờ phản hồi sau khi gửi; `response_headers` nhưng chưa `response_complete` nghĩa là đang tải body. `connecting_or_queued` chưa đủ phân biệt DNS/TCP/TLS với chờ connection pool. Log gồm địa chỉ máy chủ và trạng thái xác minh TLS khi kết nối đã sẵn sàng. Request lỗi/timeout vẫn được đếm; stdout/stderr của crawler `/price` được chuyển vào log bot. Không ghi request/response body, cookie, header xác thực hay query string. Log mới không thể khôi phục chi tiết các lần lỗi trước khi triển khai.

Mã thoát của CLI lấy giá: `0` hoàn tất, `1` lỗi nguồn, `2` thiếu một phần/không có giá chính, `3` đang có lượt chạy khác, `4` lỗi gửi thông báo khi không có lỗi nguồn ưu tiên. Lỗi cú pháp/cấu hình chưa được xử lý riêng có thể cũng trả `1`.

Chỉ còn 3 lệnh npm: `start` (bật bot), `stop` (dừng ngay), `telegram` (kiểm tra kết nối), cộng `test`. Mọi tác vụ khác gọi trực tiếp file trong `src/cli/` và `scripts/` bằng node (ví dụ `node src/cli/run.mjs`).

Tham khảo API: [Telegram Bot API](https://core.telegram.org/bots/api).

### Nguồn chuyến bay qua Flynow

Mỗi hãng tìm một lần cho hai ngày chính, lấy giá thấp nhất từng chiều và tổng hai chiều. `/flights` hiển thị nhiều giờ bay trong commit riêng, dùng cùng dữ liệu nguồn; `/price` và daily vẫn ngắn. Đây không phải cam kết toàn bộ lịch bay hoặc giữ chỗ.

Giá so sánh là `TotalFare + TotalTax`; lưu riêng `ota_price` và `agency_fee`. Số phải trả tại Flynow còn có phí đại lý. Chiết khấu chưa xác minh, tổng tiền không khớp, sai tuyến/ngày/giờ/hành khách hoặc lỗi nguồn không được suy diễn thành giá rẻ.

Nguồn đang dùng: `vna-flynow-selected-flight-fares-v1`, `vietjet-flynow-selected-flight-fares-v2`; query `nearbyDays: 0`. Lịch sử cũ vẫn giữ nguyên và import được, nhưng không tự trộn vào minimum/alert nguồn mới. Snapshot còn một `cells` cho cặp ngày chính để tương thích storage; không còn 49 ô.

Chạy lại kiểm chứng từ Worker (không gửi Telegram):

```sh
cf auth whoami
node --dns-result-order=ipv4first scripts/cloudflare-source-check.mjs
# Thêm --official khi cần chẩn đoán riêng ba endpoint VNA chính thức.
```

Xem [bằng chứng và mục tiêu triển khai cập nhật](docs/cloudflare-selected-dates.md). `npm test` chỉ chạy test offline.
