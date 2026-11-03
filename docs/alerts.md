# Quy tắc cảnh báo giá

Quy tắc áp dụng cho **ngày đi/về chính** trong `config.json`, riêng từng hãng và từng đối tượng: khứ hồi, vé đi, vé về. Cấu hình hiện tại là SGN ⇄ VCL, đi 04/02/2027, về 13/02/2027, 1 người lớn.

Scope hiện tại không lấy ngày lân cận; history cũ vẫn được giữ. Giá không đổi vẫn được lưu vào history. Kiểm tra mỗi 10 phút; gửi ngay khi lượt kiểm tra phát hiện giảm, độc lập bản tin 07:00 UTC+7.

## Điều kiện phát cảnh báo

| Sự kiện | Điều kiện |
| --- | --- |
| Giảm giá | Giảm ít nhất `mainDropMinVnd` cho khứ hồi hoặc `legDropMinVnd` cho vé riêng từng chiều, so với lần có giá hợp lệ trước |
| Đáy mới | Thấp nhất từ khi theo dõi hoặc trong `rollingWindowDays` vừa qua; gộp cùng tin giảm nếu cùng đối tượng/mức giá |
| Đạt ngân sách | Giá khứ hồi đạt `targetVnd` của hãng; `null` nghĩa là không đặt ngân sách |
| Có giá trở lại | Ngày chính có giá sau lần hợp lệ bị thiếu giá |
| Nhãn Eco của Vietjet | Có nhãn Eco ở chiều/ngày chính; chỉ bật khi `priceOnly=false`, không xác nhận tồn chỗ live |
| Lỗi/phục hồi nguồn | Lỗi `errorAfterConsecutive` lượt thì báo một lần; hoạt động lại báo một lần; chỉ bật khi `priceOnly=false` |

Lần đầu chỉ tạo mốc cho việc so sánh giảm giá/đáy. Đáy quan sát là đáy trong dữ liệu project đã thu thập, không phải đáy toàn thị trường. Không phát tin cho giá tăng đơn thuần, không đổi hoặc chỉ đổi timestamp.

Với cấu hình hiện tại `monitoring.priceOnly=true`, vòng kiểm tra chỉ phát sự kiện giá; tin baseline, nhãn Eco và lỗi/phục hồi nguồn được tắt. Có thể kiểm tra sức khỏe qua `/status` và log. Bản tin sáng và slash command vẫn hoạt động.

## Gộp sự kiện và chống lặp

- Mỗi sự kiện là một tin ngắn. Cùng hãng, chiều, ngày và mức giá vừa giảm/lập đáy/đạt ngân sách thì gộp lý do vào một tin.
- Vé đi và vé về giảm là hai sự kiện riêng, kể cả khi giá khứ hồi không đổi.
- Chống lặp cùng mức giá trong `repeatCooldownHours` (mặc định 24 giờ); mức giá thấp hơn mới vẫn được báo.
- Outbox loại mức giá cũ khi giá tăng lại hoặc mất giá, và bỏ alert lân cận còn chờ từ phiên bản trước.
- Giá VNA từng chiều lấy từ báo giá chuyến bay Flynow EVN, không chia đôi tổng hai chiều. Nguồn mới tách mốc so sánh với VNA fare matrix trước đây. Không suy diễn giá thiếu thành 0 hoặc tự điền giá từ chiều khác.

## Gửi và retry

Các tin sự kiện cách nhau ít nhất 1,1 giây. Xác nhận gửi được lưu riêng từng sự kiện trong `data/notification-state.json`; sự kiện đã ACK không gửi lại khi sự kiện tiếp theo lỗi. Retry tôn trọng `Retry-After`.

Cảnh báo và bản tin gửi đến mọi private chat đang đăng ký trong `data/telegram-subscribers.json`. Mỗi người có trạng thái chống lặp và ACK riêng. Gửi `/stop` để ngừng nhận, `/start` để nhận lại. Lỗi một người không chặn các người còn lại; Telegram 403 ngừng gửi cho người đã chặn bot, 429 tạm dừng toàn bộ broadcast đến hết thời gian chờ. Không cần cấu hình chat ID trong `.env`.

Nếu Telegram nhận tin nhưng mạng mất trước khi tiến trình nhận ACK, retry vẫn có thể gây trùng. Giữ trạng thái khi restart/nâng cấp để tránh mất chống lặp.

## Bản tin hằng ngày

Giờ gửi lấy từ `.env`, mặc định `07:00` với UTC offset `+07:00`. Bản tin chung gồm giá khứ hồi, vé đi, vé về ngày chính; tăng/giảm/không đổi so với mốc cuối trước hôm nay; thấp nhất từng thấy kèm thời điểm.

Không có mốc trước thì không tính phần trăm. Lỗi nguồn hoặc giá quá `pollMinutes + 5` phút được ghi rõ là giá cũ. Tin đã ACK không được gửi lại khi retry hoặc nâng cấp từ phiên bản từng đính kèm HTML. Trạng thái được lưu trong `data/daily-state.json`.

Watcher hẹn giờ kế tiếp khi khởi động, không gửi bù bản tin đã qua giờ. Máy ngủ qua giờ hẹn thì khi tỉnh chỉ gửi bản tin hôm nay, không gửi dồn ngày cũ. Chạy `node src/cli/daily.mjs` riêng có thể gửi bản tin hôm nay nếu đã đến giờ và chưa gửi.

## Mẫu minh họa — không phải giá thật

```text
🎉 Giá vé vừa giảm!
Vietnam Airlines · Vé đi SGN → VCL · 04/02/2027 · 1 người lớn
Vé đi hiện là 4.800.000đ
Giảm 533.181đ (10.0%), trước 5.333.181đ
🏷 Thấp nhất từ khi theo dõi: 4.800.000đ (07:00 ngày 12/10/2026).
🕒 07:00 ngày 12/10/2026 · giờ Việt Nam
ℹ️ Gồm thuế theo nguồn; đây là giá mua riêng.
🔗 Đặt vé VNA (điền sẵn tuyến/ngày; kiểm tra hành khách rồi bấm Tìm chuyến bay):
https://www.vietnamairlines.com/vn/vi?from=SGN&to=VCL&departureDate=2027-02-04&returnDate=2027-02-13
```

Vietjet dùng kết quả tìm vé Flynow, gồm thuế/phí hãng và loại phí đại lý theo từng báo giá; hành lý tùy hạng vé. Tổng hiển thị là cộng hai vé một chiều. Không so hai hãng như cùng cơ sở giá; project không tự đặt vé hoặc giữ chỗ.

Quay lại [README](../README.md) để xem cách chạy và cấu hình.
