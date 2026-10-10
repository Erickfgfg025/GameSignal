// Porta de app/notifier.py, adaptada ao novo modelo: 1 consulta ao ITAD por
// jogo (não por usuário), e dedupe/idempotência resolvidos no Postgres via
// db.recordAlertIfNew (INSERT ... ON CONFLICT DO NOTHING), não em memória.
//
// Regra preservada da seção 4 do prompt:
//   preço não atende condição -> não alerta
//   preço entra na condição   -> alerta (alert_key inclui o preço: uma nova
//                                 chave por preço novo, então voltar ao MESMO
//                                 preço de antes não repete o aviso, mas cair
//                                 num preço diferente sempre gera um novo)
import type { DB, UserGameRow, TelegramUserRow } from "./db.ts";
import * as db from "./db.ts";
import type { GameLookup, StoreKey, StorePrice } from "./itad.ts";
import { watchAlertKeyboard, watchAlertText } from "./format.ts";
import { isFatalForUser, type TelegramLike } from "./telegram.ts";

export interface WatchDecision {
  userGame: UserGameRow & { telegram_users: TelegramUserRow };
  price: StorePrice;
  alertKey: string;
}

/** Decide, para 1 jogo, quais watchers (user_games) devem ser avisados com o
 * preço atual. Não toca o banco — função pura, fácil de testar. */
export function evaluateGame(gameTitle: string, lookup: GameLookup, watchers: (UserGameRow & { telegram_users: TelegramUserRow })[]): WatchDecision[] {
  const decisions: WatchDecision[] = [];
  if (lookup.prices.length === 0) return decisions;

  for (const watcher of watchers) {
    if (!watcher.notify_enabled || !watcher.telegram_users.active) continue;
    // O alvo pode ser atendido em uma loja diferente da menor oferta geral.
    // Mantém a semântica OR quando ambos os critérios estão configurados.
    const qualifying = lookup.prices.filter((price) =>
      (watcher.target_price_cents !== null && price.priceCents <= watcher.target_price_cents) ||
      (watcher.target_discount !== null && price.cut >= watcher.target_discount) ||
      (watcher.target_price_cents === null && watcher.target_discount === null && price.cut > 0)
    );
    if (qualifying.length === 0) continue;
    const best = qualifying.reduce((a, b) =>
      b.priceCents < a.priceCents || (b.priceCents === a.priceCents && b.cut > a.cut) ? b : a
    );
    const alertKey = lookup.gameId + ":" + best.store + ":" + best.priceCents;
    decisions.push({ userGame: watcher, price: best, alertKey });
  }
  return decisions;
}

export interface SendResult { sent: number; deactivated: number }

/** Persiste o dedupe (atômico) e manda a mensagem. Se o envio falhar por um
 * motivo transitório, a chave é liberada (db.releaseAlert) para uma nova
 * tentativa no próximo ciclo — só fica definitivamente marcada quando o
 * envio realmente sai. Falha ao enviar para 1 usuário nunca impede os
 * demais (mesma regra do notifier.py antigo). */
export async function sendDecisions(conn: DB, telegram: TelegramLike, gameTitle: string, decisions: WatchDecision[]): Promise<SendResult> {
  let sent = 0, deactivated = 0;
  for (const decision of decisions) {
    const isNew = await db.recordAlertIfNew(conn, decision.userGame.telegram_user_id, decision.userGame.game_id, decision.alertKey);
    if (!isNew) continue; // já avisamos essa combinação de jogo+loja+preço antes
    try {
      const chatId = decision.userGame.telegram_users.telegram_id;
      await telegram.sendMessage(chatId, watchAlertText(gameTitle, decision.price, decision.userGame.target_price_cents), {
        replyMarkup: watchAlertKeyboard(decision.price),
      });
      sent++;
    } catch (err) {
      if (isFatalForUser(err)) {
        await db.setUserActive(conn, decision.userGame.telegram_user_id, false);
        deactivated++;
        // usuário desativado: não há próxima tentativa mesmo, então não
        // precisa liberar a chave — mas não custa manter o dado consistente.
      } else {
        // erro transitório (rede, rate limit): libera a chave para o
        // próximo ciclo tentar de novo, em vez de suprimir o alerta pra
        // sempre — mesma postura de "retry" do notifier.py antigo.
        await db.releaseAlert(conn, decision.userGame.telegram_user_id, decision.alertKey);
      }
    }
  }
  return { sent, deactivated };
}
