// Fonte complementar da Hype Games via páginas públicas. Mantém timeouts,
// restringe URLs à loja oficial e limita consultas paralelas.
import type { Offer, StorePrice } from "./itad.ts";
const BASE="https://hype.games";
const HEADERS={"accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","accept-language":"pt-BR,pt;q=0.9,en;q=0.8","user-agent":"GameSignal/1.1 (+https://t.me/GameSignalAlertBot)"};
export interface HypeLike{findProduct(q:string,opts?:{allowSearch?:boolean}):Promise<StorePrice|null>;fetchOffers():Promise<Offer[]>}
export class HypeError extends Error{constructor(m:string){super(m);this.name="HypeError";}}
type Product={title:string;price:StorePrice;imageUrl:string|null};
function norm(s:string){return s.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");}
function score(a:string,b:string){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 1;if(b.includes(a))return .94;if(a.includes(b))return .86;const x=a.split(" ").filter(t=>t.length>1),y=new Set(b.split(" "));return x.length?x.filter(t=>y.has(t)).length/x.length:0;}
function text(s:string){return s.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;|&#x27;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim();}
function prices(s:string){return [...new Set([...s.matchAll(/R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+,[0-9]{2})/g)].map(m=>Math.round(Number(m[1].replace(/\./g,"").replace(",", "."))*100)).filter(n=>Number.isSafeInteger(n)&&n>0))];}
function links(html:string,max=10){const out=new Set<string>(),re=/(?:href|content)=["'](https:\/\/hype\.games\/br\/product\/[^"'#?]+|\/br\/product\/[^"'#?]+)["']/gi;for(const m of html.matchAll(re)){try{const u=new URL(m[1],BASE);if(u.protocol==="https:"&&u.hostname==="hype.games"&&u.pathname.startsWith("/br/product/"))out.add(u.href);}catch{}if(out.size>=max)break;}return [...out];}
function product(html:string,url:string):Product|null{
 const raw=html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]??html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
 const title=raw?text(raw).replace(/\s*\|\s*Hype Games.*$/i,"").trim():"";if(!title)return null;
 const body=text(html),platform=body.match(/Plataforma\s*:?\s*([^|]{1,60}?)(?=Ativa[cç][aã]o|Confira|D[úu]vidas|$)/i)?.[1]?.trim()??"";
 if(!platform||!/(steam|pc)/i.test(platform))return null;
 const start=Math.max(0,body.toLowerCase().indexOf(title.toLowerCase())),pi=body.search(/Plataforma\s*:?\b/i),end=pi>start?pi:Math.min(body.length,start+2200),vals=prices(body.slice(start,end));if(!vals.length)return null;
 const current=Math.min(...vals),regular=Math.max(...vals),cut=regular>current?Math.min(100,Math.round((1-current/regular)*100)):0;
 const canonical=html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]??url;
 let finalUrl=url;try{const u=new URL(canonical,BASE);if(u.protocol==="https:"&&u.hostname==="hype.games"&&u.pathname.startsWith("/br/product/"))finalUrl=u.href;}catch{}
 const ir=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]??html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]??null;
 let imageUrl:string|null=null;try{if(ir&&ir.length<2048){const u=new URL(ir,BASE);if(u.protocol==="https:")imageUrl=u.href;}}catch{}
 return {title,price:{store:"hype",priceCents:current,regularCents:regular,cut,currency:"BRL",url:finalUrl},imageUrl};
}
async function batches<T>(items:T[],size:number,fn:(v:T)=>Promise<Product|null>){const out:PromiseSettledResult<Product|null>[]=[];for(let i=0;i<items.length;i+=size)out.push(...await Promise.allSettled(items.slice(i,i+size).map(fn)));return out;}
export class HypeClient implements HypeLike{
 private fetcher:typeof fetch;private cache=new Map<string,{until:number;value:StorePrice|null}>();
 constructor(fetcher:typeof fetch=fetch){this.fetcher=fetcher;}
 private async html(raw:string):Promise<string|null>{let u:URL;try{u=new URL(raw);}catch{throw new HypeError("URL inválida");}if(u.protocol!=="https:"||u.hostname!=="hype.games")throw new HypeError("URL externa bloqueada");let r:Response;try{r=await this.fetcher(u.href,{headers:HEADERS,signal:AbortSignal.timeout(3000)});}catch(e){throw new HypeError("consulta Hype falhou ("+(e instanceof Error?e.constructor.name:"erro")+")");}if(r.status===404)return null;if(!r.ok)throw new HypeError("Hype Games respondeu HTTP "+r.status);return r.text();}
 private async fetchProduct(url:string){const h=await this.html(url);return h?product(h,url):null;}
 async findProduct(query:string,opts:{allowSearch?:boolean}={}):Promise<StorePrice|null>{
  const key=norm(query).slice(0,120),allowSearch=opts.allowSearch!==false;
  if(!key)return null;
  const cacheKey=(allowSearch?"full:":"direct:")+key,c=this.cache.get(cacheKey);
  if(c&&c.until>Date.now())return c.value;
  const direct=await this.fetchProduct(BASE+"/br/product/"+norm(query).replace(/\s+/g,"-").slice(0,140));
  if(direct&&score(query,direct.title)>=.80){
    const found=direct.price,until=Date.now()+25*60*1000;
    this.cache.set(cacheKey,{until,value:found});
    this.cache.set("direct:"+key,{until,value:found});
    this.cache.set("full:"+key,{until,value:found});
    return found;
  }
  if(!allowSearch){
    this.cache.set(cacheKey,{until:Date.now()+20*60*1000,value:null});
    return null;
  }
  const search=await this.html(BASE+"/br/busca/game/"+encodeURIComponent(query.slice(0,100)));
  if(!search){this.cache.set(cacheKey,{until:Date.now()+5*60*1000,value:null});return null;}
  const found=(await batches(links(search,4),3,u=>this.fetchProduct(u)))
    .filter((x):x is PromiseFulfilledResult<Product|null>=>x.status==="fulfilled")
    .map(x=>x.value).filter((x):x is Product=>!!x);
  const sorted=found.map(v=>({p:v,s:score(query,v.title)})).sort((a,b)=>b.s-a.s),a=sorted[0],b=sorted[1];
  const value=a&&a.s>=.80&&(!b||a.s-b.s>=.10)?a.p.price:null;
  this.cache.set(cacheKey,{until:Date.now()+5*60*1000,value});
  return value;
 }
 async fetchOffers():Promise<Offer[]>{const h=await this.html(BASE+"/br/steam-pc");if(!h)return [];const found=(await batches(links(h,12),3,u=>this.fetchProduct(u))).filter((x):x is PromiseFulfilledResult<Product|null>=>x.status==="fulfilled").map(x=>x.value).filter((x):x is Product=>!!x&&x.price.cut>0);
  return found.map(p=>({gameId:p.price.url,title:p.title,store:"hype",priceCents:p.price.priceCents,regularCents:p.price.regularCents,cut:p.price.cut,currency:"BRL",url:p.price.url,historyLowCents:null,expiry:null,imageUrl:p.imageUrl}));
 }
}
