import {z} from 'zod';
import {MediaDeferralReasonSchema,MediaFailureReasonSchema,MediaPhaseSchema,MediaTimingsSchema} from '../shared.ts';
import {FeedOwnerSchema} from './working-feed.ts';

export const FEED_CHECK_RETENTION_MS=24*3600000;
export const INCOMPLETE_RETRY_DELAYS=[30000,60000,120000,300000,600000];
const OutcomeBase=z.object({checkedAt:z.number().int().nonnegative(),retryAt:z.number().int().nonnegative(),
  phase:MediaPhaseSchema.optional(),timings:MediaTimingsSchema.optional()});
export const FeedCheckSchema=z.object({
  version:z.literal(1),gameId:z.string().min(1),gameDate:z.string().nullable(),
  identityHash:z.string().regex(/^[a-f0-9]{64}$/),owner:FeedOwnerSchema,
  outcome:z.discriminatedUnion('kind',[
    OutcomeBase.extend({kind:z.literal('unavailable'),reason:MediaFailureReasonSchema}).strict(),
    OutcomeBase.extend({kind:z.literal('incomplete'),incompleteAttempts:z.number().int().min(1).max(INCOMPLETE_RETRY_DELAYS.length),
      reason:MediaDeferralReasonSchema.exclude(['capacity','cancelled']).optional()}).strict(),
  ]),
}).strict();
export type FeedCheck=z.infer<typeof FeedCheckSchema>;
