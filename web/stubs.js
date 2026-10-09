// Empty stand-ins for Node built-ins that GramJS only needs for TCP sockets / file sessions,
// neither of which is used in the browser (it talks to Telegram over WebSocket instead).
export default {};
export const type = () => "Browser";
export const release = () => (typeof navigator !== "undefined" ? navigator.userAgent : "web");
export const platform = () => "browser";
export const hostname = () => "web";
