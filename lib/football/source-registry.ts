import { z } from 'zod';
import { LeagueSchema, type League } from './shared.ts';
import data from './source-registry.json' with { type: 'json' };

const BrowserCategorySchema=z.object({
  league:LeagueSchema,url:z.string().url(),pathCode:z.string().regex(/^[a-z0-9-]+$/).nullable(),
  espnPath:z.string().optional(),emptyTitles:z.array(z.string()).optional(),
}).strict();
const SourceSchema=z.object({
  id:z.string(),url:z.string().url(),family:z.string(),name:z.string().optional(),
  kind:z.enum(['catalog','pending','browser-catalog']).optional(),
  publicUrls:z.array(z.string().url()).optional(),parserVersion:z.number().int().positive().optional(),
  leagues:z.array(LeagueSchema).nonempty(),browserCategories:z.array(BrowserCategorySchema).optional(),
  undatedListingEvidence:z.literal('published-listing').optional(),
}).strict();

export const SOURCE_REGISTRY=z.array(SourceSchema).parse(data);
const sourcesById=new Map(SOURCE_REGISTRY.map(source=>[source.id,source]));

export function sourceCoverage(sourceId:string):readonly League[] {
  return sourcesById.get(sourceId)?.leagues || [];
}

export function listingEventEvidence(sourceId:string):{undated:'none'|'published-listing';externalGameId:null} {
  return {undated:sourcesById.get(sourceId)?.undatedListingEvidence||'none',externalGameId:null};
}

export function browserCategory(sourceId:string,league:string) {
  return sourcesById.get(sourceId)?.browserCategories?.find(category=>category.league===league);
}
