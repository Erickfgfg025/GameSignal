// supabase/functions/check-prices/handler.ts
// Porta de app/worker.py para o modelo de watchlist: 1 consulta ao ITAD por
// jogo monitorado (não por usuário — seção 15 do prompt), grava no cache,
// avalia e manda os alertas via alertEngine. Separado de index.ts pelo
// mesmo motivo do telegram-webhook: testável sem Deno.serve nem env reais.
import * as db from "../_shared/db.ts";
import { evaluateGame, sendDecisions } from "../_shared/alertEngine.ts";
import { ItadError } from "../_shared/itad.ts";
import type { GameLookup, ItadLike } from "../_shared/itad.ts";
import type { TelegramLike } from "../_shared/telegram.ts";

export interface CheckPricesDeps {
  supabase: db.DB;
  itad: Pick<ItadLike, "gamePrices">;
  telegram: TelegramLike;
  cronSecret: string;
  alertRetentionDays?: number;
}

export interface CheckPricesSummary {
  gamesChecked: number;
  gamesFailed: number;
  alertsSent: number;
  usersDeactivated: number;
  firstRun: boolean;
}

export function createCheckPricesHandler(deps: CheckPricesDeps) {
  const { supabase, itad, telegram, cronSecret, alertRetentionDays = 30 } = deps;

  return async function handleRequest(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (req.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("unauthorized", { status: 401 });
    }

    let lockToken: string | null = null;
    let runId: string | null = null;
    try {
      lockToken = await db.tryAcquireJobLock(supabase, "check-prices", 600);
      if (!lockToken) {
        return new Response(JSON.stringify({ skipped: true, reason: "cycle_already_running" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }

      runId = await db.startJobRun(supabase, "check-prices");
      const summary = await runCycle();
      await db.finishJobRun(supabase, runId, {
        status: summary.gamesFailed > 0 ? "failed" : "success",
        gamesChecked: summary.gamesChecked,
        gamesFailed: summary.gamesFailed,
        alertsSent: summary.alertsSent,
        usersDeactivated: summary.usersDeactivated,
        errorMessage: summary.gamesFailed > 0 ? summary.gamesFailed + " jogo(s) falharam na consulta de preços." : null,
      });
      return new Response(JSON.stringify(summary), {
        status: 200, headers: { "content-type": "application/json" },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
      if (runId) {
        try {
          await db.finishJobRun(supabase, runId, { status: "failed", errorMessage });
        } catch (finishError) {
          console.error("check-prices: não foi possível registrar a falha", finishError instanceof Error ? finishError.message : "erro");
        }
      }
      console.error("check-prices: falha no ciclo", errorMessage);
      return new Response(JSON.stringify({ error: "check-prices failed" }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    } finally {
      if (lockToken) {
        try {
          await db.releaseJobLock(supabase, "check-prices", lockToken);
        } catch (releaseError) {
          console.error("check-prices: não foi possível liberar o lock", releaseError instanceof Error ? releaseError.message : "erro");
        }
      }
    }
  };

  async function runCycle(): Promise<CheckPricesSummary> {
    const firstRun = !(await db.hasAnyPriceCache(supabase));
    const { idBySlug } = await db.getStores(supabase);
    const games = await db.distinctWatchedGames(supabase);
    console.log(`check-prices: ${games.length} jogo(s) monitorado(s), firstRun=${firstRun}`);

    let alertsSent = 0, usersDeactivated = 0, gamesFailed = 0;
    for (const game of games) {
      let lookup: GameLookup | null;
      try {
        lookup = await (itad.monitorGamePrices ? itad.monitorGamePrices(game.itad_id) : itad.gamePrices(game.itad_id));
      } catch (err) {
        gamesFailed++;
        console.error(`check-prices: falha ao consultar ${game.title} (${game.itad_id}):`, err instanceof ItadError ? err.message : err);
        if (err instanceof ItadError && err.kind === "auth") throw err; // chave inválida: para tudo, não adianta insistir por jogo
        continue;
      }
      if (lookup === null || lookup.prices.length === 0) continue;

      await db.upsertPriceCache(supabase, idBySlug, lookup.prices.map((p) => ({
        gameId: game.id, storeSlug: p.store, priceCents: p.priceCents, regularCents: p.regularCents,
        discountPercent: p.cut, currency: p.currency, url: p.url,
      })));
      await db.updateGameHistoryLow(supabase, game.id, lookup.historyLowCents, lookup.prices[0]?.currency ?? null);

      if (firstRun) continue; // seção 24: 1º ciclo só popula, não avisa ninguém

      const watchers = await db.usersWatchingGame(supabase, game.id);
      const decisions = evaluateGame(game.title, { ...lookup, gameId: game.id }, watchers);
      const result = await sendDecisions(supabase, telegram, game.title, decisions);
      alertsSent += result.sent;
      usersDeactivated += result.deactivated;
    }

    await db.cleanupOldAlerts(supabase, alertRetentionDays);
    return { gamesChecked: games.length, gamesFailed, alertsSent, usersDeactivated, firstRun };
  }
}
