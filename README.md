# Air Ticket Price Tracker

Theo dõi giá vé Vietnam Airlines và Vietjet, lưu lịch sử, tạo báo cáo HTML mở offline và gửi cảnh báo qua Telegram. Project dùng JavaScript ESM, chỉ phụ thuộc các module có sẵn của Node.js; **không cần `npm install`**.

Cấu hình đang có: **SGN ⇄ VCL**, đi **04/02/2027**, về **13/02/2027**, **1 người lớn**, kiểm tra mỗi **25 phút**. Có thể đổi tuyến và ngày trong [`config.json`](config.json).

## Yêu cầu

- Node.js **24 trở lên** (có npm).
- Kết nối mạng để lấy giá và sử dụng Telegram.
- Máy cần tiếp tục chạy và có mạng nếu muốn theo dõi thường xuyên. `watch` không tự cài service Windows.

Chạy các lệnh bên dưới tại thư mục project. Trên PowerShell, nếu `npm.ps1` bị chặn, dùng `npm.cmd` thay cho `npm`.

## Bắt đầu nhanh

```sh
node --version
npm test
```

Chỉ còn 3 lệnh:

| Lệnh | Chức năng |
| --- | --- |
| `npm start` | Bật bot: vòng lấy giá mỗi 25 phút, bản tin sáng 07:00 và lệnh Telegram |
| `npm stop` | Dừng ngay tiến trình bot |
| `npm run telegram` | Kiểm tra kết nối Telegram (cấu hình, bot, webhook, người đăng ký) |

