import type {StreameastCatalogView} from '../lib/football/shared.ts';

type Listing=StreameastCatalogView['games'][number];
type Collected=Extract<Listing['detail'],{kind:'collected'}>;

export function retainedStreameastDetail(current:Listing,history:readonly Listing[]):Collected|null {
  if(!current.gameId||current.detail.kind==='collected')return null;
  let newest:Collected|null=null;
  for(const prior of history) {
    const detail=prior.detail;
    if(prior.id!==current.id||prior.url!==current.url||prior.league!==current.league||
      prior.gameId!==current.gameId||detail.kind!=='collected')continue;
    if(!newest||detail.at>newest.at)newest=detail;
  }
  return newest;
}
