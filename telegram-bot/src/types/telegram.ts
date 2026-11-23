export interface TelegramContext {
    from?: {
        id: number;
        first_name: string;
        last_name?: string;
        username?: string;
    };
    chat?: { 
        id: number;
        type: 'private' | 'group' | 'supergroup' | 'channel';
    };
    message?: {
        message_id: number;
        text?: string;
    };
    callbackQuery?: {
        id: string;
        data?: string;
    };
    updateType: string;
    reply(text: string, extra?: Record<string, unknown>): Promise<unknown>;
    deleteMessage(messageId: number): Promise<boolean>;
    answerCbQuery(text?: string): Promise<boolean>;
    editMessageReplyMarkup(replyMarkup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }): Promise<unknown>;
}