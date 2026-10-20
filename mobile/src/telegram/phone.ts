// Phone numbers, the same way as the web's sign-in (public/js/ui.js): the country code is picked in front
// (+84 by default), the field holds the rest.

export type Country = { code: string; cc: string; name: string }; // name: Vietnamese, translated where shown

export const COUNTRIES: Country[] = [
  { code: "84", cc: "vn", name: "Việt Nam" },
  { code: "1", cc: "us", name: "Mỹ / Canada" },
  { code: "44", cc: "gb", name: "Anh" },
  { code: "61", cc: "au", name: "Úc" },
  { code: "65", cc: "sg", name: "Singapore" },
  { code: "66", cc: "th", name: "Thái Lan" },
  { code: "81", cc: "jp", name: "Nhật Bản" },
  { code: "82", cc: "kr", name: "Hàn Quốc" },
  { code: "86", cc: "cn", name: "Trung Quốc" },
  { code: "852", cc: "hk", name: "Hồng Kông" },
  { code: "855", cc: "kh", name: "Campuchia" },
  { code: "856", cc: "la", name: "Lào" },
  { code: "886", cc: "tw", name: "Đài Loan" },
  { code: "33", cc: "fr", name: "Pháp" },
  { code: "49", cc: "de", name: "Đức" },
  { code: "7", cc: "ru", name: "Nga" },
];

export const countryOf = (code: string) => COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];

/** 🇻🇳 from "vn" (the two regional-indicator letters). */
export const flag = (cc: string) =>
  String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

/**
 * "+<code><number>" from what was typed. Accepts the usual ways of writing it: with the national
 * leading 0 (0912 345 678), with spaces/dots/dashes, or pasted with the country code (+84912..., 84912...).
 * Returns null when it cannot be a phone number.
 */
export function composePhone(code: string, typed: string): string | null {
  let digits = String(typed || "").replace(/[\s.\-()]/g, "");
  if (digits.startsWith("+")) {
    digits = digits.slice(1);
    if (digits.startsWith(code))
      digits = digits.slice(code.length); // pasted with the same country code
    else return /^\d{7,15}$/.test(digits) ? `+${digits}` : null; // another country's full number
  } else if (digits.startsWith("00" + code)) {
    digits = digits.slice(2 + code.length);
  } else if (digits.startsWith(code) && digits.length - code.length >= 8) {
    digits = digits.slice(code.length); // typed the code again without "+"
  }
  digits = digits.replace(/^0+/, ""); // national trunk prefix: 0382... -> 382...
  if (!/^\d+$/.test(digits)) return null;
  const total = code.length + digits.length;
  if (digits.length < 6 || total > 15) return null;
  if (code === "84" && digits.length !== 9) return null; // Vietnamese mobile numbers: +84 + 9 digits
  return `+${code}${digits}`;
}

export const phoneMessage = (code: string) =>
  code === "84"
    ? "Số điện thoại Việt Nam gồm 9 số sau +84 (có thể gõ kèm số 0 ở đầu, vd 0912 345 678)."
    : "Số điện thoại không hợp lệ.";
