// Cliente mínimo da Telegram Bot API. Sem SDK — é só fetch, exatamente o que
// uma Edge Function precisa. https://core.telegram.org/bots/api

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_markup?: InlineKeyboardMarkup;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramError extends Error {
  constructor(readonly errorCode: number, description: string) {
    super(description);
    this.name = "TelegramError";
  }
}

/** true = bloqueado ou chat inexistente (o notifier.py antigo tratava os dois
 * do mesmo jeito: desativa o usuário e segue para o próximo, sem derrubar o
 * envio para os demais). */
export function isFatalForUser(err: unknown): boolean {
  if (!(err instanceof TelegramError)) return false;
  const msg = err.message.toLowerCase();
  return err.errorCode === 403 || msg.includes("chat not found");
}

/** Só os métodos que o webhook e o check-prices realmente usam — permite
 * testar os dois com um Telegram falso, sem herdar de TelegramClient. */
export interface TelegramLike {
  sendMessage(chatId: number, text: string, opts?: { replyMarkup?: InlineKeyboardMarkup }): Promise<unknown>;
  sendChatAction(chatId: number, action?: string): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<unknown>;
}

export class TelegramClient implements TelegramLike {
  private readonly base: string;
  constructor(botToken: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  // deno-lint-ignore no-explicit-any
  private async call<T>(method: string, payload?: Record<string, any>): Promise<T> {
    const response = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await response.json();
    if (!body.ok) throw new TelegramError(body.error_code ?? response.status, body.description ?? "erro desconhecido");
    return body.result as T;
  }

  sendMessage(chatId: number, text: string, opts: { replyMarkup?: InlineKeyboardMarkup } = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: opts.replyMarkup,
    });
  }

  sendChatAction(chatId: number, action = "typing") {
    return this.call<true>("sendChatAction", { chat_id: chatId, action });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call<true>("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }

  editMessageText(chatId: number, messageId: number, text: string, opts: { replyMarkup?: InlineKeyboardMarkup } = {}) {
    return this.call<TgMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: opts.replyMarkup,
    });
  }

  getMe() {
    return this.call<TgUser>("getMe");
  }

  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<true>("setMyCommands", { commands });
  }

  /** Usado só pelo script de setup (uma vez), não pelas Edge Functions em produção. */
  setWebhook(url: string, secretToken: string) {
    return this.call<true>("setWebhook", { url, secret_token: secretToken, drop_pending_updates: false });
  }
}
