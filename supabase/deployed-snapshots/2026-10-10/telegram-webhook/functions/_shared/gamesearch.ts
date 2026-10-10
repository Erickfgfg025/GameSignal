// Porta de app/gamesearch.py. Decide, entre os resultados de busca do ITAD,
// qual jogo o usuário provavelmente quis dizer — sem chamada externa nem
// custo extra: comparação de texto (mesmo algoritmo de similaridade usado
// no bot em Python) mais o fato de a própria busca do ITAD já tolerar
// pequenas variações no texto digitado.

export const CONFIDENT_SCORE = 0.5; // abaixo disso, não escolhe sozinho
export const CONFIDENT_MARGIN = 0.15; // precisa estar isso à frente do 2º colocado
export const MAX_CANDIDATES = 5;

export interface SearchHit {
  id: string;
  title: string;
  type: string | null;
}

export interface Candidate {
  score: number;
  gameId: string;
  title: string;
  isGame: boolean;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ").trim().replace(/\s+/g, " ");
}

export function isExact(query: string, title: string): boolean {
  return normalize(query) === normalize(title);
}

/** Similaridade por distância de edição (Levenshtein), normalizada entre 0 e 1.
 * Não precisa ser idêntica ao difflib.SequenceMatcher do Python — só precisa
 * dar nota alta para strings parecidas e baixa para strings bem diferentes,
 * o que essa distância clássica já garante. */
function editRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, prev[j], prev[j - 1]);
      diag = temp;
    }
  }
  const distance = prev[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function score(query: string, title: string): number {
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return 0;
  let ratio = editRatio(q, t);
  if (t.includes(q) || q.includes(t)) ratio = Math.max(ratio, 0.85);
  const qWords = new Set(q.split(" "));
  const tWords = new Set(t.split(" "));
  if (qWords.size > 0 && [...qWords].every((w) => tWords.has(w))) ratio = Math.max(ratio, 0.8);
  return ratio;
}

export function rank(query: string, results: SearchHit[]): Candidate[] {
  const games = results.filter((r) => r.type === "game" && r.id && r.title);
  const pool = games.length > 0 ? games : results.filter((r) => r.id && r.title);
  return pool
    .map((r) => ({ score: score(query, r.title), gameId: r.id, title: r.title, isGame: r.type === "game" }))
    .sort((a, b) => b.score - a.score);
}

/** Devolve o candidato certo quando há confiança suficiente para não perguntar; senão null. */
export function bestMatch(ranked: Candidate[]): Candidate | null {
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0].score >= 0.999 ? ranked[0] : null; // um resultado fraco ainda pode ser o jogo errado
  const [top, second] = ranked;
  if (top.score >= 0.999) return top; // bateu exatamente, mesmo com um 2º colocado parecido
  if (top.score >= CONFIDENT_SCORE && top.score - second.score >= CONFIDENT_MARGIN) return top;
  return null;
}
