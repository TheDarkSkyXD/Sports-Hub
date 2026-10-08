import type {StreameastCatalogView} from '../lib/football/shared.ts';

type Listing=StreameastCatalogView['games'][number];
type Collected=Extract<Listing['detail'],{kind:'collected'}>;

export function retainedStreameastDetail(current:Listing,history:readonly Listing[]):Collected|null {
  void current;
  void history;
  return null;
}
