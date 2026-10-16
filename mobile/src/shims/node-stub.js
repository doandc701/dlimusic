// Empty stand-ins for Node built-ins that GramJS only needs for TCP sockets / file sessions; the app talks
// to Telegram over WebSocket instead (same as the web build's web/stubs.js).
module.exports = {};
module.exports.type = () => "ReactNative";
module.exports.release = () => "app";
module.exports.platform = () => "react-native";
module.exports.hostname = () => "app";
