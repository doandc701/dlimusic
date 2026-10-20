# Ngôn ngữ của giao diện web

Mỗi ngôn ngữ là một file trong thư mục này. Giao diện, `ui.js` và server đều viết bằng tiếng Việt; file ngôn ngữ
cho biết mỗi câu tiếng Việt đổi thành gì.

| File    | Ngôn ngữ                         |
| ------- | -------------------------------- |
| `vi.js` | Tiếng Việt (gốc, không cần dịch) |
| `en.js` | English                          |
| `zh.js` | 中文 (giản thể)                  |
| `ja.js` | 日本語                           |

## Thêm một ngôn ngữ (ví dụ tiếng Hàn `ko`)

1. Chép `en.js` thành `ko.js`.
2. Trong `ko.js`, đổi dòng `(window.TDL_LANGS ||= {}).en` thành `.ko`, rồi sửa phần đầu:
   ```js
   code: "한",        // chữ hiện trên nút chọn ngôn ngữ (1–2 ký tự)
   name: "한국어",     // tên trong menu, viết bằng chính ngôn ngữ đó
   locale: "ko-KR",   // định dạng ngày giờ
   html: "ko",        // <html lang>
   ```
3. Dịch **vế phải** của từng dòng trong `dict`. Vế trái (tiếng Việt) giữ nguyên từng chữ, đó là câu cần tìm.
   - `{n}`, `{name}`… là giá trị được điền vào: giữ nguyên trong bản dịch (đổi chỗ được).
   - `{n|file|files}` (số ít | số nhiều) chỉ cần cho ngôn ngữ có số nhiều; ngôn ngữ khác viết thẳng, ví dụ `{n} 개 파일`.
4. Thêm một dòng vào `public/index.html`, cạnh các dòng ngôn ngữ khác (trước `js/i18n.js`):
   ```html
   <script src="js/lang/ko.js"></script>
   ```
   Thứ tự các dòng này là thứ tự trong menu.
5. Chạy `npm run test:unit`: test báo câu nào còn thiếu hoặc sai `{…}` so với `en.js`.

Không cần sửa gì khác: menu tự có ngôn ngữ mới, server và bản build web tự phục vụ file mới.
Câu nào chưa dịch sẽ hiện tiếng Việt.

## Thêm một câu mới vào giao diện

Viết câu tiếng Việt trong `index.html` / `ui.js` như bình thường (câu có giá trị: `t("Đã huỷ {n} file", { n })`), rồi
thêm câu đó cùng bản dịch vào **mọi** file ngôn ngữ (trừ `vi.js`). Test sẽ báo nếu thiếu.
