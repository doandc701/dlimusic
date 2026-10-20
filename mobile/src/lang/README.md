# Ngôn ngữ của app DLiMusic

Mỗi ngôn ngữ là một file trong thư mục này. Mọi chữ trong code đều viết bằng tiếng Việt; file ngôn ngữ cho biết mỗi
câu tiếng Việt đổi thành gì.

| File       | Ngôn ngữ                                       |
| ---------- | ---------------------------------------------- |
| `vi.ts`    | Tiếng Việt (gốc, không cần dịch)               |
| `en.ts`    | English (danh sách câu chuẩn)                  |
| `zh.ts`    | 中文 (giản thể)                                |
| `ja.ts`    | 日本語                                         |
| `index.ts` | danh sách ngôn ngữ, theo thứ tự hiện trong app |

## Thêm một ngôn ngữ (ví dụ tiếng Hàn `ko`)

1. Chép `zh.ts` thành `ko.ts` (file này đã có sẵn kiểu `Translation`, nên typecheck báo câu thiếu).
2. Sửa phần đầu:
   ```ts
   label: "한국어",   // tên trong danh sách, viết bằng chính ngôn ngữ đó
   locale: "ko-KR",  // định dạng ngày giờ
   ```
3. Dịch **vế phải** của từng dòng trong `dict`. Vế trái (tiếng Việt) giữ nguyên từng chữ.
   - `{n}`, `{name}`… là giá trị được điền vào: giữ nguyên trong bản dịch (đổi chỗ được).
   - `{n|file|files}` (số ít | số nhiều) chỉ cần cho ngôn ngữ có số nhiều.
4. Thêm vào `index.ts`:
   ```ts
   import ko from "./ko";
   export const LANG_FILES = { vi, en, zh, ja, ko };
   ```
5. Chạy `npx tsc --noEmit`: báo câu nào còn thiếu hoặc thừa so với `en.ts`.

Không cần sửa gì khác: Cài đặt và nút chọn ngôn ngữ ở màn đăng nhập tự có ngôn ngữ mới.

## Thêm một câu mới vào app

Viết câu tiếng Việt trong code với `tr("…")` (trong component) hoặc `t("…")` (ngoài component), rồi thêm câu đó
cùng bản dịch vào `en.ts` và **mọi** file ngôn ngữ khác (trừ `vi.ts`). Typecheck sẽ báo file nào thiếu.
