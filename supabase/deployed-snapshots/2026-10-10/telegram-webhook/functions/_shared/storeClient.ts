// Compõe ITAD e Hype sem fazer a falha de uma fonte derrubar a outra.
import type {GameLookup,ItadLike,ItadStoreKey,Offer,StorePrice} from "./itad.ts";
import {HypeClient,type HypeLike} from "./hype.ts";
export class StoreClient implements ItadLike{
 private itad:ItadLike;private hype:HypeLike;private titles=new Map<string,string|null>();
 constructor(itad:ItadLike,hype:HypeLike=new HypeClient()){this.itad=itad;this.hype=hype;}
 resolveShops():Promise<Record<ItadStoreKey,number>>{return this.itad.resolveShops();}
 async fetchOffers():Promise<Offer[]> {
  const [itadResult, hypeResult] = await Promise.allSettled([
    this.itad.fetchOffers(),
    this.hype.fetchOffers(),
  ]);
  const offers: Offer[] = [];
  if (itadResult.status === "fulfilled") offers.push(...itadResult.value);
  if (hypeResult.status === "fulfilled") offers.push(...hypeResult.value);

  // A successfully queried source may legitimately have no matching offers.
  // It must not be treated as total failure just because the other source failed.
  if (itadResult.status === "fulfilled" || hypeResult.status === "fulfilled") return offers;
  throw itadResult.reason;
 }
 searchTitles(q:string,n?:number){return this.itad.searchTitles(q,n);}
 gameTitle(id:string){return this.itad.gameTitle(id);}
 private async pricesFor(id:string,allowSearch:boolean):Promise<GameLookup|null>{
  const g=await this.itad.gamePrices(id);if(!g)return null;
  let title=this.titles.get(id);if(title===undefined){title=await this.itad.gameTitle(id);this.titles.set(id,title);}
  if(!title)return g;
  let p:StorePrice|null=null;
  try{p=await this.hype.findProduct(title,{allowSearch});}
  catch(e){console.warn("Hype Games indisponível nesta consulta",e instanceof Error?e.message:"erro");}
  return p?{...g,prices:[...g.prices,p]}:g;
 }
 gamePrices(id:string):Promise<GameLookup|null>{return this.pricesFor(id,true);}
 monitorGamePrices(id:string):Promise<GameLookup|null>{return this.pricesFor(id,false);}
}
