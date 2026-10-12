# Nguồn giá Vietjet qua OTA

Kiểm chứng ngày 12/10/2026, SGN ⇄ VCL, đi 04/02/2027, về 13/02/2027, một người lớn. Chọn **Flynow / EVJ làm nguồn duy nhất** cho crawler Vietjet. BestPrice chỉ dùng đối chứng trong điều tra, không chạy cùng hoặc fallback trong production.

## Đối chiếu cùng chuyến, cùng hạng vé

VJ370 đi 06:00 và VJ371 về 07:50, hạng SkyBoss:

| Nguồn | Chiều đi gồm thuế/phí | Chiều về gồm thuế/phí | Tổng | Phí đại lý được tách trong API |
|---|---:|---:|---:|---:|
| Vietjet, UI/HAR đã xác nhận trước đó | 4.890.781 | 4.870.781 | 9.761.562 | — |
| BestPrice, API tìm chuyến | 4.990.781 | 4.970.781 | 9.961.562 | 100.000 mỗi chiều |
| Flynow, API và UI bước thông tin hành khách | 4.940.781 | 4.920.781 | 9.861.562 | 50.000 mỗi chiều |

Đơn vị VND. Giao diện Flynow xác nhận tổng 9.861.562 trước nhập thông tin cá nhân. Không tạo booking. BestPrice xác nhận danh sách chuyến và giá cơ bản bằng UI; phần tổng lấy từ dữ liệu tìm kiếm, chưa xác nhận checkout BestPrice.

BestPrice có `ADT_Fare`, `ADT_Tax`, `BP_Fee`; Flynow có `TotalFare`, `TotalTax`, `TotalServiceFee`, `TotalPrice`. Với các mẫu không chiết khấu đã kiểm tra, giá hãng của cả hai nguồn khớp. **Không có quy luật cộng/trừ cố định áp dụng cho mọi OTA.** Phí phải đọc từ phản hồi của từng báo giá, không ước lượng theo phần trăm hoặc trừ một hằng số.

## Mẫu kiểm chứng lân cận

So sánh theo ngày, số hiệu chuyến và mã fare basis, gồm Eco (`T1ECO`), Deluxe (`T1DLX`) và SkyBoss (`YSBoss`):

| Ngày đi / ngày về | Số cặp báo giá khớp giữa Flynow và BestPrice | Lệch giá hãng |
|---|---:|---:|
| 04/02 / 13/02 | 9 | 0 |
| 01/02 / 10/02 | 10 | 0 |
| 07/02 / 16/02 | 16 | 0 |

Tổng 35 cặp khớp, không có cặp đối chiếu được bị lệch. Không phải mọi hạng trả về bởi một nguồn đều có ở nguồn còn lại. Chỉ so những cặp cùng chuyến và cùng hạng. Mẫu này không chứng minh mọi ngày/tuyến luôn khớp giá bán trực tiếp của Vietjet; dữ liệu OTA vẫn có thể trễ hoặc có tồn chỗ khác.

Trong lúc kiểm tra xuất hiện Eco trên VJ376 ngày 04/02. Hai OTA cùng trả giá hãng 2.385.181 chiều đi, cộng SkyBoss 4.870.781 chiều về = **7.255.962**. Đây là giá thấp nhất mới theo hai nguồn, không phải cùng sản phẩm với cặp SkyBoss 9.761.562 trong ảnh.

### Xác nhận trực tiếp trên Vietjet lúc khoảng 16:31 ngày 12/10/2026 (UTC+7)

Đã dùng trình duyệt chọn cả hai chuyến trên website Vietjet, mở bảng **Thông tin đặt chỗ** ở bước chọn chuyến bay. Giao diện xác nhận rõ hạng vé và tổng sau thuế/phí:

| Chặng đã chọn | Hạng | Giá vé trên bảng chi tiết | Thuế, phí trên bảng chi tiết | Dịch vụ | Tổng chặng |
|---|---|---:|---:|---:|---:|
| SGN → VCL, 04/02/2027, VJ376, 14:10–15:30 | Eco | 1.803.600 | 581.581 | 0 | 2.385.181 |
| VCL → SGN, 13/02/2027, VJ371, 07:50–09:10 | SkyBoss | 4.309.200 | 561.581 | 0 | 4.870.781 |

