# Telegram file downloader (Node.js)

Tải toàn bộ file (nhạc, video, ảnh, tài liệu, voice) từ một chat / group / channel Telegram, dùng tài khoản người dùng qua [GramJS](https://gram.js.org) — không bị giới hạn 20MB như Bot API.

## Cài đặt

```bash
npm install
cp .env.example .env   # điền API_ID, API_HASH lấy từ https://my.telegram.org
```

Lần chạy đầu sẽ hỏi số điện thoại, mã OTP (và mật khẩu 2FA nếu có). Phiên đăng nhập được lưu ở `session.txt` — **giữ bí mật file này**, ai có nó là truy cập được tài khoản.

## Giao diện web (khuyên dùng)

```bash
npm run web        # chạy server và tự mở trình duyệt, đã đăng nhập sẵn (npm run web:server: chỉ chạy server)
```

> **Kết nối API khi đăng nhập:** nếu `.env` có đủ `API_ID` + `API_HASH`, màn đăng nhập cho chọn *Dùng API có sẵn* (của `.env`) hoặc *Tự tạo API ID*; nếu `.env` thiếu, tool hỏi thẳng API ID/hash (có link tới my.telegram.org). API tự nhập được lưu ở thư mục dữ liệu riêng (`api.json`, quyền 600), không ghi vào `.env`. Nút *← Chọn lại cách kết nối* có ở các bước nhập API và số điện thoại. `.env` được đọc lại mỗi lần đăng nhập, sửa không cần khởi động lại server.
>
> Trình duyệt được mở bằng một **mã dùng một lần** (hết hạn sau 60 giây, dùng xong là vô hiệu) thay vì token thật, nên không lộ token qua dòng lệnh. Muốn mở bằng trình duyệt khác: `TDL_OPEN_CMD=firefox npm run web`, hoặc Ctrl+click link có token in trong terminal (mỗi trình duyệt chỉ cần một lần).
>
> Mỗi lần bật máy cần chạy lại `npm run web` (server không tự chạy sau khi khởi động lại).
> **Đừng mở `public/index.html` bằng Live Server của VS Code hay mở file trực tiếp** — trang sẽ không kết nối được.

Terminal sẽ in một **link kèm token**, dạng `http://127.0.0.1:3000/?token=…`. **Mở đúng link đó** trên trình duyệt (token được lưu vào cookie, các lần sau chỉ cần vào `http://127.0.0.1:3000`). Token ngăn người dùng khác hoặc chương trình khác trên cùng máy truy cập tài khoản Telegram của bạn:

1. Đăng nhập (lần đầu): nhập số điện thoại → mã trong app Telegram → mật khẩu 2FA nếu có.
2. Chọn kênh ở cột trái (hoặc dán link `t.me/...` / username rồi Enter).
3. Chọn loại file (Nhạc, Video, Ảnh…), tìm theo tên, lọc *Chưa tải / Đã tải*.
4. Bấm vào dòng để chọn; **Shift + bấm** để chọn cả đoạn; *Chọn tất cả* chọn mọi bài đang hiện.
5. **Tải xuống** → kiểm tra danh sách trong hộp xác nhận → **Bắt đầu tải**.
6. Theo dõi tiến độ ở cột bên phải; 📂 mở thư mục lưu.

**Nghe trước khi tải:** mọi bài đều có nút ▶ ở đầu dòng. Bài chưa tải được phát trực tiếp từ Telegram (nhãn *Nghe thử*, tua được, không lưu gì xuống máy); bài đã tải phát từ file trên máy (nhãn *Từ máy*). Bấm lại nút để tạm dừng; nút **⏪ 10s / 10s ⏩** (hoặc phím **← / →**) để lùi / tiến 10 giây.

**Xem trước ảnh / video:** ảnh có nút 👁, video có nút ▶ (màn hình) thay cho nút phát nhạc. Bấm để mở hộp xem trước: ảnh hiện lớn, video phát trực tiếp từ Telegram (tua được, không lưu xuống máy). Trong hộp có **‹ Trước / Sau ›** (phím ← →) để lướt qua các ảnh/video đang hiện trong danh sách, và **Chọn để tải** để tick luôn. Video định dạng trình duyệt không hỗ trợ (vd. một số .mkv) sẽ báo không xem được nhưng vẫn tải về bình thường.

**Thư mục tải xuống:** lần đầu bấm *Bắt đầu tải* mà chưa cài đặt, tool sẽ hỏi thư mục (duyệt thư mục, lối tắt Home / Music / Downloads, tạo thư mục mới) kèm ô *Ghi nhớ làm thư mục mặc định*. Đổi bất cứ lúc nào ở **⚙ Cài đặt**: thư mục mặc định (hoặc bỏ để lần nào cũng hỏi) và bật/tắt *Tạo thư mục con theo tên kênh*. Khi đã có thư mục mặc định, hộp xác nhận tải không hỏi thư mục nữa (file vào thẳng thư mục mặc định); muốn đổi thì vào ⚙ Cài đặt. Cài đặt lưu ở `settings.json`.

**Lịch sử tải:** nút **Lịch sử** trên thanh trên cùng bật/tắt cột lịch sử (lưu ở `history.json`, còn nguyên sau khi tắt server). Mỗi mục có 📂 mở thư mục chứa file và 🗑 xoá khỏi lịch sử; có nút *Xoá toàn bộ lịch sử*. Xoá lịch sử **không xoá file** trên máy.

**Sắp xếp:** ô *Sắp xếp* trên thanh công cụ hoặc bấm tiêu đề cột — `#` (mới nhất / cũ nhất), *Tên bài* (A→Z / Z→A), *Dung lượng* (bấm lần lượt: lớn→nhỏ, nhỏ→lớn, thời lượng dài→ngắn, ngắn→dài). Mặc định là thứ tự trong kênh (mới nhất trước); tải lại trang sẽ về mặc định. Sắp xếp kết hợp được với tìm kiếm và bộ lọc *Chưa tải / Đã tải*.

Tên hiển thị là tên Telegram hiện (Ca sĩ – Tên bài trong tag); nếu khác tên file thì tên file hiện ở dòng nhỏ bên dưới. Ô tìm kiếm tìm theo cả hai, không phân biệt dấu.

Đổi cổng: `PORT=8080 npm run web`. Số file tải song song: `CONCURRENCY=5 npm run web`. `DOWNLOAD_DIR=...` đặt thư mục mặc định ban đầu (khi chưa chọn trong Cài đặt).
Server chỉ nghe trên `127.0.0.1` (chỉ máy này truy cập được).

> Không chạy giao diện web và CLI cùng lúc — hai tiến trình dùng chung một `session.txt` có thể làm Telegram ngắt kết nối.

## Dòng lệnh (CLI)

```bash
node index.js --list                               # xem danh sách chat + ID
node index.js --chat nhaclotclub -t music          # hiện danh sách nhạc để chọn rồi tải
node index.js --chat https://t.me/nhaclotclub -t music --all   # tải hết, không chọn
node index.js --chat -1001234567890 -t video -j 5
node index.js --chat me                            # Saved Messages
```

### Chọn file

Sau khi quét kênh, tool hiện danh sách dạng checkbox:

| Phím | Tác dụng |
|---|---|
| `↑` `↓` / `PgUp` `PgDn` / `Home` `End` | di chuyển |
| `Space` | chọn / bỏ chọn bài đang trỏ |
| gõ chữ | tìm theo tên (`Backspace` xoá, `Esc` xoá ô tìm) |
| `Ctrl+A` | chọn tất cả bài đang hiển thị (dùng kèm tìm kiếm) |
| `Ctrl+D` | bỏ chọn tất cả |
| `Enter` | xác nhận |
| `Esc` (khi ô tìm trống) / `Ctrl+C` | thoát |

Sau `Enter`, tool in danh sách đã chọn + tổng dung lượng và hỏi `Start download?`:
`Enter`/`y` = bắt đầu tải, `n` = quay lại danh sách (giữ nguyên lựa chọn), `q` = thoát.
Bài có dấu `✓` là đã tải trước đó.

| Tuỳ chọn | Mô tả |
|---|---|
| `-c, --chat` | username, @username, link t.me, ID số, hoặc `me` |
| `-t, --type` | `all` (mặc định), `music`, `video`, `photo`, `document`, `voice` |
| `-a, --all` | tải tất cả, bỏ qua bước chọn |
| `-o, --out` | thư mục lưu (mặc định `downloads/<tên chat>`) |
| `-l, --limit` | số tin nhắn tối đa cần quét |
| `-j, --concurrency` | số file tải song song (mặc định 3) |

- Chạy lại sẽ bỏ qua file đã tải đủ dung lượng (resume được).
- File đang tải có đuôi `.part`, chỉ đổi tên khi tải xong.
- Tự chờ và thử lại khi Telegram trả về `FLOOD_WAIT`.

## Bản chạy trên trình duyệt (triển khai Vercel, nhiều người dùng)

Vercel không chạy được `server.js` (response tối đa 4,5 MB, function sống tối đa vài phút, không có ổ đĩa lâu dài), nên bản Vercel **chạy Telegram ngay trong trình duyệt của từng người** (GramJS qua WebSocket tới `*.web.telegram.org`). Vercel chỉ phục vụ file tĩnh:

- Mỗi người tự đăng nhập Telegram bằng tài khoản mình; phiên, cài đặt, lịch sử nằm **trong trình duyệt của họ** — không server nào giữ phiên của ai.
- File tải **thẳng từ Telegram về máy người dùng**: Chrome/Edge (máy tính) chọn được thư mục thật; Firefox/Safari/điện thoại lưu vào thư mục *Tải về* của trình duyệt (stream qua Service Worker, không giữ cả file trong RAM).
- Nghe/xem trước, tua, sắp xếp, lịch sử… giống bản local. Không có: nút mở thư mục trên máy.

```bash
npm run preview:web      # build vào dist/, chạy thử ở http://127.0.0.1:4173 (header giống Vercel) và tự mở trình duyệt
                         # build trên máy tự lấy API_ID / API_HASH trong .env cho lựa chọn "Dùng API có sẵn"
```

**Đang chạy công khai tại: https://tele-downloader.vercel.app** (dự án Vercel `tele-downloader`).

Mã nguồn: https://github.com/doandc701/tele-downloader (riêng tư). Dự án Vercel đã nối với repo này nên **không cần deploy tay**:

- `git push` lên nhánh **`main`** → Vercel tự build và cập nhật https://tele-downloader.vercel.app
- push lên **nhánh khác** (hoặc mở Pull Request) → Vercel tạo **bản xem thử** riêng, có link để thử trước khi gộp vào `main`
- build lỗi thì trang chính giữ nguyên bản cũ; xem lỗi ở Vercel → Deployments

Vẫn có thể deploy tay khi cần: `npx vercel --prod`.

> Một số mạng (công ty / nhà mạng) chặn dải IP mới của `*.vercel.app` nên trang không mở được. Cách khắc phục bền vững là gắn tên miền riêng cho dự án trên Vercel (*Settings → Domains*).

### Triển khai

1. Cài CLI và đăng nhập: `npm i -g vercel` rồi `vercel login`.
2. Trong thư mục dự án: `vercel` (bản xem thử) → kiểm tra → `vercel --prod`.
   (Hoặc đẩy mã lên GitHub rồi *Import Project* trên vercel.com — `vercel.json` đã có sẵn lệnh build.)
3. Tuỳ chọn — biến môi trường trên Vercel (*Settings → Environment Variables*):
   - `TG_API_ID`, `TG_API_HASH`: gắn sẵn API của bạn → người dùng chỉ cần số điện thoại + mã.
     Lưu ý: hai giá trị này **nằm công khai trong file JS** (như mọi web client Telegram) và mọi người dùng chung một ứng dụng; nếu ai đó lạm dụng, Telegram có thể khoá cả ứng dụng.
   - Bỏ trống: mỗi người tự nhập API ID/hash của họ (tạo ở my.telegram.org) ở lần đầu.

`.vercelignore` đảm bảo `session.txt`, `.env`, `.ui-token`, lịch sử, cài đặt và thư mục `downloads/` **không bao giờ** bị tải lên Vercel.

## Bảo mật

Tool giữ phiên đăng nhập Telegram (toàn quyền tài khoản) nên được khoá nhiều lớp:

- **Chỉ nghe trên `127.0.0.1`** — máy khác trong mạng không vào được.
- **Token truy cập**: mọi request phải kèm token (lưu trong cookie `HttpOnly`, `SameSite=Strict`). Người/chương trình khác trên cùng máy gọi `127.0.0.1:3000` sẽ bị từ chối (401). Token nằm ở `.ui-token` trong thư mục dữ liệu riêng (quyền 600). Đặt token cố định qua biến `UI_TOKEN=...` nếu muốn.
- **Chống trang web độc hại**: kiểm tra Host/Origin (chống DNS-rebinding), CSP chặt (script chỉ chạy từ chính trang + CDN đã ghim), `X-Frame-Options: DENY` (không nhúng iframe được), cookie `SameSite=Strict`.
- **Nội dung từ Telegram được coi là không tin cậy**: tên kênh/tên file được làm sạch (không thể chứa `..`, `/`, ký tự điều khiển hay ký tự đảo chiều để thoát thư mục); mọi dữ liệu hiển thị đều escape (chống XSS); loại file (Content-Type) chỉ nhận nhạc/video/ảnh, còn lại tải về dạng tệp thường (chống XSS lưu trữ).
- **Dữ liệu bí mật nằm ngoài thư mục dự án**: `session.txt`, `.ui-token`, `settings.json`, `history.json` được lưu ở `~/.config/tele-downloader/` (macOS: `~/Library/Application Support/tele-downloader`, Windows: `%APPDATA%\tele-downloader`; đổi bằng `TDL_DATA_DIR=...`), thư mục quyền 700, file quyền 600. Nhờ vậy dù thư mục dự án bị phục vụ (Live Server, `npx serve`), đẩy lên Git hay upload đi đâu, phiên Telegram cũng không lộ. Phiên bản cũ để các file này trong thư mục dự án sẽ được tự chuyển sang khi khởi động.
- Body request giới hạn 1MB; lỗi ở một request không làm sập server.

Giữ bí mật `session.txt` và `.ui-token` (trong thư mục dữ liệu riêng ở trên) — ai có chúng là truy cập được tài khoản Telegram của bạn. Nếu nghi bị lộ: Telegram → Cài đặt → Thiết bị → kết thúc phiên của tool, rồi đăng nhập lại.

## Test

```bash
npm test            # toàn bộ (unit + API + tải thật 1 file nhỏ qua Telegram)
npm run test:unit   # chỉ unit test, không cần mạng / tài khoản
```

Phần test Telegram dùng `session.txt` hiện có (tự bỏ qua nếu chưa đăng nhập), tải 1 file nhạc nhỏ nhất (≤ 60MB) vào thư mục tạm rồi xoá — không đụng tới `downloads/`. Chọn kênh test bằng `TEST_CHAT=<username|id> npm test`.

Test dùng `settings.json` / `history.json` riêng trong thư mục tạm, không đụng tới cài đặt và lịch sử thật.
