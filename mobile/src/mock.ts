// Sample data to look at the screens without Telegram (EXPO_PUBLIC_MOCK=1, e.g. the web render used to compare
// the app with the web version side by side). Off in real builds: the branches using it are dropped.
import type { Chat, Song } from "./telegram/library";

export const MOCK = process.env.EXPO_PUBLIC_MOCK === "1";

/** ?mock=out / ?step=code… on the web render picks the state to show. */
export const mockParam = (name: string) =>
  typeof location !== "undefined" ? new URLSearchParams(location.search).get(name) : null;

export const MOCK_ME = {
  id: "6123456789",
  firstName: "Nguyễn Thanh",
  lastName: "Tuấn",
  username: "tuannt",
  phone: "84912345678",
};

export const MOCK_CHATS: Chat[] = [
  { id: "-1001", rawId: "1001", title: "mixtape house lak 420", type: "channel", username: "nhacvuive", photo: "11" },
  {
    id: "-1002",
    rawId: "1002",
    title: "Nhạc Remix | Vinahouse | DJ",
    type: "channel",
    username: "VNMusicRemix",
    photo: "22",
  },
  {
    id: "-1003",
    rawId: "1003",
    title: "Cung Cấp Nhạc cho DJ đi làm ✈️",
    type: "channel",
    username: "cungcapnhacchodj",
  },
  { id: "-1004", rawId: "1004", title: "Nhạc Việt Nam Lossless 🎶", type: "channel", username: "nhacvietnamlossless" },
  { id: "-1005", rawId: "1005", title: "KÊNH NHẠC HAY PHIÊU :))", type: "channel", username: "NHACCUATUI23T" },
  { id: "-1006", rawId: "1006", title: "Nhóm bạn thân", type: "group", username: null },
  { id: "777", rawId: "777", title: "Tuấn Nguyễn", type: "user", username: "tuannt", photo: "77" }, // no picture loads
];

/** Chat pictures of the sample chats (gradient circles), as Telegram's would come. */
const mockPhoto = (a: string, b: string) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><circle cx="80" cy="64" r="30" fill="#fff" opacity=".85"/><rect x="34" y="104" width="92" height="40" rx="20" fill="#fff" opacity=".85"/></svg>`,
  )}`;
export const MOCK_PHOTOS: Record<string, string> = {
  "-1001": mockPhoto("#0ea5e9", "#22c55e"),
  "-1002": mockPhoto("#f43f5e", "#a855f7"),
};

const song = (id: number, name: string, duration: number, size: number, extra: Partial<Song> = {}): Song => ({
  id,
  key: `1001|${id}`,
  chatId: "-1001",
  name,
  title: name,
  duration,
  size,
  date: 1760000000 - id * 10000,
  kind: "audio",
  ...extra,
});

export const MOCK_SONGS: Song[] = [
  song(11, "Stitches...!@ - TienNguyen x KenD.mp3", 3983, 159383552),
  song(12, "LEW IN THE HOUSE VOL.1.mp3", 3538, 141557760),
  song(13, "Mixtape - A Huu Mui Vol2 - Đat Myn .mp3", 5577, 222298112, {
    title: "Mixtape - A Huu Mui Vol2 - Dat Myn",
    performer: "Dat Myn",
  }),
  song(14, "7 TIẾNG LAK NƯỚC DATMYN.mp3", 25319, 1012002816),
  song(15, "Nhạc iTV - TienNguyen.mp3", 4240, 169607168),
  song(16, "Em Chi La Nguoi Thay The - DatKon & TienNguyen.mp3", 3190, 127610880),
];