### Bật Telegram và theo dõi liên tục

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
│   ├── reporting/        # Đọc lịch sử, tạo context và dựng HTML
│   └── shared/           # Đường dẫn project, HTTP fetch song song và TLS
├── scripts/              # Preflight và các công cụ smoke
│   └── fixtures/         # Dữ liệu giá mô phỏng cho smoke/test
├── tests/                # Regression tests offline bằng node:test
├── templates/
│   └── report.html       # Template dashboard offline
├── docs/
│   └── alerts.md         # Chi tiết quy tắc cảnh báo và chống lặp
├── config.json           # Tuyến, ngày, hành khách và thiết lập theo dõi
├── .env.example          # Mẫu cấu hình Telegram và giờ bản tin
├── package.json          # Các lệnh npm; không có dependency ngoài
├── Dockerfile
├── data/                 # Sinh khi chạy: lịch sử, trạng thái, preview, lock
└── report/               # Sinh khi chạy: báo cáo HTML
```

`src/cli/` điều phối các module nghiệp vụ. `src/shared/paths.mjs` xác định thư mục gốc từ vị trí mã nguồn, nên chạy file bằng đường dẫn tuyệt đối từ thư mục khác vẫn đọc đúng config và ghi đúng dữ liệu.

## Các lệnh bổ sung (chạy trực tiếp bằng node)

Muốn lấy giá một lần, dựng báo cáo, hoặc chạy test mô phỏng, gọi trực tiếp file trong `src/cli/` và `scripts/`:

```sh
node src/cli/run.mjs                  # lấy giá một lần, lưu lịch sử, dựng HTML
node src/cli/run.mjs -- --airline vna # ví dụ: chỉ lấy Vietnam Airlines
node src/cli/run.mjs --render-only    # chỉ dựng HTML từ lịch sử, không gọi hãng
node src/cli/daily.mjs --preview      # xem trước bản tin sáng, không gửi
node scripts/preflight.mjs            # kiểm tra toàn diện (config, tests, Telegram)
```

CLI lấy giá hỗ trợ `--airline all|vna|vietjet`, `--quick`, `--render-only` và `--no-notify`.

## Cấu hình tuyến và theo dõi

Sửa [`config.json`](config.json); ngày dùng định dạng `YYYY-MM-DD`, ngày về phải sau ngày đi, mã sân bay gồm 3 chữ hoa.

| Trường | Giá trị hiện tại | Ý nghĩa |
| --- | --- | --- |
| `origin` / `destination` | `SGN` / `VCL` | Sân bay đi và đến |
| `departureDate` / `returnDate` | `2027-02-04` / `2027-02-13` | Ngày đi và về chính |
| `adults` | `1` | Số người lớn, từ 1 đến 9 |
| `monitoring.pollMinutes` | `25` | Chu kỳ kiểm tra, từ 20 đến 30 phút |
| `monitoring.dailyReport` | `true` | Bật bản tin hằng ngày |
| `monitoring.priceOnly` | `true` | Vòng kiểm tra chỉ báo sự kiện giá; tắt tin baseline, Eco và sức khỏe nguồn |
| `monitoring.mainDropMinVnd` | `1` | Mức giảm tối thiểu của giá khứ hồi, tính bằng VND |
| `monitoring.legDropMinVnd` | `1` | Mức giảm tối thiểu của vé riêng từng chiều, tính bằng VND |
| `monitoring.rollingWindowDays` | `7` | Cửa sổ tính đáy gần đây |
| `monitoring.repeatCooldownHours` | `24` | Thời gian chống lặp cảnh báo cùng mức giá |
| `monitoring.errorAfterConsecutive` | `3` | Số lượt lỗi liên tiếp trước cảnh báo nguồn khi tắt `priceOnly` |
| `monitoring.targetVnd.vna` / `.vietjet` | `null` / `null` | Ngân sách khứ hồi từng hãng; `null` nghĩa là chưa đặt |

VNA một chiều hiện chỉ được xác minh cho **1 người lớn**. Nếu `adults` khác 1, phần VNA một chiều được ghi rõ là thiếu dữ liệu. Adapter Vietjet dùng **Flynow làm nguồn duy nhất**, hiện chỉ xác minh **SGN ⇄ VCL, 1 người lớn**; tuyến khác hoặc số người lớn khác sẽ trả lỗi nguồn. Khoảng ngày lân cận cố định ±3 ngày, dùng cho history và HTML.

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
| `/stop` | Ngừng nhận tin tự động; vẫn dùng được `/price`, `/report` |
| `/price` | Kiểm tra giá hai hãng, gửi bản tin chung và file HTML |
| `/report` | Gửi HTML từ lịch sử đã lưu, không lấy giá mới |
| `/status` | Kiểm tra kết nối, bản tin tiếp theo, vòng poll tiếp theo, watcher, subscriber, cấu hình và trạng thái nguồn đã lưu |
| `/help` | Hướng dẫn sử dụng |
| `/connection` | Tương đương `/status` |

Bot nhận lệnh từ mọi private chat, tự đăng ký người lần đầu nhắn và broadcast cho những người chưa hủy nhận tin. Không nhận lệnh hoặc đăng ký group/channel. Sau `/stop`, các lệnh khác không tự đăng ký lại; cần `/start`. Người chặn bot sẽ được ngừng gửi sau khi Telegram trả lỗi 403. Tất cả người dùng theo dõi cùng tuyến/ngày trong `config.json`.

Bot dùng long polling, không mở server/port. Mỗi bot chỉ nên có một listener và không dùng webhook đồng thời. Khi khởi động, bot kiểm tra webhook và giữ nguyên nếu đang có webhook, rồi báo cần xử lý xung đột.

Tin `/price`, bản tin sáng và cảnh báo giá có link đặt vé. Vietjet mở tìm kiếm cả hành trình đúng tuyến, ngày và số người; cảnh báo từng chiều vẫn ghi rõ link tìm cả hành trình. Vé Vietjet kèm số hiệu chuyến, giờ và hạng khi nguồn cung cấp để chọn đúng báo giá. VNA và Flynow mở trang chính thức và ghi rõ cần nhập lại tuyến/ngày. Luồng VNA dùng phiên trình duyệt; URL kết quả Flynow không đồng bộ form tìm kiếm, có thể hiện hành trình cũ/mặc định của trình duyệt nên không dùng làm lối tắt đặt vé. Các link không giữ chỗ hoặc khóa giá; cần kiểm tra lại trước thanh toán.

`/price` luôn lấy giá mới: gọi tất cả nguồn cùng lúc để có kết quả nhanh nhất, không giãn cách, không ngân sách chờ, không retry. Nếu lượt nền đang chạy, bot chờ nhả lock (tối đa ~100 giây) rồi kiểm tra mới thay vì trả cache; chỉ khi lượt nền kẹt quá lâu mới gửi dữ liệu đã lưu kèm lý do và thời điểm. Thời gian gửi Telegram/HTML còn tùy mạng.

Lệnh quá 5 phút không được thực hiện, nhưng private chat vẫn được ghi nhận và yêu cầu hủy nhận tin vẫn có hiệu lực. Cursor lưu trước khi xử lý; nếu tiến trình chết giữa chừng, gửi lại lệnh cần thực hiện. Bot chỉ có thể ghi nhận người từ update còn trên Telegram hoặc danh sách đã lưu; người dùng cũ chưa có trong danh sách cần nhắn lại `/start`.

## Bản tin và cảnh báo

- Mặc định gửi bản tin chung kèm HTML lúc **07:00 UTC+7**, độc lập vòng lấy giá.
- Bản tin và cảnh báo được broadcast cho danh sách đang đăng ký; chống lặp, ACK và retry tách riêng từng người. Một người lỗi mạng không khiến người đã nhận bị gửi lại. `Retry-After` khi bị giới hạn Telegram tạm dừng toàn bộ broadcast.
- Bản tin gồm khứ hồi, đi, về của ngày chính, thay đổi so với mốc cuối trước hôm nay và giá thấp nhất từng quan sát kèm thời điểm. Không có mốc thì không tính phần trăm.
- `watch` hẹn từ giờ gửi kế tiếp, không gửi bù bản tin sáng khi khởi động vào buổi tối. Máy ngủ qua giờ hẹn thì khi tỉnh chỉ xét bản tin hôm nay.
- Bản tin dùng snapshot gần nhất, không đợi batch lấy giá. Lượt lỗi hoặc dữ liệu quá `pollMinutes + 5` phút được ghi rõ là giá cũ. Text và HTML dùng cùng snapshot.
- Với `priceOnly=true`, chỉ báo sự kiện giá ngày chính: giảm giá, đáy mới, đạt ngân sách hoặc có giá trở lại. Giá tăng đơn thuần và giá không đổi không phát tin; lịch sử vẫn được lưu.
- Giá ngày lân cận chỉ xuất hiện trong history/HTML, không gửi cảnh báo Telegram.

Chi tiết gộp sự kiện, chống lặp và retry: [`docs/alerts.md`](docs/alerts.md).

## Nguồn giá và giới hạn

| Nguồn | Cách hiểu giá |
| --- | --- |
| Vietnam Airlines | Khứ hồi từ fare matrix; vé riêng từng chiều từ `air-best-price` không có `tripDuration`. Gồm thuế theo nguồn; cộng hai vé riêng có thể khác giá khứ hồi. |
| Vietjet | API tìm vé Flynow (`EVJ`): giá gồm thuế/phí hãng = `TotalFare + TotalTax`, đối chiếu `TotalPrice - TotalServiceFee`. Không trừ phí cố định. Hành lý tùy hạng vé. |

Hai nguồn có cơ sở giá khác nhau nên không xếp hạng trực tiếp như cùng một loại giá. Project không tự đặt vé/giữ chỗ và không đảm bảo bắt kịp sale ngắn hạn.

Mọi lượt lấy giá gọi tối đa 5 request cùng lúc, không giãn cách, không chờ đủ khung giờ, không cho nguồn nghỉ (cooldown). HTTP 403/429/503 được ghi lại như lỗi nguồn trong snapshot, lượt sau thử lại ngay; giá ngày lân cận lấy từ cùng lượt.

## Dữ liệu và trạng thái

| Đường dẫn | Nội dung |
| --- | --- |
| `data/history.jsonl` | Lịch sử nối thêm, mỗi dòng là một snapshot |
| `data/notification-state.json` | Outbox, xác nhận và chống lặp cảnh báo |
| `data/daily-state.json` | Trạng thái bản tin, text/HTML đã gửi |
| `data/bot-state.json` | Cursor Telegram và cooldown `/price` |
| `data/telegram-subscribers.json` | Private chat ID, đăng ký/hủy nhận tin và cooldown broadcast từng bot |
| `data/*preview*.txt`, `data/*smoke*.json` | Bản xem trước và kết quả smoke |
| `data/*.lock`, `data/watch.stop` | Lock tiến trình và yêu cầu dừng watcher |
| `report/index.html` | Dashboard từ lượt chạy/report gần nhất |
| `report/telegram.html` | HTML cho slash command |
| `data/daily-report-*.html` | Snapshot HTML giữ lại để retry bản tin |

Giữ `data/` khi nâng cấp để bảo toàn lịch sử và chống lặp. Không xóa lock khi PID ghi trong file vẫn còn chạy. Khi chia sẻ mã nguồn/ZIP, bỏ `.env`, dữ liệu trạng thái Telegram, log và lock. Bot credentials và nội dung chat không được đưa vào report HTML.

## Docker và lịch chạy ngoài

Image dùng Node.js 24 và user `node`, mặc định chạy watcher:

```sh
docker build -t air-ticket-tracker .
docker run -d --name air-ticket-tracker --env-file .env -v fares-data:/app/data -v fares-report:/app/report air-ticket-tracker
docker logs -f air-ticket-tracker
docker exec air-ticket-tracker node src/cli/stop.mjs
```

Hai named volume giữ dữ liệu qua việc tạo lại container. Nếu dùng bind mount, thư mục `data/` và `report/` cần cho user `node` quyền ghi. Có thể copy dashboard ra máy bằng `docker cp air-ticket-tracker:/app/report/index.html ./index.html`.

Nếu dùng cron/Task Scheduler, chạy `node src/cli/run.mjs` mỗi 25–30 phút và `node src/cli/daily.mjs` lúc giờ bản tin (mặc định 00:00 UTC). Slash command vẫn cần `node src/cli/bot.mjs` thường trực. Chọn watcher hoặc scheduler ngoài để tránh chạy lịch trùng nhau.

## Phát triển và xử lý lỗi

```sh
npm test
node src/cli/run.mjs --render-only
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
| Chưa có dữ liệu trong HTML | Chạy `node src/cli/run.mjs` một lần để lấy giá |

Mã thoát của CLI lấy giá: `0` hoàn tất, `1` lỗi nguồn, `2` thiếu một phần/không có giá chính, `3` đang có lượt chạy khác, `4` lỗi gửi thông báo khi không có lỗi nguồn ưu tiên. Lỗi cú pháp/cấu hình chưa được xử lý riêng có thể cũng trả `1`.

Chỉ còn 3 lệnh npm: `start` (bật bot), `stop` (dừng ngay), `telegram` (kiểm tra kết nối), cộng `test`. Mọi tác vụ khác gọi trực tiếp file trong `src/cli/` và `scripts/` bằng node (ví dụ `node src/cli/run.mjs`).

Tham khảo API: [Telegram Bot API](https://core.telegram.org/bots/api).

### Nguồn Vietjet qua Flynow

Mỗi lượt dùng 7 request POST tìm vé thông thường, tối đa 2 request đồng thời, lấy 7 ngày đi và 7 ngày về. Bảng 7×7 cộng hai vé một chiều độc lập; không phải báo giá đặt chỗ khứ hồi được xác nhận cho từng ô. Không dùng lịch quảng cáo hoặc fallback về nguồn cũ.

Giá đã chuẩn hóa bỏ phí đại lý; khi đặt tại Flynow, số phải trả còn có phí này. Lưu cả `price`, `ota_price`, `agency_fee`, hạng vé và hành lý để kiểm tra. Chiết khấu chưa xác minh, tổng tiền không khớp, sai ngày/tuyến/tiền tệ hoặc lỗi nguồn được ghi thiếu dữ liệu thay vì suy diễn giá rẻ. HTTP 403/429 dừng lên lịch request còn lại.

Source mới `vietjet-flynow-airline-fare-v1` tách lịch sử lịch giá chưa rõ thuế trước đây. Chi tiết kiểm chứng: [đối chiếu OTA](docs/vietjet-ota-comparison.md). `npm test` chỉ chạy thư mục `tests/`, không chạy lại các thí nghiệm đã lưu trữ trong `data/`.