**Tổng Vietjet hiển thị: 7.255.962 VND**, khớp chính xác Flynow sau khi tách phí đại lý. Đây là giá sau khi chọn được vé, không phải giá “từ” trên lịch. Nhãn cấu phần trên UI Vietjet phân bổ thuế khác API OTA; đối chiếu theo tổng chặng. Không nhập thông tin hành khách hoặc tạo booking. Bằng chứng: `data/ota-audit/vietjet-eco-confirmed.png`. Kết quả xác nhận mẫu chuyến/ngày tại thời điểm kiểm tra, đủ chốt Flynow làm nguồn crawler theo hợp đồng dữ liệu dưới đây; không bảo đảm tồn chỗ hoặc giá giữ nguyên ở lần tìm kiếm sau.

## Hợp đồng dữ liệu được dùng

Request tìm kiếm công khai của [Flynow](https://www.flynow.vn/): POST form-urlencoded tới `/Handler/FlightHandler.ashx/ProcessRequest`, `requestType=Search`, `searchType=NORMAL`, `system=EVJ`, `adt=1`, `chd=0`, `inf=0` và hai chặng trong `listFlight`. Ngày gửi dạng DDMMYYYY. Không cần tài khoản, cookie, browser automation hay token chép từ trình duyệt trong các lần kiểm chứng.

Giá chuẩn hóa:

```text
airline_price = TotalFare + TotalTax
assert airline_price == TotalPrice - TotalServiceFee
```

Áp dụng khi `TotalAgentDiscount == 0` và `TotalAirlineDiscount == 0`; nếu xuất hiện chiết khấu, dừng chuẩn hóa mẫu đó vì chưa xác minh cách tính. Kiểm tra tiền tệ VND, số hành khách, tuyến, ngày, chiều, tổng theo người lớn và số chỗ khả dụng. Chỉ dùng Vietjet bay thẳng. Lưu phí đại lý và tổng OTA riêng, không lưu session/selection token.

7 request cung cấp 7 ngày đi và 7 ngày về; mỗi fare là một chiều (`Itinerary` 1/2, `Leg` 0/1). Chọn giá chuẩn hóa thấp nhất của mỗi ngày rồi cộng thành 49 ô. Có kiểm tra thêm cùng ngày đi 04/02 với ngày về 16/02: giá thấp nhất chiều đi không đổi so với ngày về 13/02. Bảng là tổng hai vé một chiều độc lập, không tuyên bố 49 báo giá checkout khứ hồi. Tối đa hai request đồng thời. Giá lỗi/thiếu để unknown; HTTP 403/429 dừng lên lịch các request còn lại, không retry hoặc đổi nguồn.

Flynow cần 1 request cho một cặp ngày; BestPrice trong luồng đã quan sát cần trang khởi tạo, tạo phiên tìm kiếm và hai request theo chiều. Vì vậy chọn Flynow để đơn giản hóa bảng ±3 ngày. API nội bộ của website có thể thay đổi; kiểm tra schema và tổng tiền giúp tránh trả giá sai một cách im lặng.

## Phạm vi khảo sát và tích hợp

- BestPrice và Flynow: có báo giá thực tế đúng ngày, đối chiếu cấu phần và hạng vé.
- ABAY, VietnamBooking, iVIVU, Vemaybay.vn và Trip.com: đã khảo sát trang công khai, chưa có bộ báo giá cùng chuyến/hạng để tính chênh lệch. Không kết luận các nguồn này bị chặn hoặc đắt hơn.
- Đã rollback prototype Vietjet trực tiếp và dependency Playwright. Bản lưu thử nghiệm/HAR giữ trong `data/vietjet-audit/`; không đưa vào provider đang dùng.
- Source ID `vietjet-flynow-airline-fare-v1` tách lịch sử `vietjet-public-calendar-v1`, tránh so giá có thuế với lịch quảng cáo cũ.
- `npm test`: 65 kiểm thử offline đạt tại thời điểm tích hợp. Live: 7 request, 49 ô có giá, khoảng 3,7 giây trong lượt cuối.

Bằng chứng cục bộ, được bỏ qua bởi Git: `data/ota-audit/comparison.json`, `flynow-matrix.json`, `flynow-skyboss-ui.png`. Fixture SkyBoss trong `scripts/fixtures/flynow-skyboss.json` chỉ giữ trường giá/chuyến cần kiểm thử. Báo cáo xem trước: `report/vietjet-ota-preview.html`.
