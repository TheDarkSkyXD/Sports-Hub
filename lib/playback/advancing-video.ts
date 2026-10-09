export type AdvancingVideo = {
  kind:'advancing-video';
  version:1;
  startupMs:number;
  observedMs:number;
  mediaAdvanceMs:number;
  presentedFrames:number;
};

export type VideoSample = {
  wallMs:number;
  mediaMs:number;
  currentMs:number;
  frames:number;
  width:number;
  height:number;
  playing:boolean;
};

const MIN_ADVANCE_MS=2000;
const MIN_OBSERVED_MS=2000;
const MAX_SAMPLE_GAP_MS=6000;

export function createAdvancingVideoSampler(sourceStartedAt?:number) {
  let startedAt=sourceStartedAt;
  let startupMs:number|undefined;
  let first:VideoSample|undefined;
  let previous:VideoSample|undefined;
  const reset=()=>{first=undefined;previous=undefined;};
  return {
    reset,
    sample(value:VideoSample):AdvancingVideo|null {
      if(startedAt===undefined)startedAt=value.wallMs;
      if(!value.playing||value.width<=0||value.height<=0||!Number.isFinite(value.mediaMs)||
        !Number.isFinite(value.currentMs)||!Number.isFinite(value.wallMs)||value.frames<1){reset();return null;}
      if(previous){
        const elapsed=value.wallMs-previous.wallMs;
        const media=value.mediaMs-previous.mediaMs;
        const current=value.currentMs-previous.currentMs;
        if(elapsed<=0||elapsed>MAX_SAMPLE_GAP_MS||media<0||current<0||
          media>elapsed*1.5+500||current>elapsed*1.5+500||value.frames<=previous.frames){
          reset();
        }
      }
      first??=value;
      previous=value;
      const observed=value.wallMs-first.wallMs;
      const media=value.mediaMs-first.mediaMs;
      const current=value.currentMs-first.currentMs;
      const frames=value.frames-first.frames+1;
      if(observed<MIN_OBSERVED_MS||media<MIN_ADVANCE_MS||current<MIN_ADVANCE_MS||frames<3)return null;
      startupMs??=Math.round(value.wallMs-startedAt);
      const proof:AdvancingVideo={kind:'advancing-video',version:1,startupMs,
        observedMs:Math.round(observed),mediaAdvanceMs:Math.round(media),presentedFrames:frames};
      reset();
      return proof;
    },
  };
}
