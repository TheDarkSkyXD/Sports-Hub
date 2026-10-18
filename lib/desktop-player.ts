import {z} from 'zod';
import {AdvancingVideoSchema} from './football/shared.ts';

export type PlayerLayout={capability:string;bounds?:{x:number;y:number;width:number;height:number};
  visible?:boolean;playing?:boolean;audible?:boolean;volume?:number;focused?:boolean;
  controls?:{label:string;fullscreen:boolean}|null};
export const QualityLevelIdSchema=z.string().min(1).max(128).brand<'QualityLevelId'>();
export const QualitySelectionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('auto')}).strict(),
  z.object({kind:z.literal('level'),id:QualityLevelIdSchema}).strict(),
]);
export const PlayerPresentationSchema=z.object({
  playing:z.boolean(),playback:z.enum(['live','vod','unknown']),
  pip:z.discriminatedUnion('kind',[z.object({kind:z.literal('unsupported')}).strict(),z.object({kind:z.literal('available'),active:z.boolean()}).strict()]),
  quality:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('unavailable')}).strict(),
    z.object({kind:z.literal('fixed'),label:z.string().max(80).nullable()}).strict(),
    z.object({kind:z.literal('selectable'),automatic:z.boolean(),selection:z.union([QualitySelectionSchema,z.object({kind:z.literal('unknown')}).strict()]),
      options:z.array(z.object({id:QualityLevelIdSchema,label:z.string().max(80),height:z.number().positive().nullable(),bitrate:z.number().positive().nullable()}).strict()).min(1).max(64)}).strict(),
  ]),
}).strict();
export type QualitySelection=z.infer<typeof QualitySelectionSchema>;
export type PlayerPresentation=z.infer<typeof PlayerPresentationSchema>;
export type PlayerCommand={kind:'set-quality';selection:QualitySelection}|{kind:'set-picture-in-picture';active:boolean};
export type PlayerControlResult={kind:'applied'}|{kind:'unavailable';reason:'no-selected-video'|'unsupported'|'stale-quality'};
export type PlayerUiResult={kind:'applied'}|{kind:'unavailable'};
export const PlayerShortcutSchema=z.enum(['toggle-playing','toggle-audible','toggle-room-fullscreen','toggle-theater',
  'focus-player-1','focus-player-2','focus-player-3','focus-player-4','escape']);
export type PlayerShortcut=z.infer<typeof PlayerShortcutSchema>;
export const PlayerUiActionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('set-playing'),playing:z.boolean()}).strict(),
  z.object({kind:z.literal('set-audible'),audible:z.boolean()}).strict(),
  z.object({kind:z.literal('set-volume'),volume:z.number().min(0).max(100)}).strict(),
  z.object({kind:z.literal('set-quality'),selection:QualitySelectionSchema}).strict(),
  z.object({kind:z.literal('set-picture-in-picture'),active:z.boolean()}).strict(),
  z.object({kind:z.literal('set-fullscreen'),fullscreen:z.boolean()}).strict(),
  z.object({kind:z.literal('focus-player')}).strict(),
  z.object({kind:z.literal('shortcut'),shortcut:PlayerShortcutSchema}).strict(),
]);
export type PlayerUiAction=z.infer<typeof PlayerUiActionSchema>;
export const PlayerControlsSnapshotSchema=z.object({
  binding:z.string().min(1).max(128),label:z.string().min(1).max(160),playing:z.boolean(),audible:z.boolean(),
  volume:z.number().min(0).max(100),fullscreen:z.boolean(),presentation:PlayerPresentationSchema.nullable(),
}).strict();
export type PlayerControlsSnapshot=z.infer<typeof PlayerControlsSnapshotSchema>;
type PlayerBridge={mount:(value:{capability:string})=>Promise<{kind:'ready'|'capacity'}>;update:(value:PlayerLayout)=>Promise<void>;
  control:(value:{capability:string;command:PlayerCommand})=>Promise<PlayerControlResult>;
  release:(value:{capability:string})=>Promise<void>;subscribe:(listener:(value:unknown)=>void)=>()=>void};
export const PlayerStateSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('presentation'),capability:z.string().uuid(),presentation:PlayerPresentationSchema}).strict(),
  z.object({kind:z.literal('decoded'),capability:z.string().uuid(),proof:AdvancingVideoSchema}).strict(),
  z.object({kind:z.literal('failed'),capability:z.string().uuid(),reason:z.enum(['upstream','playback'])}).strict(),
  z.object({kind:z.literal('ended'),capability:z.string().uuid()}).strict(),
  z.object({kind:z.literal('action'),capability:z.string().uuid(),action:PlayerUiActionSchema}).strict(),
]);
type PlayerControlsBridge={
  ready:()=>Promise<unknown>;
  subscribe:(listener:(value:unknown)=>void)=>()=>void;
  dispatch:(value:{binding:string;action:PlayerUiAction})=>Promise<PlayerUiResult>;
};
declare global{interface Window{sundayPlayer?:PlayerBridge;sundayPlayerControls?:PlayerControlsBridge}}
