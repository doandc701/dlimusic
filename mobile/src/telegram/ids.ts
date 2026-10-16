// "<chat id>|<message id>": a file's id in favourites and recent plays, the same as the web version's (the chat's
// own id, without the -100 / - of the list ids).
export const songKey = (chatId: string, msgId: number) => `${String(chatId).replace(/^-(100)?/, "")}|${msgId}`;
