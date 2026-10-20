import {pipelineDomain} from '../../../native/collector/bridge.cjs';
import type {z} from 'zod';

export function nativeDomain<T>(operation:string,args:readonly unknown[],schema:z.ZodType<T>):T {
  return schema.parse(JSON.parse(pipelineDomain(operation,JSON.stringify(args))));
}
