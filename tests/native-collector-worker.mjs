import {parentPort,workerData} from 'node:worker_threads';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';

const url=SOURCES.find(source=>source.id==='nflstreams')?.url;
if(!url)throw new Error('Missing NFLStreams source');
const collector=createFixtureCollector();
collector.enqueueFixture({url,body:`worker-${workerData}`});
const body=await collector.readHtml(url,new AbortController().signal);
parentPort?.postMessage(body);
