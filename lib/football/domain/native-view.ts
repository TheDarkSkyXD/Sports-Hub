import {pipelineView} from '../../../native/collector/bridge.cjs';
import type {z} from 'zod';

export function nativeView<S extends z.ZodTypeAny>(operation:string,input:unknown,schema:S):z.output<S> {
  return schema.parse(JSON.parse(pipelineView(operation,JSON.stringify(input))));
}
