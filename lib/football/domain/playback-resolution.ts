import type {CandidateLocator} from '../shared.ts';

export function playbackResolution(locator:CandidateLocator):'http'|'browser' {
  switch(locator.provider){
    case 'gooz':case 'swac':case 'streamcenter':case 'streameast':case 'wikisport':return 'http';
    case 'sportsurge-v2':case 'streameast-server':case 'event-page':case 'tvapp':case 'catalog-stream':return 'browser';
  }
}
